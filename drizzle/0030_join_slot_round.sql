ALTER TABLE "join_slot" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "join_slot" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;