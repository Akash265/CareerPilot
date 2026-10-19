CREATE TYPE "public"."skill_verification_status" AS ENUM('have', 'dont_have', 'alias');--> statement-breakpoint
CREATE TABLE "skill_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"term_key" text NOT NULL,
	"term_display" text NOT NULL,
	"status" "skill_verification_status" NOT NULL,
	"evidence" text,
	"alias_skill_name" text,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_verifications_fields_match_status" CHECK (("skill_verifications"."status" = 'have' AND "skill_verifications"."evidence" IS NOT NULL AND "skill_verifications"."alias_skill_name" IS NULL)
        OR ("skill_verifications"."status" = 'dont_have' AND "skill_verifications"."evidence" IS NULL AND "skill_verifications"."alias_skill_name" IS NULL)
        OR ("skill_verifications"."status" = 'alias' AND "skill_verifications"."evidence" IS NULL AND "skill_verifications"."alias_skill_name" IS NOT NULL)),
	CONSTRAINT "skill_verifications_evidence_length" CHECK ("skill_verifications"."evidence" IS NULL OR char_length(btrim("skill_verifications"."evidence")) BETWEEN 1 AND 300),
	CONSTRAINT "skill_verifications_term_length" CHECK (char_length("skill_verifications"."term_key") BETWEEN 1 AND 200 AND char_length(btrim("skill_verifications"."term_display")) BETWEEN 1 AND 200),
	CONSTRAINT "skill_verifications_alias_length" CHECK ("skill_verifications"."alias_skill_name" IS NULL OR char_length(btrim("skill_verifications"."alias_skill_name")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_verifications_user_term_uniq" ON "skill_verifications" USING btree ("user_id","term_key");