CREATE TYPE "public"."requirement_level" AS ENUM('required', 'preferred');--> statement-breakpoint
CREATE TYPE "public"."requirement_term_type" AS ENUM('skill', 'tool', 'certification', 'other');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ats_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"resume_optimization_id" uuid NOT NULL,
	"required_keyword_coverage" numeric NOT NULL,
	"preferred_keyword_coverage" numeric NOT NULL,
	"semantic_similarity" numeric,
	"factual_consistency" numeric NOT NULL,
	"action_verb_score" numeric NOT NULL,
	"machine_readability_score" numeric NOT NULL,
	"overall_score" numeric NOT NULL,
	"evaluator_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"term_text" text NOT NULL,
	"term_type" "requirement_term_type" NOT NULL,
	"requirement_level" "requirement_level" NOT NULL,
	"evidence_quote" text,
	"extraction_model" text NOT NULL,
	"extraction_source_description_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resume_optimizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"career_goal_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_profile_content_hash" text NOT NULL,
	"selected_bullets" jsonb NOT NULL,
	"added_terms" text[] DEFAULT '{}'::text[] NOT NULL,
	"unsupported_claims_detected" text[] DEFAULT '{}'::text[] NOT NULL,
	"requires_review" boolean NOT NULL,
	"rejected_claims" jsonb NOT NULL,
	"generation_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ats_evaluations" ADD CONSTRAINT "ats_evaluations_resume_optimization_id_resume_optimizations_id_fk" FOREIGN KEY ("resume_optimization_id") REFERENCES "public"."resume_optimizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_requirements" ADD CONSTRAINT "job_requirements_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resume_optimizations" ADD CONSTRAINT "resume_optimizations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resume_optimizations" ADD CONSTRAINT "resume_optimizations_career_goal_id_career_goals_id_fk" FOREIGN KEY ("career_goal_id") REFERENCES "public"."career_goals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resume_optimizations_user_job_version_uniq" ON "resume_optimizations" USING btree ("user_id","job_id","version");