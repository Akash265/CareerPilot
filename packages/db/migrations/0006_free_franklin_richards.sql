CREATE TYPE "public"."career_goal_confirmation_status" AS ENUM('draft', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."career_goal_parse_status" AS ENUM('pending', 'parsed', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "career_goal_constraints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"career_goal_id" uuid NOT NULL,
	"target_roles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"seniority" text,
	"locations" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"work_mode" "work_mode_preference" DEFAULT 'any' NOT NULL,
	"min_experience_years" integer,
	"employment_type" text,
	"salary_floor_raw" text,
	"salary_floor_normalized" numeric,
	"salary_currency" text,
	"salary_is_parsed" boolean DEFAULT false NOT NULL,
	"visa_sponsorship_required" boolean,
	"skills" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"preferred_industries" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"excluded_industries" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"preferred_companies" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"excluded_companies" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"hard_constraints" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	CONSTRAINT "career_goal_constraints_career_goal_id_unique" UNIQUE("career_goal_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "career_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"raw_text" text NOT NULL,
	"version" integer NOT NULL,
	"parse_status" "career_goal_parse_status" DEFAULT 'pending' NOT NULL,
	"parse_error" text,
	"confirmation_status" "career_goal_confirmation_status" DEFAULT 'draft' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
DROP TABLE "company_preferences" CASCADE;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "career_goal_constraints" ADD CONSTRAINT "career_goal_constraints_career_goal_id_career_goals_id_fk" FOREIGN KEY ("career_goal_id") REFERENCES "public"."career_goals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "candidate_profiles" DROP COLUMN IF EXISTS "work_mode_preference";--> statement-breakpoint
ALTER TABLE "candidate_profiles" DROP COLUMN IF EXISTS "salary_expectation_min";--> statement-breakpoint
ALTER TABLE "candidate_profiles" DROP COLUMN IF EXISTS "salary_expectation_max";--> statement-breakpoint
ALTER TABLE "candidate_profiles" DROP COLUMN IF EXISTS "salary_currency";--> statement-breakpoint
ALTER TABLE "candidate_profiles" DROP COLUMN IF EXISTS "visa_sponsorship_required";--> statement-breakpoint
ALTER TABLE "candidate_profiles" DROP COLUMN IF EXISTS "preferred_role_titles";--> statement-breakpoint
ALTER TABLE "candidate_profiles" DROP COLUMN IF EXISTS "preferred_industries";--> statement-breakpoint
ALTER TABLE "candidate_profiles" DROP COLUMN IF EXISTS "excluded_industries";--> statement-breakpoint
DROP TYPE "public"."company_preference_list_type";