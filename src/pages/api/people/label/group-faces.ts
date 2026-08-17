import { GROUP_FACES_PAGE_SIZE } from "@/config/constants/faceLabel.constant";
import { db } from "@/config/db";
import { getCurrentUser } from "@/handlers/serverUtils/user.utils";
import { sql } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Every face behind one group on the labelling board.
 *
 * The board shows a handful of sample crops per card, which is enough to
 * recognise a person but not enough to trust a bulk apply: a 500-face cluster
 * routinely contains a few faces that are somebody else, and without seeing
 * them the only options are "take all" or "take none". This endpoint backs the
 * review dialog that makes the middle ground possible.
 */

/** Bind a list of uuids as a single parameter — see the note in queue.ts. */
const uuidArray = (ids: string[]) => sql`string_to_array(${ids.join(",")}, ',')::uuid[]`;

const asIdList = (value: unknown): string[] =>
  String(value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

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

    const clusterIds = asIdList(req.query.clusterIds);
    const faceIds = asIdList(req.query.faceIds);

    if (clusterIds.length === 0 && faceIds.length === 0) {
      return res.status(400).json({ error: "clusterIds or faceIds is required" });
    }

    const page = Math.max(1, toNumber(req.query.page, 1));
    const pageSize = Math.max(
      1,
      Math.min(GROUP_FACES_PAGE_SIZE, toNumber(req.query.pageSize, GROUP_FACES_PAGE_SIZE))
    );

    // A cluster group is "every face of these people"; a face group is a fixed
    // list of face ids. Both are scoped to the caller's own assets, so an id
    // guessed from another library returns nothing rather than leaking a crop.
    const selector =
      clusterIds.length > 0
        ? sql`af."personId" = ANY(${uuidArray(clusterIds)})`
        : sql`af.id = ANY(${uuidArray(faceIds)})`;

    const source = sql`
      FROM asset_face af
      JOIN asset a
        ON a.id = af."assetId"
       AND a."deletedAt" IS NULL
       AND a.status = 'active'
       AND a."ownerId" = ${currentUser.id}
      WHERE ${selector}
        AND af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
    `;

    const { rows: countRows } = await db.execute(
      sql`SELECT count(*)::int AS total ${source}`
    );
    const total = Number((countRows[0] as any)?.total ?? 0);

    const { rows } = await db.execute(sql`
      SELECT af.id AS face_id,
             af."assetId" AS asset_id,
             af."imageWidth" AS image_width,
             af."imageHeight" AS image_height,
             af."boundingBoxX1" AS x1,
             af."boundingBoxY1" AS y1,
             af."boundingBoxX2" AS x2,
             af."boundingBoxY2" AS y2,
             a."originalFileName" AS original_file_name
      ${source}
      -- Biggest crops first: the ones a user can actually judge come first,
      -- and the odd tiny background face lands at the end where it is easy to
      -- untick in a block.
      ORDER BY ((af."boundingBoxX2" - af."boundingBoxX1")
              * (af."boundingBoxY2" - af."boundingBoxY1")) DESC, af.id
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `);

    return res.status(200).json({
      total,
      page,
      pageSize,
      faces: (rows as any[]).map((row) => ({
        faceId: row.face_id,
        assetId: row.asset_id,
        fileName: row.original_file_name,
        imageWidth: Number(row.image_width),
        imageHeight: Number(row.image_height),
        boundingBox: {
          x1: Number(row.x1),
          y1: Number(row.y1),
          x2: Number(row.x2),
          y2: Number(row.y2),
        },
      })),
    });
  } catch (error: any) {
    return res
      .status(500)
      .json({ error: error?.message ?? "Failed to load the faces in this group" });
  }
}
