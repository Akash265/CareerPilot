import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  name: text("name").notNull(),
  description: text("description").notNull(),
  url: text("url"),
  displayOrder: integer("display_order").notNull().default(0),
});
