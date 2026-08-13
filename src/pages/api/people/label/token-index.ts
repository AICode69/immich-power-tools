import { db } from "@/config/db";
import {
  TOKEN_INDEX_MAX_AGE_MS,
  TOKEN_MAX_LIBRARY_SHARE,
  TOKEN_MIN_PRECISION,
  TOKEN_MIN_SUPPORT,
} from "@/config/constants/faceLabel.constant";
import { appDb } from "@/db";
import {
  faceLabelIndexMeta,
  faceLabelTokenTotals,
  faceLabelTokens,
} from "@/db/schema";
import { getCurrentUser } from "@/handlers/serverUtils/user.utils";
import { isUsefulToken, passesLiftGate } from "@/helpers/faceLabel.helper";
import { eq, sql } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";

const INSERT_CHUNK_SIZE = 150;

interface TokenRow {
  source: string;
  token: string;
  person_id: string;
  asset_count: string | number;
  total_assets: string | number;
  labeled_assets: string | number;
  person_assets: string | number;
  library_labeled: string | number;
}

/**
 * Learns which filename and folder tokens predict which person, using only
 * assets the user has already labelled.
 *
 * Splitting happens in Postgres with the same expression the queue uses in JS
 * (`[^A-Za-z0-9]+`, lowercased); the stop-word and shape filters are applied
 * in JS on both sides so the two stay consistent.
 */
const buildTokenIndex = async (ownerId: string) => {
  // Everything runs in one transaction so the two SET LOCALs actually apply:
  // outside a transaction they are silently ignored, and a pooled connection
  // would not carry them to the next statement anyway.
  const { libraryTotal, rows } = await db.transaction(async (tx) => {
    // Tokenising the whole library spills to disk at the default work_mem, and
    // the statement is bounded rather than left to run forever.
    await tx.execute(sql`SET LOCAL work_mem = '128MB'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '180s'`);

    const libraryTotalResult = await tx.execute(sql`
      SELECT count(*)::int AS total
      FROM asset a
      WHERE a."ownerId" = ${ownerId}
        AND a."deletedAt" IS NULL
        AND a.status = 'active'
    `);

    const result = await tx.execute(sql`
    WITH owned AS (
      SELECT a.id,
             a."originalFileName" AS file_name,
             -- External libraries on Windows hosts store backslash paths.
             replace(a."originalPath", '\\', '/') AS file_path
      FROM asset a
      WHERE a."ownerId" = ${ownerId}
        AND a."deletedAt" IS NULL
        AND a.status = 'active'
    ),
    tokens AS (
      SELECT o.id AS asset_id, 'filename' AS source, lower(tok) AS token
      FROM owned o
      CROSS JOIN LATERAL regexp_split_to_table(
        regexp_replace(o.file_name, '[.][^.]*$', ''),
        '[^A-Za-z0-9]+'
      ) AS tok
      UNION
      SELECT o.id AS asset_id, 'folder' AS source, lower(tok) AS token
      FROM owned o
      CROSS JOIN LATERAL regexp_split_to_table(
        regexp_replace(regexp_replace(o.file_path, '/[^/]*$', ''), '^.*/', ''),
        '[^A-Za-z0-9]+'
      ) AS tok
    ),
    named_faces AS (
      SELECT DISTINCT af."assetId" AS asset_id, af."personId" AS person_id
      FROM asset_face af
      JOIN person p ON p.id = af."personId"
      WHERE af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
        AND p."ownerId" = ${ownerId}
        AND p.name <> ''
    ),
    labeled_assets AS (
      SELECT DISTINCT asset_id FROM named_faces
    ),
    library_labeled AS (
      SELECT count(*)::int AS n FROM labeled_assets
    ),
    person_totals AS (
      SELECT person_id, count(DISTINCT asset_id)::int AS person_assets
      FROM named_faces
      GROUP BY person_id
    ),
    token_totals AS (
      SELECT t.source,
             t.token,
             count(*)::int AS total_assets,
             count(la.asset_id)::int AS labeled_assets
      FROM tokens t
      LEFT JOIN labeled_assets la ON la.asset_id = t.asset_id
      GROUP BY t.source, t.token
    ),
    token_people AS (
      SELECT t.source,
             t.token,
             nf.person_id,
             count(DISTINCT t.asset_id)::int AS asset_count
      FROM tokens t
      JOIN named_faces nf ON nf.asset_id = t.asset_id
      GROUP BY t.source, t.token, nf.person_id
    )
    SELECT tp.source,
           tp.token,
           tp.person_id,
           tp.asset_count,
           tt.total_assets,
           tt.labeled_assets,
           pt.person_assets,
           ll.n AS library_labeled
    FROM token_people tp
    JOIN token_totals tt
      ON tt.source = tp.source AND tt.token = tp.token
    JOIN person_totals pt ON pt.person_id = tp.person_id
    CROSS JOIN library_labeled ll
    WHERE tp.asset_count >= ${TOKEN_MIN_SUPPORT}
  `);

    return {
      libraryTotal: Number((libraryTotalResult.rows[0] as any)?.total ?? 0),
      rows: result.rows,
    };
  });

  const tokenRows: (typeof faceLabelTokens.$inferInsert)[] = [];
  const totalsByKey = new Map<string, typeof faceLabelTokenTotals.$inferInsert>();
  const people = new Set<string>();

  for (const raw of rows as unknown as TokenRow[]) {
    const token = raw.token;
    if (!isUsefulToken(token)) continue;

    const totalAssets = Number(raw.total_assets);
    const labeledAssets = Number(raw.labeled_assets);
    const matching = Number(raw.asset_count);

    // A token carried by a large share of the library identifies nobody.
    const librarySharePct = libraryTotal > 0 ? totalAssets / libraryTotal : 0;
    if (librarySharePct > TOKEN_MAX_LIBRARY_SHARE) continue;

    if (labeledAssets <= 0) continue;
    if (matching / labeledAssets < TOKEN_MIN_PRECISION) continue;

    // Lift gate: does this token beat simply guessing the most-photographed
    // person? Applied here, where base rates are known, so query time does not
    // need them.
    const libraryLabeled = Number(raw.library_labeled);
    const personAssets = Number(raw.person_assets);
    const personBaseRate = libraryLabeled > 0 ? personAssets / libraryLabeled : 0;
    if (!passesLiftGate(matching, labeledAssets, personBaseRate)) continue;

    tokenRows.push({
      ownerId,
      source: raw.source,
      token,
      personId: raw.person_id,
      assetCount: matching,
    });
    people.add(raw.person_id);

    const key = `${raw.source}:${token}`;
    if (!totalsByKey.has(key)) {
      totalsByKey.set(key, {
        ownerId,
        source: raw.source,
        token,
        totalAssets: labeledAssets,
        librarySharePct,
      });
    }
  }

  // Replace the whole index for this owner — it is derived data, cheap to rebuild.
  await appDb.delete(faceLabelTokens).where(eq(faceLabelTokens.ownerId, ownerId));
  await appDb
    .delete(faceLabelTokenTotals)
    .where(eq(faceLabelTokenTotals.ownerId, ownerId));

  for (let i = 0; i < tokenRows.length; i += INSERT_CHUNK_SIZE) {
    await appDb.insert(faceLabelTokens).values(tokenRows.slice(i, i + INSERT_CHUNK_SIZE));
  }
  const totals = Array.from(totalsByKey.values());
  for (let i = 0; i < totals.length; i += INSERT_CHUNK_SIZE) {
    await appDb
      .insert(faceLabelTokenTotals)
      .values(totals.slice(i, i + INSERT_CHUNK_SIZE));
  }

  const meta = {
    ownerId,
    builtAt: new Date(),
    assetsScanned: libraryTotal,
    tokensLearned: totalsByKey.size,
    namedPeopleSeen: people.size,
  };

  await appDb.delete(faceLabelIndexMeta).where(eq(faceLabelIndexMeta.ownerId, ownerId));
  await appDb.insert(faceLabelIndexMeta).values(meta);

  return meta;
};

const readStatus = async (ownerId: string) => {
  const rows = await appDb
    .select()
    .from(faceLabelIndexMeta)
    .where(eq(faceLabelIndexMeta.ownerId, ownerId))
    .limit(1);

  const meta = rows[0];
  if (!meta) {
    return {
      builtAt: null,
      assetsScanned: 0,
      tokensLearned: 0,
      namedPeopleSeen: 0,
      isStale: true,
      hasIndex: false,
    };
  }

  const builtAt = meta.builtAt ? new Date(meta.builtAt) : null;
  return {
    builtAt,
    assetsScanned: meta.assetsScanned,
    tokensLearned: meta.tokensLearned,
    namedPeopleSeen: meta.namedPeopleSeen,
    isStale: !builtAt || Date.now() - builtAt.getTime() > TOKEN_INDEX_MAX_AGE_MS,
    hasIndex: true,
  };
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const currentUser = await getCurrentUser(req);
    if (!currentUser) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.method === "POST") {
      await buildTokenIndex(currentUser.id);
      return res.status(200).json(await readStatus(currentUser.id));
    }

    if (req.method === "GET") {
      return res.status(200).json(await readStatus(currentUser.id));
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error: any) {
    // Deliberately does not echo filenames or person names into the response.
    return res.status(500).json({ error: error?.message ?? "Failed to build token index" });
  }
}
