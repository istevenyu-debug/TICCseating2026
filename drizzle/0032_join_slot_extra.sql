ALTER TABLE "join_slot" ADD COLUMN "extra_min" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "join_slot" ADD COLUMN "draft" text DEFAULT '' NOT NULL;