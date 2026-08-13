import { sqliteTable, text, integer, real, index, unique } from "drizzle-orm/sqlite-core";
import { randomUUID } from "crypto";

/**
 * Learned association between a filename/folder token and a person, derived
 * entirely from the user's own already-labelled assets.
 *
 * Privacy note: these rows contain filename fragments and Immich person ids.
 * They live only in the local app database (data/*.db, gitignored) and are
 * never transmitted anywhere.
 */
export const faceLabelTokens = sqliteTable(
  "face_label_tokens",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    ownerId: text("owner_id").notNull(),
    // "filename" | "folder"
    source: text("source").notNull(),
    token: text("token").notNull(),
    personId: text("person_id").notNull(),
    // Number of assets carrying this token that contain this person.
    assetCount: integer("asset_count").notNull().default(0),
  },
  (t) => [
    unique().on(t.ownerId, t.source, t.token, t.personId),
    index("face_label_tokens_lookup_idx").on(t.ownerId, t.source, t.token),
  ]
);

/** Total number of assets carrying each token, regardless of who is in them. */
export const faceLabelTokenTotals = sqliteTable(
  "face_label_token_totals",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    ownerId: text("owner_id").notNull(),
    source: text("source").notNull(),
    token: text("token").notNull(),
    totalAssets: integer("total_assets").notNull().default(0),
    // Share of the whole library carrying this token. Used to discard tokens
    // too generic to identify anybody.
    librarySharePct: real("library_share_pct").notNull().default(0),
  },
  (t) => [
    unique().on(t.ownerId, t.source, t.token),
    index("face_label_token_totals_lookup_idx").on(t.ownerId, t.source, t.token),
  ]
);

/** Freshness bookkeeping for the token index, one row per owner. */
export const faceLabelIndexMeta = sqliteTable(
  "face_label_index_meta",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    ownerId: text("owner_id").notNull().unique(),
    builtAt: integer("built_at", { mode: "timestamp" }),
    assetsScanned: integer("assets_scanned").notNull().default(0),
    tokensLearned: integer("tokens_learned").notNull().default(0),
    namedPeopleSeen: integer("named_people_seen").notNull().default(0),
  }
);

/** Clusters the user chose to skip, so they stop coming back in the queue. */
export const faceLabelSkips = sqliteTable(
  "face_label_skips",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    ownerId: text("owner_id").notNull(),
    personId: text("person_id").notNull(),
    skippedAt: integer("skipped_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (t) => [
    unique().on(t.ownerId, t.personId),
    index("face_label_skips_owner_idx").on(t.ownerId),
  ]
);
