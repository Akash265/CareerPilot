ALTER TABLE "career_goal_constraints" ADD COLUMN "salary_target_raw" text;--> statement-breakpoint
ALTER TABLE "career_goal_constraints" ADD COLUMN "salary_target_normalized" numeric;--> statement-breakpoint
ALTER TABLE "career_goal_constraints" ADD COLUMN "salary_target_currency" text;--> statement-breakpoint
ALTER TABLE "career_goal_constraints" ADD COLUMN "salary_target_is_parsed" boolean DEFAULT false NOT NULL;