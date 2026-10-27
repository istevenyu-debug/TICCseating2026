ALTER TABLE "event" ALTER COLUMN "max_per_order" SET DEFAULT 21;--> statement-breakpoint
UPDATE "event" SET "max_per_order" = 21 WHERE "max_per_order" = 6;
