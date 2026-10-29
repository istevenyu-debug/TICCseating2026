-- 電子發票（綠界）：預購單記錄發票開立方式；每筆劃位一張發票
ALTER TABLE "preorder" ADD COLUMN "inv_type" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "preorder" ADD COLUMN "inv_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "preorder" ADD COLUMN "inv_title" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer REFERENCES "orders"("id") ON DELETE SET NULL,
	"order_no" text NOT NULL,
	"env" text NOT NULL,
	"relate_number" text NOT NULL,
	"status" text NOT NULL,
	"invoice_no" text DEFAULT '' NOT NULL,
	"invoice_date" text DEFAULT '' NOT NULL,
	"random_number" text DEFAULT '' NOT NULL,
	"amount" integer NOT NULL,
	"buyer" text DEFAULT '' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_order_idx" ON "invoice" ("order_id");
