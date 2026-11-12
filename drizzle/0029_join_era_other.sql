ALTER TABLE "join_era" ADD COLUMN "other_qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "join_era" ADD COLUMN "other_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "join_report" ADD COLUMN "note" text DEFAULT '' NOT NULL;