ALTER TABLE "event" ADD COLUMN "public_sale_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "public_per_phone" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_link" ADD COLUMN "kind" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "visitor_id" text;