import { db } from "@/config/db";
import { getCurrentUser } from "@/handlers/serverUtils/user.utils";
import { sql } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Named people who almost certainly are the same person, so a labelling
 * session can be tidied up afterwards.
 *
 * Matching is on a normalised name (case, accents and punctuation removed)
 * rather than embeddings: this exists to catch "Alex Doe" vs "alex doe" vs
 * "Alex  Doe", which is what bulk labelling actually produces.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const currentUser = await getCurrentUser(req);
    if (!currentUser) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { rows } = await db.execute(sql`
      WITH named AS (
        SELECT p.id,
               p.name,
               p."isHidden",
               regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '', 'g') AS normalised,
               count(af.id)::int AS face_count
        FROM person p
        LEFT JOIN asset_face af
          ON af."personId" = p.id
         AND af."deletedAt" IS NULL
         AND af."isVisible" IS TRUE
        WHERE p."ownerId" = ${currentUser.id}
          AND p.name <> ''
        GROUP BY p.id, p.name, p."isHidden"
      ),
      dupes AS (
        SELECT normalised
        FROM named
        WHERE normalised <> ''
        GROUP BY normalised
        HAVING count(*) > 1
      )
      SELECT n.normalised,
             n.id,
             n.name,
             n."isHidden" AS is_hidden,
             n.face_count
      FROM named n
      JOIN dupes d ON d.normalised = n.normalised
      ORDER BY n.normalised, n.face_count DESC, n.id
    `);

    const byName = new Map<
      string,
      { id: string; name: string; isHidden: boolean; faceCount: number }[]
    >();

    for (const row of rows as any[]) {
      const list = byName.get(row.normalised) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        isHidden: Boolean(row.is_hidden),
        faceCount: Number(row.face_count),
      });
      byName.set(row.normalised, list);
    }

    // The person with the most faces is the sensible merge target: they keep
    // their birthday, colour and chosen thumbnail.
    const groups = Array.from(byName.entries()).map(([normalised, people]) => ({
      key: normalised,
      primary: people[0],
      duplicates: people.slice(1),
      totalFaces: people.reduce((sum, p) => sum + p.faceCount, 0),
    }));

    groups.sort((a, b) => b.totalFaces - a.totalFaces);

    return res.status(200).json({ groups });
  } catch (error: any) {
    return res
      .status(500)
      .json({ error: error?.message ?? "Failed to find duplicate people" });
  }
}
