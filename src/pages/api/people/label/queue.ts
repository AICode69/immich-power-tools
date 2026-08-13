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

interface FaceRow {
  face_id: string;
  person_id: string;
  asset_id: string;
  image_width: number;
  image_height: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  original_file_name: string;
  original_path: string;
  rn: number;
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
    const batchSize = Math.min(
      100,
      toNumber(req.query.batchSize, DEFAULT_BATCH_SIZE)
    );
    const minFaceCount = toNumber(req.query.minFaceCount, DEFAULT_MIN_FACE_COUNT);
    const similarityThreshold = toNumber(
      req.query.similarityThreshold,
      DEFAULT_SIMILARITY_THRESHOLD
    );
    const groupThreshold = toNumber(req.query.groupThreshold, DEFAULT_GROUP_THRESHOLD);
    const page = Math.max(1, toNumber(req.query.page, 1));

    // ---------------------------------------------------------------- skips
    const skipRows = await appDb
      .select({ personId: faceLabelSkips.personId })
      .from(faceLabelSkips)
      .where(eq(faceLabelSkips.ownerId, ownerId));
    const skipIds = skipRows.map((row) => row.personId);

    // ------------------------------------------------- 1. unnamed clusters
    const clusters = await db
      .select({
        id: person.id,
        faceAssetId: person.faceAssetId,
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
          skipIds.length ? notInArray(person.id, skipIds) : undefined
        )
      )
      .groupBy(person.id)
      .having(gte(count(assetFaces.id), minFaceCount))
      .orderBy(desc(count(assetFaces.id)), person.id)
      .limit(CLUSTER_WINDOW_SIZE)
      .offset((page - 1) * CLUSTER_WINDOW_SIZE);

    if (clusters.length === 0) {
      return res.status(200).json({ groups: [], hasMore: false, windowSize: 0 });
    }

    const clusterIds = clusters.map((c) => c.id);
    const faceCountById = new Map(clusters.map((c) => [c.id, Number(c.faceCount)]));

    // ------------------------- 2. one representative embedding per cluster
    const { rows: repRows } = await db.execute(sql`
      SELECT DISTINCT ON (af."personId")
             af."personId" AS person_id,
             af.id AS face_id,
             fs.embedding AS embedding
      FROM asset_face af
      JOIN face_search fs ON fs."faceId" = af.id
      JOIN person p ON p.id = af."personId"
      WHERE af."personId" = ANY(${clusterIds}::uuid[])
        AND af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
      ORDER BY af."personId", (af.id = p."faceAssetId") DESC, af.id
    `);

    const representatives = new Map<string, number[]>();
    for (const row of repRows as any[]) {
      const embedding = parseEmbedding(row.embedding);
      if (embedding) representatives.set(row.person_id, embedding);
    }

    // ------------------------ 3. pairs that cannot possibly be one person
    // Two clusters with faces in the same photo are two different people, no
    // matter how alike the embeddings look. Without this, grouping happily
    // fuses siblings who are always photographed together.
    const blockedPairs = new Set<string>();
    const { rows: blockedRows } = await db.execute(sql`
      SELECT DISTINCT af1."personId" AS a, af2."personId" AS b
      FROM asset_face af1
      JOIN asset_face af2
        ON af2."assetId" = af1."assetId"
       AND af2.id <> af1.id
       AND af2."deletedAt" IS NULL
       AND af2."isVisible" IS TRUE
      WHERE af1."personId" = ANY(${clusterIds}::uuid[])
        AND af2."personId" = ANY(${clusterIds}::uuid[])
        AND af1."personId" < af2."personId"
        AND af1."deletedAt" IS NULL
        AND af1."isVisible" IS TRUE
    `);
    for (const row of blockedRows as any[]) {
      blockedPairs.add(blockedPairKey(row.a, row.b));
    }

    // ----------------------------------- 4. group clusters that look alike
    // Pairwise in JS: O(n^2 * 512) over a bounded window is a few milliseconds,
    // far cheaper than one KNN round trip per cluster.
    const grouped = groupClusters(clusterIds, representatives, {
      threshold: groupThreshold,
      minPairwise: GROUP_MIN_PAIRWISE_SIMILARITY,
      maxSize: GROUP_MAX_SIZE,
      blocked: blockedPairs,
    });

    grouped.sort((a, b) => {
      const sizeA = a.reduce((sum, id) => sum + (faceCountById.get(id) ?? 0), 0);
      const sizeB = b.reduce((sum, id) => sum + (faceCountById.get(id) ?? 0), 0);
      return sizeB - sizeA;
    });

    const visibleGroups = grouped.slice(0, batchSize);
    const visibleClusterIds = visibleGroups.flat();

    // -------------------------------------- 5. sample faces for the groups
    const { rows: faceRows } = await db.execute(sql`
      SELECT face_id, person_id, asset_id, image_width, image_height,
             x1, y1, x2, y2, original_file_name, original_path, rn
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
        WHERE af."personId" = ANY(${visibleClusterIds}::uuid[])
          AND af."deletedAt" IS NULL
          AND af."isVisible" IS TRUE
      ) ranked
      WHERE rn <= ${FACES_PER_CLUSTER_FOR_TOKENS}
    `);

    const facesByCluster = new Map<string, FaceRow[]>();
    for (const row of faceRows as unknown as FaceRow[]) {
      const list = facesByCluster.get(row.person_id) ?? [];
      list.push(row);
      facesByCluster.set(row.person_id, list);
    }

    // ------------------------------------------ 6. face-similarity signal
    const probeFaceIds = visibleClusterIds.flatMap((id) =>
      (facesByCluster.get(id) ?? [])
        .slice(0, SAMPLE_FACES_PER_CLUSTER)
        .map((face) => face.face_id)
    );

    const faceScores = new Map<string, Map<string, { name: string; similarity: number }>>();
    if (probeFaceIds.length > 0) {
      // The named-person filter sits inside the LATERAL so the HNSW index is
      // used for `ORDER BY ... LIMIT k` rather than scanning every embedding.
      const { rows: knnRows } = await db.execute(sql`
        WITH probes AS (
          SELECT fs."faceId" AS probe_face_id,
                 af."personId" AS cluster_id,
                 fs.embedding AS embedding
          FROM face_search fs
          JOIN asset_face af ON af.id = fs."faceId"
          WHERE fs."faceId" = ANY(${probeFaceIds}::uuid[])
        )
        SELECT probes.cluster_id,
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
        GROUP BY probes.cluster_id, nn.person_id, nn.name
      `);

      for (const row of knnRows as any[]) {
        const perCluster = faceScores.get(row.cluster_id) ?? new Map();
        const similarity = Number(row.similarity);
        const existing = perCluster.get(row.person_id);
        if (!existing || existing.similarity < similarity) {
          perCluster.set(row.person_id, { name: row.name, similarity });
        }
        faceScores.set(row.cluster_id, perCluster);
      }
    }

    // -------------------------------------- 7. same-asset co-occurrence
    // Counted, not just flagged: one shared photo can be a collage or a
    // photo-of-a-photo, but two independent co-appearances is proof that the
    // cluster is somebody else.
    const sameAsset = new Map<string, Map<string, number>>();
    const { rows: sameAssetRows } = await db.execute(sql`
      SELECT af."personId" AS cluster_id,
             p2.id AS person_id,
             count(DISTINCT af."assetId")::int AS shared
      FROM asset_face af
      JOIN asset_face af2
        ON af2."assetId" = af."assetId"
       AND af2.id <> af.id
       AND af2."deletedAt" IS NULL
       AND af2."isVisible" IS TRUE
      JOIN person p2
        ON p2.id = af2."personId"
       AND p2."ownerId" = ${ownerId}
       AND p2.name <> ''
      WHERE af."personId" = ANY(${visibleClusterIds}::uuid[])
        AND af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
      GROUP BY af."personId", p2.id
    `);
    for (const row of sameAssetRows as any[]) {
      const perCluster = sameAsset.get(row.cluster_id) ?? new Map<string, number>();
      perCluster.set(row.person_id, Number(row.shared));
      sameAsset.set(row.cluster_id, perCluster);
    }

    // ------------------------------------------ 8. social-circle signal
    const social = new Map<string, Map<string, number>>();
    const { rows: socialRows } = await db.execute(sql`
      WITH cluster_assets AS (
        SELECT DISTINCT af."personId" AS cluster_id, af."assetId" AS asset_id
        FROM asset_face af
        WHERE af."personId" = ANY(${visibleClusterIds}::uuid[])
          AND af."deletedAt" IS NULL
          AND af."isVisible" IS TRUE
      ),
      albums_of_interest AS (
        SELECT ca.cluster_id, aa."albumId" AS album_id
        FROM cluster_assets ca
        JOIN album_asset aa ON aa."assetId" = ca.asset_id
        GROUP BY ca.cluster_id, aa."albumId"
      ),
      album_sizes AS (
        SELECT aa."albumId" AS album_id, count(*)::int AS n
        FROM album_asset aa
        WHERE aa."albumId" IN (SELECT album_id FROM albums_of_interest)
        GROUP BY aa."albumId"
      )
      SELECT ai.cluster_id,
             p2.id AS person_id,
             count(DISTINCT af2."assetId")::int AS shared
      FROM albums_of_interest ai
      JOIN album_sizes s ON s.album_id = ai.album_id AND s.n <= ${MAX_ALBUM_SIZE_FOR_SOCIAL}
      JOIN album_asset aa2 ON aa2."albumId" = ai.album_id
      JOIN asset_face af2
        ON af2."assetId" = aa2."assetId"
       AND af2."deletedAt" IS NULL
       AND af2."isVisible" IS TRUE
      JOIN person p2
        ON p2.id = af2."personId"
       AND p2."ownerId" = ${ownerId}
       AND p2.name <> ''
      GROUP BY ai.cluster_id, p2.id
    `);
    for (const row of socialRows as any[]) {
      const perCluster = social.get(row.cluster_id) ?? new Map<string, number>();
      perCluster.set(row.person_id, Number(row.shared));
      social.set(row.cluster_id, perCluster);
    }

    // ------------------------------------------- 9. filename/folder signal
    const allTokens = new Set<string>();
    const tokensByCluster = new Map<string, Map<string, Set<string>>>();
    for (const clusterId of visibleClusterIds) {
      const perSource = new Map<string, Set<string>>([
        ["filename", new Set<string>()],
        ["folder", new Set<string>()],
      ]);
      for (const face of facesByCluster.get(clusterId) ?? []) {
        for (const token of filenameTokens(face.original_file_name)) {
          perSource.get("filename")!.add(token);
          allTokens.add(token);
        }
        for (const token of folderTokens(face.original_path)) {
          perSource.get("folder")!.add(token);
          allTokens.add(token);
        }
      }
      tokensByCluster.set(clusterId, perSource);
    }

    const tokenList = Array.from(allTokens);
    const tokenStats = new Map<string, { personId: string; assetCount: number }[]>();
    const tokenTotals = new Map<string, number>();
    if (tokenList.length > 0) {
      const learned = await appDb
        .select()
        .from(faceLabelTokens)
        .where(
          and(
            eq(faceLabelTokens.ownerId, ownerId),
            inArray(faceLabelTokens.token, tokenList)
          )
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

    // -------------------------------------------- 10. combine into groups
    const nameById = new Map<string, string>();
    for (const perCluster of Array.from(faceScores.values())) {
      for (const [personId, value] of Array.from(perCluster.entries())) {
        nameById.set(personId, value.name);
      }
    }

    const groups = visibleGroups.map((clusterGroup) => {
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

      const groupFaceTotal = clusterGroup.reduce(
        (sum, id) => sum + (faceCountById.get(id) ?? 0),
        0
      );

      for (const clusterId of clusterGroup) {
        // Face similarity — best match across the group's clusters.
        for (const [personId, value] of Array.from(
          (faceScores.get(clusterId) ?? new Map()).entries()
        )) {
          const candidate = ensure(personId);
          if (value.similarity > candidate.faceScore) {
            candidate.faceScore = value.similarity;
            candidate.evidence = candidate.evidence.filter(
              (e) => !e.startsWith("Face match")
            );
            candidate.evidence.push(
              `Face match ${(value.similarity * 100).toFixed(0)}%`
            );
          }
        }

        // Filename and folder tokens.
        const perSource = tokensByCluster.get(clusterId);
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

        // Social circle — shared albums.
        for (const [personId, shared] of Array.from(
          (social.get(clusterId) ?? new Map<string, number>()).entries()
        )) {
          const candidate = ensure(personId);
          const score = Math.min(1, shared / Math.max(1, groupFaceTotal));
          if (score > candidate.socialScore) candidate.socialScore = score;
        }

        // Same-asset appearance is close to a disqualification.
        for (const [personId, shared] of Array.from(
          (sameAsset.get(clusterId) ?? new Map<string, number>()).entries()
        )) {
          const candidate = ensure(personId);
          candidate.sharedAssets = Math.max(candidate.sharedAssets, shared);
        }
      }

      const suggestions = Array.from(candidates.values())
        // Two independent co-appearances means this is somebody else entirely.
        .filter((candidate) => candidate.sharedAssets < SAME_ASSET_HARD_DROP)
        .map((candidate) => {
          const confidence =
            SIGNAL_WEIGHTS.face * candidate.faceScore +
            SIGNAL_WEIGHTS.filename * candidate.filenameScore +
            SIGNAL_WEIGHTS.social * candidate.socialScore -
            (candidate.sharedAssets > 0 ? SAME_ASSET_PENALTY : 0);

          const evidence = [...candidate.evidence];
          if (candidate.socialScore > 0) {
            evidence.push("Appears in the same albums");
          }
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

      // Round-robin across the group's clusters rather than taking the first N
      // faces: the point of a group is to check that every cluster in it really
      // is the same person, which you cannot do if they are all from one.
      const perCluster = clusterGroup.map((id) => facesByCluster.get(id) ?? []);
      const interleaved: FaceRow[] = [];
      for (let depth = 0; interleaved.length < SAMPLE_ASSETS_PER_GROUP; depth++) {
        const before = interleaved.length;
        for (const faces of perCluster) {
          if (interleaved.length >= SAMPLE_ASSETS_PER_GROUP) break;
          if (faces[depth]) interleaved.push(faces[depth]);
        }
        if (interleaved.length === before) break;
      }

      const sampleFaces = interleaved
        .map((face) => ({
          faceId: face.face_id,
          personId: face.person_id,
          assetId: face.asset_id,
          imageWidth: Number(face.image_width),
          imageHeight: Number(face.image_height),
          boundingBox: {
            x1: Number(face.x1),
            y1: Number(face.y1),
            x2: Number(face.x2),
            y2: Number(face.y2),
          },
        }));

      return {
        // Stable identity for the group across a batch.
        id: clusterGroup.slice().sort().join("+"),
        clusterIds: clusterGroup,
        faceCount: groupFaceTotal,
        sampleFaces,
        suggestions,
      };
    });

    return res.status(200).json({
      groups,
      windowSize: clusters.length,
      hasMore: clusters.length === CLUSTER_WINDOW_SIZE || grouped.length > batchSize,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? "Failed to build labelling queue" });
  }
}
