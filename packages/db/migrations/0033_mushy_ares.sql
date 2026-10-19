CREATE TYPE "public"."board_found_via" AS ENUM('posting_link', 'pasted', 'name_probe', 'web_search');--> statement-breakpoint
CREATE TYPE "public"."search_run_status" AS ENUM('queued', 'running', 'matching', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "search_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"status" "search_run_status" DEFAULT 'queued' NOT NULL,
	"goal_constraints_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seeding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text
);
--> statement-breakpoint
ALTER TABLE "discovered_boards" ADD COLUMN "found_via" "board_found_via" DEFAULT 'posting_link' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovered_boards" ADD COLUMN "expected_company" text;--> statement-breakpoint
ALTER TABLE "discovered_boards" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "discovery_settings" ADD COLUMN "last_web_search_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discovery_settings" ADD COLUMN "last_web_search_goal_id" uuid;--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_goal_constraints_id_career_goal_constraints_id_fk" FOREIGN KEY ("goal_constraints_id") REFERENCES "public"."career_goal_constraints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_runs_goal_constraints_id_idx" ON "search_runs" USING btree ("goal_constraints_id") WHERE "search_runs"."goal_constraints_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "search_runs_user_created_idx" ON "search_runs" USING btree ("user_id","created_at");--> statement-breakpoint
-- Phase 13a backfill: boards found before this migration came from a posting link, or were pasted (no source).
UPDATE "discovered_boards" SET "found_via" = 'pasted' WHERE "found_via_source_id" IS NULL;
