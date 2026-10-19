ALTER TYPE "public"."generated_document_format" ADD VALUE 'tex';--> statement-breakpoint
ALTER TYPE "public"."generated_document_kind" ADD VALUE 'tailored_resume';--> statement-breakpoint
ALTER TABLE "generated_documents" DROP CONSTRAINT "generated_documents_source_matches_kind";--> statement-breakpoint
ALTER TABLE "generated_documents" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_tex_only_tailored" CHECK ("generated_documents"."format"::text <> 'tex' OR "generated_documents"."kind"::text = 'tailored_resume');--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_details_tailored_object" CHECK ("generated_documents"."details" IS NULL OR ("generated_documents"."kind"::text = 'tailored_resume' AND jsonb_typeof("generated_documents"."details") = 'object'));--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_source_matches_kind" CHECK (("generated_documents"."resume_optimization_id" IS NULL OR "generated_documents"."kind"::text IN ('resume', 'tailored_resume'))
        AND ("generated_documents"."application_pitch_id" IS NULL OR "generated_documents"."kind"::text = 'pitch')
        AND ("generated_documents"."cover_letter_id" IS NULL OR "generated_documents"."kind"::text = 'cover_letter')
        AND ("generated_documents"."interview_preparation_id" IS NULL OR "generated_documents"."kind"::text = 'interview_prep'));