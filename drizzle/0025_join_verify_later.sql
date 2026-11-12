ALTER TABLE "join_reg" ADD COLUMN "pick_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "join_report" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "join_report" ADD COLUMN "era_qty" integer;--> statement-breakpoint
ALTER TABLE "join_report" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
UPDATE "join_report" r SET "status" = CASE WHEN e."status" <> 'sold' THEN 'refunded' WHEN e."qty" <> r."qty" THEN 'mismatch' ELSE 'ok' END, "era_qty" = e."qty", "checked_at" = now() FROM "join_era" e WHERE e."event_id" = r."event_id" AND e."order_no" = r."order_no";
