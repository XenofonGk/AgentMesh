CREATE TYPE "public"."skill_version_status" AS ENUM('proposed', 'active', 'rejected');--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_name" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"status" "skill_version_status" DEFAULT 'proposed' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"eval_result" jsonb
);
--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_name_version_idx" ON "skill_versions" USING btree ("skill_name","version");--> statement-breakpoint
CREATE INDEX "skill_versions_name_idx" ON "skill_versions" USING btree ("skill_name");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_name_active_idx" ON "skill_versions" USING btree ("skill_name") WHERE "skill_versions"."status" = 'active';