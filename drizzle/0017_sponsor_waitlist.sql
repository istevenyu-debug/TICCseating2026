ALTER TABLE "event" ALTER COLUMN "hold_minutes" SET DEFAULT 1440;--> statement-breakpoint
ALTER TABLE "combo" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "preorder" ADD COLUMN "waitlist" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "event" SET "hold_minutes" = 1440;
