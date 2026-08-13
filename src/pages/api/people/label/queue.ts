import {
  CLUSTER_WINDOW_SIZE,
  DEFAULT_BATCH_SIZE,
  DEFAULT_GROUP_THRESHOLD,
  DEFAULT_MIN_FACE_COUNT,
  DEFAULT_SIMILARITY_THRESHOLD,
  GROUP_MAX_SIZE,
  GROUP_MIN_PAIRWISE_SIMILARITY,
  KNN_OVERFETCH,
  SAMPLE_ASSETS_PER_GROUP,
  SAMPLE_FACES_PER_CLUSTER,
  SAME_ASSET_HARD_DROP,
  SAME_ASSET_PENALTY,
  SIGNAL_WEIGHTS,
} from "@/config/constants/faceLabel.constant";
import { db } from "@/config/db";
import { appDb } from "@/db";
import { faceLabelSkips, faceLabelTokenTotals, faceLabelTokens } from "@/db/schema";
import { getCurrentUser } from "@/handlers/serverUtils/user.utils";
import {
  blockedPairKey,
  filenameTokens,
  folderTokens,
  groupClusters,
  parseEmbedding,
  tokenAssociationScore,
} from "@/helpers/faceLabel.helper";
import { assetFaces, assets, person } from "@/schema";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";

/** Faces pulled per cluster: the first few are shown, all of them feed tokens. */
const FACES_PER_CLUSTER_FOR_TOKENS = 20;

/** Albums larger than this are ignored for the social signal — too generic, too slow. */
const MAX_ALBUM_SIZE_FOR_SOCIAL = 2000;

/**
 * Bind a list of uuids as a SINGLE query parameter.
 *
 * Drizzle's `sql` template expands a JS array into a parameter tuple
 * — `($1, $2, ... $n)` — which Postgres cannot cast to `uuid[]`, so the
 * natural-looking `= ANY(${uuidArray(ids)})` fails at runtime with
 * "Failed query". Joining to one string and letting Postgres split it keeps
 * this to a single bound parameter whatever the length.
 *
 * Callers must pass a non-empty list: `string_to_array('', ',')` yields `{""}`,
 * which then fails the uuid cast.
 */
const uuidArray = (ids: string[]) => sql`string_to_array(${ids.join(",")}, ',')::uuid[]`;

type QueueScope = "both" | "clusters" | "unassigned";

interface FaceRow {
  face_id: string;
  person_id: string | null;
  asset_id: string;
  image_width: number;
  image_height: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  original_file_name: string;
  original_path: string;
}

/**
 * A reviewable unit of work.
 *
 * Two kinds, because Immich leaves unlabelled faces in two different states:
 * clusters it grouped but nobody named, and faces it never grouped at all
 * (its facial recognition only forms a person at `minFaces`, 3 by default —
 * everything below that stays unassigned and is invisible to Immich's own
 * people UI).
 */
interface Unit {
  id: string;
  kind: "cluster" | "faces";
  clusterIds: string[];
  faceIds: string[];
  faces: FaceRow[];
  faceCount: number;
}

const toNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const currentUser = await getCurrentUser(req);
    if (!currentUser) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const ownerId = currentUser.id;
    const batchSize = Math.min(100, toNumber(req.query.batchSize, DEFAULT_BATCH_SIZE));
    const minFaceCount = toNumber(req.query.minFaceCount, DEFAULT_MIN_FACE_COUNT);
    const similarityThreshold = toNumber(
      req.query.similarityThreshold,
      DEFAULT_SIMILARITY_THRESHOLD
    );
    const groupThreshold = toNumber(req.query.groupThreshold, DEFAULT_GROUP_THRESHOLD);
    const page = Math.max(1, toNumber(req.query.page, 1));
    const scope = ((req.query.scope as string) || "both") as QueueScope;

    // ---------------------------------------------------------------- skips
    const skipRows = await appDb
      .select({ kind: faceLabelSkips.kind, targetId: faceLabelSkips.targetId })
      .from(faceLabelSkips)
      .where(eq(faceLabelSkips.ownerId, ownerId));
    const skipClusterIds = skipRows.filter((r) => r.kind === "cluster").map((r) => r.targetId);
    const skipFaceIds = skipRows.filter((r) => r.kind === "face").map((r) => r.targetId);

    const units: Unit[] = [];
    let clusterWindow = 0;
    let unassignedWindow = 0;

    // =================================================== A. unnamed clusters
    if (scope !== "unassigned") {
      const clusters = await db
        .select({
          id: person.id,
          faceCount: count(assetFaces.id),
        })
        .from(person)
        .innerJoin(
          assetFaces,
          and(
            eq(assetFaces.personId, person.id),
            isNull(assetFaces.deletedAt),
            eq(assetFaces.isVisible, true)
          )
        )
        .innerJoin(
          assets,
          and(
            eq(assets.id, assetFaces.assetId),
            isNull(assets.deletedAt),
            eq(assets.status, "active")
          )
        )
        .where(
          and(
            eq(person.ownerId, ownerId),
            eq(person.name, ""),
            eq(person.isHidden, false),
            skipClusterIds.length ? notInArray(person.id, skipClusterIds) : undefined
          )
        )
        .groupBy(person.id)
        .having(gte(count(assetFaces.id), minFaceCount))
        .orderBy(desc(count(assetFaces.id)), person.id)
        .limit(CLUSTER_WINDOW_SIZE)
        .offset((page - 1) * CLUSTER_WINDOW_SIZE);

      clusterWindow = clusters.length;

      if (clusters.length > 0) {
        const clusterIds = clusters.map((c) => c.id);
        const faceCountById = new Map(clusters.map((c) => [c.id, Number(c.faceCount)]));

        const { rows: repRows } = await db.execute(sql`
          SELECT DISTINCT ON (af."personId")
                 af."personId" AS person_id,
                 fs.embedding AS embedding
          FROM asset_face af
          JOIN face_search fs ON fs."faceId" = af.id
          JOIN person p ON p.id = af."personId"
          WHERE af."personId" = ANY(${uuidArray(clusterIds)})
            AND af."deletedAt" IS NULL
            AND af."isVisible" IS TRUE
          ORDER BY af."personId", (af.id = p."faceAssetId") DESC, af.id
        `);

        const representatives = new Map<string, number[]>();
        for (const row of repRows as any[]) {
          const embedding = parseEmbedding(row.embedding);
          if (embedding) representatives.set(row.person_id, embedding);
        }

        // Clusters sharing a photo are different people, whatever the vectors say.
        const blocked = new Set<string>();
        const { rows: blockedRows } = await db.execute(sql`
          SELECT DISTINCT af1."personId" AS a, af2."personId" AS b
          FROM asset_face af1
          JOIN asset_face af2
            ON af2."assetId" = af1."assetId"
           AND af2.id <> af1.id
           AND af2."deletedAt" IS NULL
           AND af2."isVisible" IS TRUE
          WHERE af1."personId" = ANY(${uuidArray(clusterIds)})
            AND af2."personId" = ANY(${uuidArray(clusterIds)})
            AND af1."personId" < af2."personId"
            AND af1."deletedAt" IS NULL
            AND af1."isVisible" IS TRUE
        `);
        for (const row of blockedRows as any[]) {
          blocked.add(blockedPairKey(row.a, row.b));
        }

        const grouped = groupClusters(clusterIds, representatives, {
          threshold: groupThreshold,
          minPairwise: GROUP_MIN_PAIRWISE_SIMILARITY,
          maxSize: GROUP_MAX_SIZE,
          blocked,
        });

        grouped.sort(
          (a, b) =>
            b.reduce((s, id) => s + (faceCountById.get(id) ?? 0), 0) -
            a.reduce((s, id) => s + (faceCountById.get(id) ?? 0), 0)
        );

        for (const group of grouped) {
          units.push({
            id: `c:${group.slice().sort().join("+")}`,
            kind: "cluster",
            clusterIds: group,
            faceIds: [],
            faces: [],
            faceCount: group.reduce((s, id) => s + (faceCountById.get(id) ?? 0), 0),
          });
        }
      }
    }

    // ================================================ B. unassigned faces
    // These never became a person, so there is nothing for Immich's people UI
    // to show and nothing to rename — each one has to be attached to a person.
    if (scope !== "clusters" && units.length < batchSize) {
      const { rows: faceRows } = await db.execute(sql`
        SELECT af.id AS face_id,
               NULL::uuid AS person_id,
               af."assetId" AS asset_id,
               af."imageWidth" AS image_width,
               af."imageHeight" AS image_height,
               af."boundingBoxX1" AS x1,
               af."boundingBoxY1" AS y1,
               af."boundingBoxX2" AS x2,
               af."boundingBoxY2" AS y2,
               a."originalFileName" AS original_file_name,
               a."originalPath" AS original_path,
               fs.embedding AS embedding
        FROM asset_face af
        JOIN asset a
          ON a.id = af."assetId"
         AND a."deletedAt" IS NULL
         AND a.status = 'active'
         AND a."ownerId" = ${ownerId}
        JOIN face_search fs ON fs."faceId" = af.id
        WHERE af."personId" IS NULL
          AND af."deletedAt" IS NULL
          AND af."isVisible" IS TRUE
          ${
            skipFaceIds.length
              ? sql`AND NOT (af.id = ANY(${uuidArray(skipFaceIds)}))`
              : sql``
          }
        -- Biggest faces first: more pixels means a better embedding and a
        -- crop the user can actually recognise.
        ORDER BY ((af."boundingBoxX2" - af."boundingBoxX1")
                * (af."boundingBoxY2" - af."boundingBoxY1")) DESC, af.id
        LIMIT ${CLUSTER_WINDOW_SIZE}
        OFFSET ${(page - 1) * CLUSTER_WINDOW_SIZE}
      `);

      unassignedWindow = faceRows.length;

      if (faceRows.length > 0) {
        const rows = faceRows as any[];
        const faceById = new Map<string, FaceRow>();
        const embeddings = new Map<string, number[]>();
        const assetByFace = new Map<string, string>();

        for (const row of rows) {
          faceById.set(row.face_id, row as FaceRow);
          assetByFace.set(row.face_id, row.asset_id);
          const embedding = parseEmbedding(row.embedding);
          if (embedding) embeddings.set(row.face_id, embedding);
        }

        // Two faces in the same photo are two different people. No query
        // needed — the asset id is already on the row.
        const blocked = new Set<string>();
        const byAsset = new Map<string, string[]>();
        for (const [faceId, assetId] of Array.from(assetByFace.entries())) {
          const list = byAsset.get(assetId) ?? [];
          list.push(faceId);
          byAsset.set(assetId, list);
        }
        for (const faceIds of Array.from(byAsset.values())) {
          for (let i = 0; i < faceIds.length; i++) {
            for (let j = i + 1; j < faceIds.length; j++) {
              blocked.add(blockedPairKey(faceIds[i], faceIds[j]));
            }
          }
        }

        const faceIdsOrdered = rows.map((r) => r.face_id as string);
        const grouped = groupClusters(faceIdsOrdered, embeddings, {
          threshold: groupThreshold,
          minPairwise: GROUP_MIN_PAIRWISE_SIMILARITY,
          maxSize: GROUP_MAX_SIZE,
          blocked,
        });

        grouped.sort((a, b) => b.length - a.length);

        for (const group of grouped) {
          units.push({
            id: `f:${group.slice().sort().join("+")}`,
            kind: "faces",
            clusterIds: [],
            faceIds: group,
            faces: group.map((id) => faceById.get(id)!).filter(Boolean),
            faceCount: group.length,
          });
        }
      }
    }

    if (units.length === 0) {
      return res.status(200).json({
        groups: [],
        hasMore: false,
        windowSize: 0,
        counts: { clusters: clusterWindow, unassigned: unassignedWindow },
      });
    }

    const visible = units.slice(0, batchSize);

    // ------------------------------- sample faces for the cluster units
    const visibleClusterIds = visible.flatMap((u) => u.clusterIds);
    if (visibleClusterIds.length > 0) {
      const { rows } = await db.execute(sql`
        SELECT face_id, person_id, asset_id, image_width, image_height,
               x1, y1, x2, y2, original_file_name, original_path
        FROM (
          SELECT af.id AS face_id,
                 af."personId" AS person_id,
                 af."assetId" AS asset_id,
                 af."imageWidth" AS image_width,
                 af."imageHeight" AS image_height,
                 af."boundingBoxX1" AS x1,
                 af."boundingBoxY1" AS y1,
                 af."boundingBoxX2" AS x2,
                 af."boundingBoxY2" AS y2,
                 a."originalFileName" AS original_file_name,
                 a."originalPath" AS original_path,
                 row_number() OVER (PARTITION BY af."personId" ORDER BY af.id) AS rn
          FROM asset_face af
          JOIN asset a
            ON a.id = af."assetId"
           AND a."deletedAt" IS NULL
           AND a.status = 'active'
          WHERE af."personId" = ANY(${uuidArray(visibleClusterIds)})
            AND af."deletedAt" IS NULL
            AND af."isVisible" IS TRUE
        ) ranked
        WHERE rn <= ${FACES_PER_CLUSTER_FOR_TOKENS}
      `);

      const byCluster = new Map<string, FaceRow[]>();
      for (const row of rows as unknown as FaceRow[]) {
        const list = byCluster.get(row.person_id as string) ?? [];
        list.push(row);
        byCluster.set(row.person_id as string, list);
      }
      for (const unit of visible) {
        if (unit.kind !== "cluster") continue;
        // Round-robin so every cluster in a group is represented.
        const perCluster = unit.clusterIds.map((id) => byCluster.get(id) ?? []);
        const interleaved: FaceRow[] = [];
        for (let depth = 0; ; depth++) {
          const before = interleaved.length;
          for (const faces of perCluster) {
            if (faces[depth]) interleaved.push(faces[depth]);
          }
          if (interleaved.length === before) break;
        }
        unit.faces = interleaved;
      }
    }

    // ------------------------------------------------ signal inputs
    const probeFaceIds = visible.flatMap((u) =>
      u.faces.slice(0, SAMPLE_FACES_PER_CLUSTER).map((f) => f.face_id)
    );
    const unitByProbe = new Map<string, string>();
    for (const unit of visible) {
      for (const face of unit.faces.slice(0, SAMPLE_FACES_PER_CLUSTER)) {
        unitByProbe.set(face.face_id, unit.id);
      }
    }
    const allAssetIds = Array.from(
      new Set(visible.flatMap((u) => u.faces.map((f) => f.asset_id)))
    );

    // --------------------------------------------- 1. face similarity
    const faceScores = new Map<string, Map<string, { name: string; similarity: number }>>();
    if (probeFaceIds.length > 0) {
      const { rows: knnRows } = await db.execute(sql`
        WITH probes AS (
          SELECT fs."faceId" AS probe_face_id, fs.embedding AS embedding
          FROM face_search fs
          WHERE fs."faceId" = ANY(${uuidArray(probeFaceIds)})
        )
        SELECT probes.probe_face_id,
               nn.person_id,
               nn.name,
               max(nn.similarity) AS similarity
        FROM probes
        CROSS JOIN LATERAL (
          SELECT p2.id AS person_id,
                 p2.name AS name,
                 1 - (fs2.embedding <=> probes.embedding) AS similarity
          FROM face_search fs2
          JOIN asset_face af2
            ON af2.id = fs2."faceId"
           AND af2."deletedAt" IS NULL
           AND af2."isVisible" IS TRUE
          JOIN person p2
            ON p2.id = af2."personId"
           AND p2."ownerId" = ${ownerId}
           AND p2.name <> ''
           AND p2."isHidden" IS FALSE
          ORDER BY fs2.embedding <=> probes.embedding
          LIMIT ${KNN_OVERFETCH}
        ) nn
        WHERE nn.similarity >= ${similarityThreshold}
        GROUP BY probes.probe_face_id, nn.person_id, nn.name
      `);

      for (const row of knnRows as any[]) {
        const unitId = unitByProbe.get(row.probe_face_id);
        if (!unitId) continue;
        const perUnit = faceScores.get(unitId) ?? new Map();
        const similarity = Number(row.similarity);
        const existing = perUnit.get(row.person_id);
        if (!existing || existing.similarity < similarity) {
          perUnit.set(row.person_id, { name: row.name, similarity });
        }
        faceScores.set(unitId, perUnit);
      }
    }

    // --------------------------------- 2. who is already in these photos
    const sameAssetPeople = new Map<string, Set<string>>();
    const nameById = new Map<string, string>();
    if (allAssetIds.length > 0) {
      const { rows } = await db.execute(sql`
        SELECT af."assetId" AS asset_id, p2.id AS person_id, p2.name AS name
        FROM asset_face af
        JOIN person p2
          ON p2.id = af."personId"
         AND p2."ownerId" = ${ownerId}
         AND p2.name <> ''
        WHERE af."assetId" = ANY(${uuidArray(allAssetIds)})
          AND af."deletedAt" IS NULL
          AND af."isVisible" IS TRUE
        GROUP BY af."assetId", p2.id, p2.name
      `);
      for (const row of rows as any[]) {
        const set = sameAssetPeople.get(row.asset_id) ?? new Set<string>();
        set.add(row.person_id);
        sameAssetPeople.set(row.asset_id, set);
        nameById.set(row.person_id, row.name);
      }
    }

    // ----------------------------------------------- 3. social circle
    const socialShared = new Map<string, Map<string, number>>();
    if (allAssetIds.length > 0) {
      const { rows } = await db.execute(sql`
        WITH albums_of_interest AS (
          SELECT DISTINCT aa."albumId" AS album_id
          FROM album_asset aa
          WHERE aa."assetId" = ANY(${uuidArray(allAssetIds)})
        ),
        album_sizes AS (
          SELECT aa."albumId" AS album_id, count(*)::int AS n
          FROM album_asset aa
          WHERE aa."albumId" IN (SELECT album_id FROM albums_of_interest)
          GROUP BY aa."albumId"
        ),
        source AS (
          SELECT DISTINCT aa."assetId" AS asset_id, aa."albumId" AS album_id
          FROM album_asset aa
          WHERE aa."assetId" = ANY(${uuidArray(allAssetIds)})
        )
        SELECT s.asset_id, p2.id AS person_id, p2.name AS name,
               count(DISTINCT af2."assetId")::int AS shared
        FROM source s
        JOIN album_sizes sz ON sz.album_id = s.album_id AND sz.n <= ${MAX_ALBUM_SIZE_FOR_SOCIAL}
        JOIN album_asset aa2 ON aa2."albumId" = s.album_id
        JOIN asset_face af2
          ON af2."assetId" = aa2."assetId"
         AND af2."deletedAt" IS NULL
         AND af2."isVisible" IS TRUE
        JOIN person p2
          ON p2.id = af2."personId"
         AND p2."ownerId" = ${ownerId}
         AND p2.name <> ''
        GROUP BY s.asset_id, p2.id, p2.name
      `);
      for (const row of rows as any[]) {
        const perAsset = socialShared.get(row.asset_id) ?? new Map<string, number>();
        perAsset.set(row.person_id, Number(row.shared));
        socialShared.set(row.asset_id, perAsset);
        nameById.set(row.person_id, row.name);
      }
    }

    // ------------------------------------- 4. filename / folder tokens
    const allTokens = new Set<string>();
    const tokensByUnit = new Map<string, Map<string, Set<string>>>();
    for (const unit of visible) {
      const perSource = new Map<string, Set<string>>([
        ["filename", new Set<string>()],
        ["folder", new Set<string>()],
      ]);
      for (const face of unit.faces) {
        for (const token of filenameTokens(face.original_file_name)) {
          perSource.get("filename")!.add(token);
          allTokens.add(token);
        }
        for (const token of folderTokens(face.original_path)) {
          perSource.get("folder")!.add(token);
          allTokens.add(token);
        }
      }
      tokensByUnit.set(unit.id, perSource);
    }

    const tokenList = Array.from(allTokens);
    const tokenStats = new Map<string, { personId: string; assetCount: number }[]>();
    const tokenTotals = new Map<string, number>();
    if (tokenList.length > 0) {
      const learned = await appDb
        .select()
        .from(faceLabelTokens)
        .where(
          and(eq(faceLabelTokens.ownerId, ownerId), inArray(faceLabelTokens.token, tokenList))
        );
      for (const row of learned) {
        const key = `${row.source}:${row.token}`;
        const list = tokenStats.get(key) ?? [];
        list.push({ personId: row.personId, assetCount: row.assetCount });
        tokenStats.set(key, list);
      }
      const totals = await appDb
        .select()
        .from(faceLabelTokenTotals)
        .where(
          and(
            eq(faceLabelTokenTotals.ownerId, ownerId),
            inArray(faceLabelTokenTotals.token, tokenList)
          )
        );
      for (const row of totals) {
        tokenTotals.set(`${row.source}:${row.token}`, row.totalAssets);
      }
    }

    // Names for people that only the token index knows about.
    const tokenPersonIds = Array.from(
      new Set(
        Array.from(tokenStats.values()).flatMap((list) => list.map((s) => s.personId))
      )
    ).filter((id) => !nameById.has(id));
    if (tokenPersonIds.length > 0) {
      const rows = await db
        .select({ id: person.id, name: person.name })
        .from(person)
        .where(and(eq(person.ownerId, ownerId), inArray(person.id, tokenPersonIds)));
      for (const row of rows) nameById.set(row.id, row.name);
    }
    for (const perUnit of Array.from(faceScores.values())) {
      for (const [personId, value] of Array.from(perUnit.entries())) {
        nameById.set(personId, value.name);
      }
    }

    // -------------------------------------------- 5. combine per unit
    const groups = visible.map((unit) => {
      const candidates = new Map<
        string,
        {
          personId: string;
          faceScore: number;
          filenameScore: number;
          socialScore: number;
          sharedAssets: number;
          evidence: string[];
        }
      >();

      const ensure = (personId: string) => {
        let candidate = candidates.get(personId);
        if (!candidate) {
          candidate = {
            personId,
            faceScore: 0,
            filenameScore: 0,
            socialScore: 0,
            sharedAssets: 0,
            evidence: [],
          };
          candidates.set(personId, candidate);
        }
        return candidate;
      };

      for (const [personId, value] of Array.from(
        (faceScores.get(unit.id) ?? new Map()).entries()
      )) {
        const candidate = ensure(personId);
        candidate.faceScore = value.similarity;
        candidate.evidence.push(`Face match ${(value.similarity * 100).toFixed(0)}%`);
      }

      const perSource = tokensByUnit.get(unit.id);
      if (perSource) {
        for (const source of ["filename", "folder"] as const) {
          for (const token of Array.from(perSource.get(source) ?? [])) {
            const key = `${source}:${token}`;
            const stats = tokenStats.get(key);
            const total = tokenTotals.get(key);
            if (!stats || !total) continue;
            for (const stat of stats) {
              const score = tokenAssociationScore(stat.assetCount, total);
              if (score <= 0) continue;
              const candidate = ensure(stat.personId);
              if (score > candidate.filenameScore) {
                candidate.filenameScore = score;
                candidate.evidence = candidate.evidence.filter(
                  (e) => !e.startsWith("Filename") && !e.startsWith("Folder")
                );
                candidate.evidence.push(
                  `${source === "filename" ? "Filename" : "Folder"} "${token}": ${stat.assetCount} of ${total} labelled matches`
                );
              }
            }
          }
        }
      }

      for (const face of unit.faces) {
        for (const personId of Array.from(
          sameAssetPeople.get(face.asset_id) ?? new Set<string>()
        )) {
          ensure(personId).sharedAssets += 1;
        }
        for (const [personId, shared] of Array.from(
          (socialShared.get(face.asset_id) ?? new Map<string, number>()).entries()
        )) {
          const candidate = ensure(personId);
          candidate.socialScore = Math.max(
            candidate.socialScore,
            Math.min(1, shared / Math.max(1, unit.faceCount))
          );
        }
      }

      const suggestions = Array.from(candidates.values())
        .filter((candidate) => candidate.sharedAssets < SAME_ASSET_HARD_DROP)
        .map((candidate) => {
          const confidence =
            SIGNAL_WEIGHTS.face * candidate.faceScore +
            SIGNAL_WEIGHTS.filename * candidate.filenameScore +
            SIGNAL_WEIGHTS.social * candidate.socialScore -
            (candidate.sharedAssets > 0 ? SAME_ASSET_PENALTY : 0);

          const evidence = [...candidate.evidence];
          if (candidate.socialScore > 0) evidence.push("Appears in the same albums");
          if (candidate.sharedAssets > 0) {
            evidence.push("Already in the same photo — probably not this person");
          }

          return {
            personId: candidate.personId,
            name: nameById.get(candidate.personId) ?? "",
            confidence: Math.max(0, Math.min(1, confidence)),
            signals: {
              face: candidate.faceScore,
              filename: candidate.filenameScore,
              social: candidate.socialScore,
              sharedAssets: candidate.sharedAssets,
            },
            evidence,
          };
        })
        .filter((s) => s.name !== "" && s.confidence > 0)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 6);

      return {
        id: unit.id,
        kind: unit.kind,
        clusterIds: unit.clusterIds,
        faceIds: unit.faceIds,
        faceCount: unit.faceCount,
        sampleFaces: unit.faces.slice(0, SAMPLE_ASSETS_PER_GROUP).map((face) => ({
          faceId: face.face_id,
          assetId: face.asset_id,
          imageWidth: Number(face.image_width),
          imageHeight: Number(face.image_height),
          boundingBox: {
            x1: Number(face.x1),
            y1: Number(face.y1),
            x2: Number(face.x2),
            y2: Number(face.y2),
          },
        })),
        suggestions,
      };
    });

    return res.status(200).json({
      groups,
      windowSize: clusterWindow + unassignedWindow,
      hasMore:
        units.length > batchSize ||
        clusterWindow === CLUSTER_WINDOW_SIZE ||
        unassignedWindow === CLUSTER_WINDOW_SIZE,
      counts: { clusters: clusterWindow, unassigned: unassignedWindow },
    });
  } catch (error: any) {
    return res
      .status(500)
      .json({ error: error?.message ?? "Failed to build labelling queue" });
  }
}
