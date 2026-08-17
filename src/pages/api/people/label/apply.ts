import { MERGE_CHUNK_SIZE } from "@/config/constants/faceLabel.constant";
import { db } from "@/config/db";
import { ENV } from "@/config/environment";
import { appDb } from "@/db";
import { faceLabelSkips } from "@/db/schema";
import { getCurrentUser } from "@/handlers/serverUtils/user.utils";
import { getUserHeaders } from "@/helpers/user.helper";
import { assetFaces, person } from "@/schema";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";

type ApplyAction = "name" | "merge" | "hide" | "skip";

interface ApplyItem {
  /** Unnamed person clusters (kind "cluster"). */
  clusterIds?: string[];
  /** Unassigned faces (kind "faces") — no person row exists yet. */
  faceIds?: string[];
  /** Faces the user unticked in the review dialog. */
  excludedFaceIds?: string[];
  action: ApplyAction;
  name?: string;
  targetPersonId?: string;
}

interface ApplyRequest {
  items: ApplyItem[];
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
  faceIds: string[];
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

    const immich = (path: string, method: string, body: unknown) =>
      fetch(`${ENV.IMMICH_URL}/api${path}`, {
        method,
        headers: getUserHeaders(currentUser),
        body: JSON.stringify(body),
      });

    // ------------------------------------------------------------- phase 0
    // Revalidate against the live database. The page may be minutes old, and
    // this makes a replayed request harmless: anything already handled is no
    // longer eligible and gets reported as skipped rather than applied twice.
    const allClusterIds = Array.from(
      new Set(items.flatMap((item) => item.clusterIds ?? []))
    );
    const allFaceIds = Array.from(new Set(items.flatMap((item) => item.faceIds ?? [])));

    const liveClusters = allClusterIds.length
      ? await db
          .select({ id: person.id, name: person.name, ownerId: person.ownerId })
          .from(person)
          .where(inArray(person.id, allClusterIds))
      : [];
    const clusterById = new Map(liveClusters.map((row) => [row.id, row]));

    // A face is still workable only while it has no person attached.
    const liveFaces = allFaceIds.length
      ? await db
          .select({ id: assetFaces.id })
          .from(assetFaces)
          .where(
            and(
              inArray(assetFaces.id, allFaceIds),
              isNull(assetFaces.personId),
              isNull(assetFaces.deletedAt)
            )
          )
      : [];
    const liveFaceIds = new Set(liveFaces.map((row) => row.id));

    const eligibleCluster = (id: string) => {
      const row = clusterById.get(id);
      return Boolean(row && row.ownerId === ownerId && row.name === "");
    };

    // ------------------------------------------------- excluded faces
    // A face the user unticked is only honoured if it really is in the group
    // it was unticked from — a stale page must not be able to reassign
    // arbitrary faces.
    const allExcludedIds = Array.from(
      new Set(items.flatMap((item) => item.excludedFaceIds ?? []))
    );
    const excludedOwner = new Map<string, string | null>();
    if (allExcludedIds.length > 0) {
      const rows = await db
        .select({ id: assetFaces.id, personId: assetFaces.personId })
        .from(assetFaces)
        .where(
          and(inArray(assetFaces.id, allExcludedIds), isNull(assetFaces.deletedAt))
        );
      for (const row of rows) excludedOwner.set(row.id, row.personId);
    }

    // Live face counts, so a group with everything unticked fails loudly
    // rather than naming an empty cluster.
    const clusterFaceCounts = new Map<string, number>();
    if (allClusterIds.length > 0) {
      const rows = await db
        .select({ personId: assetFaces.personId, total: count(assetFaces.id) })
        .from(assetFaces)
        .where(
          and(
            inArray(assetFaces.personId, allClusterIds),
            isNull(assetFaces.deletedAt),
            eq(assetFaces.isVisible, true)
          )
        )
        .groupBy(assetFaces.personId);
      for (const row of rows) {
        if (row.personId) clusterFaceCounts.set(row.personId, Number(row.total));
      }
    }

    const renameUpdates: { id: string; name: string }[] = [];
    const hideUpdates: { id: string; isHidden: boolean }[] = [];
    const mergeOps: { target: string; ids: string[]; itemIndex: number }[] = [];
    // Faces that need attaching to a person, resolved in phase 2.
    const faceOps: {
      itemIndex: number;
      faceIds: string[];
      targetPersonId?: string;
      newName?: string;
    }[] = [];
    const skips: { kind: string; targetId: string }[] = [];
    const itemIndexByPersonId = new Map<string, number>();
    // Faces to lift out of their cluster before it is named or merged.
    const splitOps: { itemIndex: number; faceIds: string[] }[] = [];

    items.forEach((item, index) => {
      const clusterIds = (item.clusterIds ?? []).filter(eligibleCluster);
      const excluded = new Set(item.excludedFaceIds ?? []);
      const faceIds = (item.faceIds ?? []).filter(
        (id) => liveFaceIds.has(id) && !excluded.has(id)
      );
      const isFaceItem = (item.faceIds ?? []).length > 0;

      const base = { clusterIds, faceIds, action: item.action };

      if (clusterIds.length === 0 && faceIds.length === 0) {
        results[index] = {
          ...base,
          status: "skipped",
          error: isFaceItem
            ? "Face is already assigned to someone"
            : "No longer unnamed, or not owned by this user",
        };
        return;
      }

      results[index] = { ...base, status: "applied" };

      if (item.action === "skip") {
        for (const id of clusterIds) skips.push({ kind: "cluster", targetId: id });
        for (const id of faceIds) skips.push({ kind: "face", targetId: id });
        return;
      }

      if (item.action === "hide") {
        if (isFaceItem) {
          // There is no person to hide, and deleting the face is destructive —
          // skipping is the honest equivalent.
          for (const id of faceIds) skips.push({ kind: "face", targetId: id });
          return;
        }
        for (const id of clusterIds) {
          hideUpdates.push({ id, isHidden: true });
          itemIndexByPersonId.set(id, index);
        }
        return;
      }

      // From here the group is being attributed to somebody, so any face the
      // user unticked has to leave the cluster first — a merge takes every
      // face the cluster holds and cannot be undone.
      if (clusterIds.length > 0 && excluded.size > 0) {
        const toSplit = Array.from(excluded).filter((id) => {
          const personId = excludedOwner.get(id);
          return Boolean(personId && clusterIds.includes(personId));
        });

        if (toSplit.length > 0) {
          const totalFaces = clusterIds.reduce(
            (sum, id) => sum + (clusterFaceCounts.get(id) ?? 0),
            0
          );
          if (totalFaces - toSplit.length <= 0) {
            results[index] = {
              ...base,
              status: "failed",
              error: "Every face in this group was excluded — nothing left to label",
            };
            return;
          }
          splitOps.push({ itemIndex: index, faceIds: toSplit });
        }
      }

      if (item.action === "merge") {
        if (!item.targetPersonId) {
          results[index] = { ...base, status: "failed", error: "targetPersonId is required" };
          return;
        }
        if (faceIds.length > 0) {
          faceOps.push({ itemIndex: index, faceIds, targetPersonId: item.targetPersonId });
        }
        if (clusterIds.length > 0) {
          mergeOps.push({ target: item.targetPersonId, ids: clusterIds, itemIndex: index });
        }
        return;
      }

      // action === "name"
      const name = (item.name ?? "").trim();
      if (!name) {
        results[index] = { ...base, status: "failed", error: "A name is required" };
        return;
      }

      if (faceIds.length > 0) {
        // Unassigned faces have no person record, so one has to be created.
        faceOps.push({ itemIndex: index, faceIds, newName: name });
      }

      if (clusterIds.length > 0) {
        for (const id of clusterIds) {
          renameUpdates.push({ id, name });
          itemIndexByPersonId.set(id, index);
        }
        if (mergeGroups && clusterIds.length > 1) {
          mergeOps.push({ target: clusterIds[0], ids: clusterIds.slice(1), itemIndex: index });
        }
      }
    });

    // ------------------------------------------------------------- phase 0.5
    // Lift unticked faces out of their cluster, into a fresh unnamed person.
    //
    // This has to happen before the rename, or the faces the user rejected get
    // the name too. Immich has no "unassign a face" call — reassigning is the
    // only move — so the leftovers land in a new unnamed cluster, which is
    // exactly where the labelling queue picks them up again.
    for (const op of splitOps) {
      if (results[op.itemIndex]?.status === "failed") continue;

      // An empty body creates a person with no name; naming it would hide it
      // from the queue, which is the opposite of what we want.
      planned.push({ method: "POST", path: "/api/people", body: {} });

      let leftoverPersonId = "<new-unnamed-person-id>";
      if (!dryRun) {
        const created = await immich("/people", "POST", {});
        if (!created.ok) {
          results[op.itemIndex] = {
            ...results[op.itemIndex],
            status: "failed",
            error: `Could not set the excluded faces aside (HTTP ${created.status})`,
          };
          continue;
        }
        leftoverPersonId = ((await created.json()) as { id: string }).id;
      }

      let failures = 0;
      for (const faceId of op.faceIds) {
        planned.push({
          method: "PUT",
          path: `/api/faces/${leftoverPersonId}`,
          body: { id: faceId },
        });
        if (dryRun) continue;

        const response = await immich(`/faces/${leftoverPersonId}`, "PUT", {
          id: faceId,
        });
        if (!response.ok) failures += 1;
      }

      // Naming the group anyway would silently label the faces the user
      // rejected, so a failed split stops the item.
      if (failures > 0) {
        results[op.itemIndex] = {
          ...results[op.itemIndex],
          status: "failed",
          error: `${failures} of ${op.faceIds.length} excluded face(s) could not be moved out, so nothing was applied to this group`,
        };
      }
    }

    const splitFailed = new Set(
      splitOps
        .filter((op) => results[op.itemIndex]?.status === "failed")
        .map((op) => op.itemIndex)
    );

    // ------------------------------------------------------------- phase 1
    // Renames and hides for existing person records: one bulk call.
    const stillLive = (personId: string) => {
      const index = itemIndexByPersonId.get(personId);
      return index === undefined || !splitFailed.has(index);
    };

    const peopleUpdates = [
      ...renameUpdates
        .filter((u) => stillLive(u.id))
        .map((u) => ({ id: u.id, name: u.name })),
      ...hideUpdates
        .filter((u) => stillLive(u.id))
        .map((u) => ({ id: u.id, isHidden: u.isHidden })),
    ];

    if (peopleUpdates.length > 0) {
      planned.push({ method: "PUT", path: "/api/people", body: { people: peopleUpdates } });

      if (!dryRun) {
        const response = await immich("/people", "PUT", { people: peopleUpdates });
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
    // Attach unassigned faces to a person, creating one first when needed.
    for (const op of faceOps) {
      if (results[op.itemIndex]?.status === "failed") continue;

      let personId = op.targetPersonId;

      if (!personId) {
        planned.push({ method: "POST", path: "/api/people", body: { name: op.newName } });
        if (dryRun) {
          personId = "<new-person-id>";
        } else {
          const created = await immich("/people", "POST", { name: op.newName });
          if (!created.ok) {
            results[op.itemIndex] = {
              ...results[op.itemIndex],
              status: "failed",
              error: `Could not create the person (HTTP ${created.status})`,
            };
            continue;
          }
          personId = ((await created.json()) as { id: string }).id;
        }
      }

      let failures = 0;
      for (const faceId of op.faceIds) {
        // PUT /faces/{personId} with {id: faceId} — the path parameter is the
        // person, despite the route name. Verified against Immich's
        // PersonService.reassignFacesById(auth, personId, dto).
        planned.push({
          method: "PUT",
          path: `/api/faces/${personId}`,
          body: { id: faceId },
        });
        if (dryRun) continue;

        const response = await immich(`/faces/${personId}`, "PUT", { id: faceId });
        if (!response.ok) failures += 1;
      }

      if (failures > 0) {
        results[op.itemIndex] = {
          ...results[op.itemIndex],
          status: failures === op.faceIds.length ? "failed" : "partial",
          error: `${failures} of ${op.faceIds.length} face(s) could not be assigned`,
        };
      }
    }

    // ------------------------------------------------------------- phase 3
    // Merges last, because they cannot be undone.
    for (const op of mergeOps) {
      if (results[op.itemIndex]?.status === "failed") continue;

      for (const ids of chunk(op.ids, MERGE_CHUNK_SIZE)) {
        planned.push({
          method: "POST",
          path: `/api/people/${op.target}/merge`,
          body: { ids },
        });
        if (dryRun) continue;

        const response = await immich(`/people/${op.target}/merge`, "POST", { ids });
        if (!response.ok) {
          results[op.itemIndex] = {
            ...results[op.itemIndex],
            status: "partial",
            error: `Named successfully, but merging failed (HTTP ${response.status})`,
          };
        }
      }
    }

    // ------------------------------------------------------------- phase 4
    if (skips.length > 0 && !dryRun) {
      await appDb
        .insert(faceLabelSkips)
        .values(skips.map((s) => ({ ownerId, kind: s.kind, targetId: s.targetId })))
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
