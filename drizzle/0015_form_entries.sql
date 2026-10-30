ALTER TABLE "preorder" ADD COLUMN "source" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "preorder" ADD COLUMN "form_id" text;--> statement-breakpoint
ALTER TABLE "preorder" ADD COLUMN "answers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "preorder_form_id_idx" ON "preorder" USING btree ("form_id");