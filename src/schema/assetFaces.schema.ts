import { pgTable, uuid, integer, varchar, boolean, timestamp } from "drizzle-orm/pg-core";

export const assetFaces = pgTable("asset_face", {
    id: uuid("id").defaultRandom().primaryKey(),
    assetId: uuid("assetId").notNull(),
    personId: uuid("personId"),
    imageWidth: integer("imageWidth").notNull().default(0),
    imageHeight: integer("imageHeight").notNull().default(0),
    boundingBoxX1: integer("boundingBoxX1").notNull().default(0),
    boundingBoxY1: integer("boundingBoxY1").notNull().default(0),
    boundingBoxX2: integer("boundingBoxX2").notNull().default(0),
    boundingBoxY2: integer("boundingBoxY2").notNull().default(0),
    // Immich soft-deletes faces and can mark them not visible. Both must be
    // filtered out when building a labelling queue, otherwise removed faces
    // reappear as work to do.
    sourceType: varchar("sourceType").notNull().default("machine-learning"),
    deletedAt: timestamp("deletedAt", { withTimezone: true }),
    isVisible: boolean("isVisible").notNull().default(true),
});
