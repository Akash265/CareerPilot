CREATE TYPE "public"."application_pitch_origin" AS ENUM('generated', 'user_edited');--> statement-breakpoint
CREATE TYPE "public"."company_research_status" AS ENUM('ok', 'no_results', 'failed');--> statement-breakpoint
CREATE TYPE "public"."company_research_source_kind" AS ENUM('web', 'internal');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_pitches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"origin" "application_pitch_origin" NOT NULL,
	"parent_pitch_id" uuid,
	"company_research_id" uuid,
	"research_status_snapshot" "company_research_status" NOT NULL,
	"researched_at_snapshot" timestamp with time zone,
	"bullets" jsonb NOT NULL,
	"requires_review" boolean NOT NULL,
	"source_profile_content_hash" text,
	"generation_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_pitches_version_positive" CHECK ("application_pitches"."version" >= 1),
	CONSTRAINT "application_pitches_bullets_three" CHECK (CASE WHEN jsonb_typeof("application_pitches"."bullets") = 'array' THEN jsonb_array_length("application_pitches"."bullets") = 3 ELSE false END)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_research" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"company_key" text NOT NULL,
	"company_name" text NOT NULL,
	"status" "company_research_status" NOT NULL,
	"error_code" text,
	"research_model" text,
	"search_count" integer DEFAULT 0 NOT NULL,
	"researched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_research_search_count_nonneg" CHECK ("company_research"."search_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_research_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"research_id" uuid NOT NULL,
	"source_kind" "company_research_source_kind" NOT NULL,
	"fact_text" text NOT NULL,
	"source_url" text,
	"source_title" text,
	"cited_text" text,
	"display_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_pitches" ADD CONSTRAINT "application_pitches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_pitches" ADD CONSTRAINT "application_pitches_parent_pitch_id_application_pitches_id_fk" FOREIGN KEY ("parent_pitch_id") REFERENCES "public"."application_pitches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_pitches" ADD CONSTRAINT "application_pitches_company_research_id_company_research_id_fk" FOREIGN KEY ("company_research_id") REFERENCES "public"."company_research"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_research_facts" ADD CONSTRAINT "company_research_facts_research_id_company_research_id_fk" FOREIGN KEY ("research_id") REFERENCES "public"."company_research"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "application_pitches_user_job_version_uniq" ON "application_pitches" USING btree ("user_id","job_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_research_user_company_uniq" ON "company_research" USING btree ("user_id","company_key");