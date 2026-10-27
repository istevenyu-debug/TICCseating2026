ALTER TABLE "combo" ADD COLUMN "auto_holders" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "combo" SET "auto_holders" = true WHERE "name" LIKE '%功德%';
