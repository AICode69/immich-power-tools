import { MERGE_CHUNK_SIZE } from "@/config/constants/faceLabel.constant";
import { db } from "@/config/db";
import { ENV } from "@/config/environment";
import { appDb } from "@/db";
import { faceLabelSkips } from "@/db/schema";
import { getCurrentUser } from "@/handlers/serverUtils/user.utils";
import { getUserHeaders } from "@/helpers/user.helper";
import { person } from "@/schema";
import { inArray } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";

type ApplyAction = "name" | "merge" | "hide" | "skip";

interface ApplyItem {
  clusterIds: string[];
  action: ApplyAction;
  /** Required for "name": the new name to give the cluster(s). */
  name?: string;
  /** Required for "merge": an existing person to absorb the cluster(s). */
  targetPersonId?: string;
}

interface ApplyRequest {
  items: ApplyItem[];
  /**
   * Merging is irreversible — Immich has no split — so grouped clusters are
   * only renamed unless this is explicitly turned on.
   */
  mergeGroups?: boolean;
  dryRun?: boolean;
}

interface PlannedCall {
  method: string;
  path: string;
  body: unknown;
}

interface ItemResult {
  clusterIds: string[];
  action: ApplyAction;
  status: "applied" | "partial" | "failed" | "skipped";
  error?: string;
}

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const currentUser = await getCurrentUser(req);
    if (!currentUser) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { items = [], mergeGroups = false, dryRun = false } =
      (req.body ?? {}) as ApplyRequest;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items must be a non-empty array" });
    }

    const ownerId = currentUser.id;
    const results: ItemResult[] = [];
    const planned: PlannedCall[] = [];

    // ------------------------------------------------------------- phase 0
    // Revalidate against the live database. The page may be minutes old, and
    // this also makes a replayed request harmless: clusters that were already
    // named are no longer eligible and get reported as skipped rather than
    // renamed a second time or merged again.
    const allClusterIds = Array.from(
      new Set(items.flatMap((item) => item.clusterIds ?? []))
    );
    const liveRows = allClusterIds.length
      ? await db
          .select({
            id: person.id,
            name: person.name,
            ownerId: person.ownerId,
          })
          .from(person)
          .where(inArray(person.id, allClusterIds))
      : [];
    const liveById = new Map(liveRows.map((row) => [row.id, row]));

    const eligible = (clusterId: string) => {
      const row = liveById.get(clusterId);
      return Boolean(row && row.ownerId === ownerId && row.name === "");
    };

    // Items that survive validation, paired with the work they imply.
    const renameUpdates: { id: string; name: string }[] = [];
    const hideUpdates: { id: string; isHidden: boolean }[] = [];
    const mergeOps: { target: string; ids: string[]; itemIndex: number }[] = [];
    const skipIds: string[] = [];
    const itemIndexByPersonId = new Map<string, number>();

    items.forEach((item, index) => {
      const clusterIds = (item.clusterIds ?? []).filter(eligible);

      if (clusterIds.length === 0) {
        results[index] = {
          clusterIds: item.clusterIds ?? [],
          action: item.action,
          status: "skipped",
          error: "No longer unnamed, or not owned by this user",
        };
        return;
      }

      results[index] = { clusterIds, action: item.action, status: "applied" };

      if (item.action === "name") {
        const name = (item.name ?? "").trim();
        if (!name) {
          results[index] = {
            clusterIds,
            action: item.action,
            status: "failed",
            error: "A name is required",
          };
          return;
        }
        // Name every cluster in the group. That alone is fully reversible.
        for (const id of clusterIds) {
          renameUpdates.push({ id, name });
          itemIndexByPersonId.set(id, index);
        }
        // Collapsing them into one person is not, so it is opt-in.
        if (mergeGroups && clusterIds.length > 1) {
          mergeOps.push({
            target: clusterIds[0],
            ids: clusterIds.slice(1),
            itemIndex: index,
          });
        }
        return;
      }

      if (item.action === "merge") {
        if (!item.targetPersonId) {
          results[index] = {
            clusterIds,
            action: item.action,
            status: "failed",
            error: "targetPersonId is required to merge",
          };
          return;
        }
        // The named person is always the merge target: merging the other way
        // would discard their name, birthday, colour and chosen thumbnail.
        mergeOps.push({
          target: item.targetPersonId,
          ids: clusterIds,
          itemIndex: index,
        });
        return;
      }

      if (item.action === "hide") {
        for (const id of clusterIds) {
          hideUpdates.push({ id, isHidden: true });
          itemIndexByPersonId.set(id, index);
        }
        return;
      }

      if (item.action === "skip") {
        skipIds.push(...clusterIds);
      }
    });

    // ------------------------------------------------------------- phase 1
    // One bulk call carries every rename and every hide.
    const peopleUpdates = [
      ...renameUpdates.map((u) => ({ id: u.id, name: u.name })),
      ...hideUpdates.map((u) => ({ id: u.id, isHidden: u.isHidden })),
    ];

    if (peopleUpdates.length > 0) {
      planned.push({
        method: "PUT",
        path: "/api/people",
        body: { people: peopleUpdates },
      });

      if (!dryRun) {
        const response = await fetch(`${ENV.IMMICH_URL}/api/people`, {
          method: "PUT",
          headers: getUserHeaders(currentUser),
          body: JSON.stringify({ people: peopleUpdates }),
        });

        if (!response.ok) {
          const message = `Immich rejected the bulk update (HTTP ${response.status})`;
          for (const update of peopleUpdates) {
            const index = itemIndexByPersonId.get(update.id);
            if (index !== undefined) {
              results[index] = { ...results[index], status: "failed", error: message };
            }
          }
        } else {
          const body = (await response.json()) as {
            id: string;
            success: boolean;
            error?: string;
          }[];
          for (const row of Array.isArray(body) ? body : []) {
            if (row.success) continue;
            const index = itemIndexByPersonId.get(row.id);
            if (index !== undefined) {
              results[index] = {
                ...results[index],
                status: "failed",
                error: row.error ?? "Update rejected",
              };
            }
          }
        }
      }
    }

    // ------------------------------------------------------------- phase 2
    // Merges run last, because they cannot be undone. If the rename failed we
    // do not merge faces into a cluster we could not name.
    for (const op of mergeOps) {
      if (results[op.itemIndex]?.status === "failed") continue;

      for (const ids of chunk(op.ids, MERGE_CHUNK_SIZE)) {
        planned.push({
          method: "POST",
          path: `/api/people/${op.target}/merge`,
          body: { ids },
        });

        if (dryRun) continue;

        const response = await fetch(
          `${ENV.IMMICH_URL}/api/people/${op.target}/merge`,
          {
            method: "POST",
            headers: getUserHeaders(currentUser),
            body: JSON.stringify({ ids }),
          }
        );

        if (!response.ok) {
          results[op.itemIndex] = {
            ...results[op.itemIndex],
            status: "partial",
            error: `Named successfully, but merging failed (HTTP ${response.status})`,
          };
        }
      }
    }

    // ------------------------------------------------------------- phase 3
    if (skipIds.length > 0 && !dryRun) {
      await appDb
        .insert(faceLabelSkips)
        .values(skipIds.map((personId) => ({ ownerId, personId })))
        .onConflictDoNothing();
    }

    const summary = results.reduce(
      (acc, result) => {
        if (result) acc[result.status] = (acc[result.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return res.status(200).json({
      dryRun,
      mergeGroups,
      results,
      summary,
      plannedCalls: planned,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? "Failed to apply labels" });
  }
}
