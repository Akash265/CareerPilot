-- Superseded by the unique index below, which also serves every equality lookup the plain index did.
DROP INDEX IF EXISTS "ats_evaluations_resume_optimization_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ats_evaluations_resume_optimization_id_uniq" ON "ats_evaluations" USING btree ("resume_optimization_id");--> statement-breakpoint
ALTER TABLE "ats_evaluations" ADD CONSTRAINT "ats_evaluations_required_keyword_coverage_range" CHECK ("ats_evaluations"."required_keyword_coverage" >= 0 AND "ats_evaluations"."required_keyword_coverage" <= 1);--> statement-breakpoint
ALTER TABLE "ats_evaluations" ADD CONSTRAINT "ats_evaluations_preferred_keyword_coverage_range" CHECK ("ats_evaluations"."preferred_keyword_coverage" >= 0 AND "ats_evaluations"."preferred_keyword_coverage" <= 1);--> statement-breakpoint
ALTER TABLE "ats_evaluations" ADD CONSTRAINT "ats_evaluations_semantic_similarity_range" CHECK ("ats_evaluations"."semantic_similarity" IS NULL OR ("ats_evaluations"."semantic_similarity" >= 0 AND "ats_evaluations"."semantic_similarity" <= 1));--> statement-breakpoint
ALTER TABLE "ats_evaluations" ADD CONSTRAINT "ats_evaluations_factual_consistency_range" CHECK ("ats_evaluations"."factual_consistency" >= 0 AND "ats_evaluations"."factual_consistency" <= 1);--> statement-breakpoint
ALTER TABLE "ats_evaluations" ADD CONSTRAINT "ats_evaluations_action_verb_score_range" CHECK ("ats_evaluations"."action_verb_score" >= 0 AND "ats_evaluations"."action_verb_score" <= 1);--> statement-breakpoint
ALTER TABLE "ats_evaluations" ADD CONSTRAINT "ats_evaluations_machine_readability_score_range" CHECK ("ats_evaluations"."machine_readability_score" >= 0 AND "ats_evaluations"."machine_readability_score" <= 1);--> statement-breakpoint
ALTER TABLE "ats_evaluations" ADD CONSTRAINT "ats_evaluations_overall_score_range" CHECK ("ats_evaluations"."overall_score" >= 0 AND "ats_evaluations"."overall_score" <= 100);
