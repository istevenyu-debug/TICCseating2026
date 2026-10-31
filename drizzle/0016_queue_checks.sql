ALTER TABLE "preorder" ADD COLUMN "line_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "preorder" ADD COLUMN "paid_ok_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "preorder" ADD COLUMN "paid_ok_by" text;--> statement-breakpoint
ALTER TABLE "preorder" ADD COLUMN "line_ok" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "preorder" ADD COLUMN "released" jsonb;