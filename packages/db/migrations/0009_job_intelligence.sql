CREATE TYPE "public"."ingestion_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_source_kind" AS ENUM('greenhouse', 'lever', 'upload');--> statement-breakpoint
CREATE TYPE "public"."job_sponsorship" AS ENUM('offered', 'not_offered', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."job_work_mode" AS ENUM('remote', 'hybrid', 'onsite', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."salary_period" AS ENUM('year', 'month', 'hour');--> statement-breakpoint
CREATE TYPE "public"."duplicate_candidate_status" AS ENUM('pending', 'same', 'different');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"kind" "job_source_kind" NOT NULL,
	"label" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"consent_confirmed_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_run_status" "ingestion_run_status",
	"last_error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "ingestion_run_status" DEFAULT 'running' NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"closed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"error_class" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_job_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"company_name" text NOT NULL,
	"company_key" text NOT NULL,
	"title" text NOT NULL,
	"title_key" text NOT NULL,
	"seniority" text,
	"location_raw" text,
	"location_key" text DEFAULT '' NOT NULL,
	"country_code" text,
	"work_mode" "job_work_mode" DEFAULT 'unknown' NOT NULL,
	"employment_type" text,
	"description_text" text DEFAULT '' NOT NULL,
	"description_hash" text NOT NULL,
	"salary_raw" text,
	"salary_min" numeric,
	"salary_max" numeric,
	"salary_currency" text,
	"salary_period" "salary_period",
	"salary_is_parsed" boolean DEFAULT false NOT NULL,
	"min_experience_years" integer,
	"min_experience_evidence" text,
	"sponsorship" "job_sponsorship" DEFAULT 'unknown' NOT NULL,
	"sponsorship_evidence" text,
	"sponsorship_conflict" boolean DEFAULT false NOT NULL,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"status" "job_status" DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"fingerprint" text NOT NULL,
	"content_hash" text NOT NULL,
	"normalized" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_duplicate_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"job_id_a" uuid NOT NULL,
	"job_id_b" uuid NOT NULL,
	"similarity" real NOT NULL,
	"status" "duplicate_candidate_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_job_postings" ADD CONSTRAINT "raw_job_postings_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_duplicate_candidates" ADD CONSTRAINT "job_duplicate_candidates_job_id_a_jobs_id_fk" FOREIGN KEY ("job_id_a") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_duplicate_candidates" ADD CONSTRAINT "job_duplicate_candidates_job_id_b_jobs_id_fk" FOREIGN KEY ("job_id_b") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "raw_job_postings_source_external_uniq" ON "raw_job_postings" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_postings_source_external_uniq" ON "job_postings" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_duplicate_candidates_pair_uniq" ON "job_duplicate_candidates" USING btree ("job_id_a","job_id_b");