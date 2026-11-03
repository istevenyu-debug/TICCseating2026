CREATE TABLE IF NOT EXISTS "card_order" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"trade_no" text NOT NULL,
	"token" text NOT NULL,
	"env" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"items" jsonb NOT NULL,
	"amount" integer NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"inv_type" text DEFAULT 'member' NOT NULL,
	"inv_code" text DEFAULT '' NOT NULL,
	"inv_title" text DEFAULT '' NOT NULL,
	"preorder_id" integer,
	"link_id" integer,
	"gw_trade_no" text DEFAULT '' NOT NULL,
	"gw_auth_no" text DEFAULT '' NOT NULL,
	"paid_via" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reserve_until" timestamp with time zone NOT NULL,
	"last_query_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"refund_amount" integer DEFAULT 0 NOT NULL,
	"refund_fee" integer DEFAULT 0 NOT NULL,
	"refund_by" text
);
--> statement-breakpoint
ALTER TABLE "combo" ADD COLUMN "floor" text DEFAULT '2M' NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_link" ADD COLUMN "floor" text DEFAULT '2M' NOT NULL;--> statement-breakpoint
ALTER TABLE "price_zone" ADD COLUMN "floor" text DEFAULT '2M' NOT NULL;--> statement-breakpoint
ALTER TABLE "venue_seat" ADD COLUMN "floor" text DEFAULT '2M' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_order" ADD CONSTRAINT "card_order_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "card_order_trade_no_idx" ON "card_order" USING btree ("trade_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "card_order_token_idx" ON "card_order" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_order_status_idx" ON "card_order" USING btree ("status");