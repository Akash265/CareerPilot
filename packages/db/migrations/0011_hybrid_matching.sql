CREATE TYPE "public"."job_match_user_action" AS ENUM('none', 'saved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."matching_run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"career_goal_id" uuid NOT NULL,
	"eligible" boolean NOT NULL,
	"ineligible_reason" text,
	"skills_score" numeric,
	"experience_score" numeric,
	"location_score" numeric,
	"sponsorship_score" numeric,
	"role_score" numeric,
	"salary_score" numeric,
	"industry_score" numeric,
	"freshness_score" numeric,
	"semantic_score" numeric,
	"overall_score" numeric,
	"explanation" jsonb,
	"explanation_model" text,
	"explanation_description_hash" text,
	"explanation_generated_at" timestamp with time zone,
	"user_action" "job_match_user_action" DEFAULT 'none' NOT NULL,
	"user_action_at" timestamp with time zone,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "matching_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"career_goal_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "matching_run_status" DEFAULT 'running' NOT NULL,
	"error_class" text,
	"jobs_evaluated" integer DEFAULT 0 NOT NULL,
	"jobs_eligible" integer DEFAULT 0 NOT NULL,
	"jobs_explained" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "career_goal_constraints" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "career_goal_constraints" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "embedding_content_hash" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "embedding_model" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_career_goal_id_career_goals_id_fk" FOREIGN KEY ("career_goal_id") REFERENCES "public"."career_goals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matching_runs" ADD CONSTRAINT "matching_runs_career_goal_id_career_goals_id_fk" FOREIGN KEY ("career_goal_id") REFERENCES "public"."career_goals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_matches_user_job_uniq" ON "job_matches" USING btree ("user_id","job_id");