-- 發票改為一筆訂單（收款）一張、可先核對再開；每場可設課稅別與品名；招待（VIP）劃位與排程寄送
ALTER TABLE "event" ADD COLUMN "inv_tax_type" text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "inv_item_name" text DEFAULT '入場券' NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "vip_notify_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "preorder_id" integer REFERENCES "preorder"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "checks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "issued_by" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_preorder_idx" ON "invoice" ("preorder_id");--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "vip" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "notify_mode" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "send_after" timestamp with time zone;--> statement-breakpoint
INSERT INTO "app_setting" ("key", "value") SELECT 'einv.mode', CASE WHEN "value" = 'prod' THEN 'prod' ELSE 'test' END FROM "app_setting" WHERE "key" = 'einv.env' ON CONFLICT DO NOTHING;
