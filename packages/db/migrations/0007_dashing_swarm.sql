ALTER TABLE "attempts" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;