CREATE TYPE "public"."event_review_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
ALTER TABLE "agent_events" ADD COLUMN "review_status" "event_review_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_events" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "agent_events" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;