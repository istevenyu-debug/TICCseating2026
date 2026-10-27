ALTER TABLE "notification" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text DEFAULT '' NOT NULL
);--> statement-breakpoint
UPDATE "notification" SET "status" = 'simulated' WHERE "status" = 'queued';
