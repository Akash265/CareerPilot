import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer } from "drizzle-orm/pg-core";

export const certifications = pgTable("certifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  name: text("name").notNull(),
  issuer: text("issuer").notNull(),
  issueDate: text("issue_date"),
  expiryDate: text("expiry_date"),
  displayOrder: integer("display_order").notNull().default(0),
});
