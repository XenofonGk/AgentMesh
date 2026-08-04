CREATE TYPE "public"."attempt_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" "attempt_status" DEFAULT 'pending' NOT NULL,
	"container_id" text,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"outcome" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_grants" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task" text NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_grants" ADD CONSTRAINT "run_grants_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_grants" ADD CONSTRAINT "run_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_run_id_provider_idx" ON "attempts" USING btree ("run_id","provider");--> statement-breakpoint
CREATE INDEX "attempts_run_id_idx" ON "attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_grants_attempt_id_idx" ON "run_grants" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "run_grants_expires_at_idx" ON "run_grants" USING btree ("expires_at");