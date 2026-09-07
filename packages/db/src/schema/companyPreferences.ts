import { sql } from "drizzle-orm";
import { pgTable, uuid, text, pgEnum } from "drizzle-orm/pg-core";

export const companyPreferenceListTypeEnum = pgEnum(
  "company_preference_list_type",
  ["preferred", "excluded"]
);

export const companyPreferences = pgTable("company_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  companyName: text("company_name").notNull(),
  listType: companyPreferenceListTypeEnum("list_type").notNull(),
});
