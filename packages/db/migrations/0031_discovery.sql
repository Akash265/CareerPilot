CREATE TYPE "public"."discovered_board_status" AS ENUM('pending', 'enabled', 'rejected', 'gone');--> statement-breakpoint
CREATE TYPE "public"."job_source_origin" AS ENUM('manual', 'discovered', 'search');--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'ashby';--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'workable';--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'smartrecruiters';--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'recruitee';--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'adzuna';--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'jooble';--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'usajobs';--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'themuse';--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'remotive';--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'remoteok';--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'arbeitnow';--> statement-breakpoint
ALTER TYPE "public"."job_source_kind" ADD VALUE 'hn_hiring';--> statement-breakpoint
CREATE TABLE "discovered_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"kind" "job_source_kind" NOT NULL,
	"slug" text NOT NULL,
	"status" "discovered_board_status" DEFAULT 'pending' NOT NULL,
	"found_via_source_id" uuid,
	"source_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "discovery_settings" (
	"user_id" uuid PRIMARY KEY DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"auto_discover" boolean DEFAULT false NOT NULL,
	"consented_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_sources" ADD COLUMN "origin" "job_source_origin" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovered_boards" ADD CONSTRAINT "discovered_boards_found_via_source_id_job_sources_id_fk" FOREIGN KEY ("found_via_source_id") REFERENCES "public"."job_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_boards" ADD CONSTRAINT "discovered_boards_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovered_boards_found_via_source_id_idx" ON "discovered_boards" USING btree ("found_via_source_id") WHERE "discovered_boards"."found_via_source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "discovered_boards_source_id_idx" ON "discovered_boards" USING btree ("source_id") WHERE "discovered_boards"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "discovered_boards_user_status_idx" ON "discovered_boards" USING btree ("user_id","status");