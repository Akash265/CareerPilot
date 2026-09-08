import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer } from "drizzle-orm/pg-core";

export const achievements = pgTable("achievements", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  description: text("description").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
});
