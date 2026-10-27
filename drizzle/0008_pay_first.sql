ALTER TABLE "event" ADD COLUMN "pay_first" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_link" ADD COLUMN "note" text DEFAULT '' NOT NULL;
