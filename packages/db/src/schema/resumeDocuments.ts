import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const extractionStatusEnum = pgEnum("extraction_status", [
  "pending", "extracted", "failed",
]);

export const resumeDocuments = pgTable("resume_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  objectKey: text("object_key").notNull(),
  originalFilename: text("original_filename").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  extractionStatus: extractionStatusEnum("extraction_status")
    .notNull()
    .default("pending"),
  extractionError: text("extraction_error"),
  isActive: boolean("is_active").notNull().default(true),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
