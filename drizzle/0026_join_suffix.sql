ALTER TABLE "join_report" ALTER COLUMN "order_no" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "join_era" ADD COLUMN "sold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "join_report" ADD COLUMN "key" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "join_report" SET "key" = "order_no" WHERE "key" = '' AND "order_no" IS NOT NULL;
