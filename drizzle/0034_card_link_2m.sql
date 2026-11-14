CREATE TABLE IF NOT EXISTS "card_link" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"combo_ids" jsonb NOT NULL,
	"max_sets" integer DEFAULT 0 NOT NULL,
	"policy" text DEFAULT 'transfer' NOT NULL,
	"transfer_days" integer DEFAULT 3 NOT NULL,
	"refund_days" integer DEFAULT 10 NOT NULL,
	"refund_fee_pct" integer DEFAULT 10 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_order" ADD COLUMN "floor" text DEFAULT '3F' NOT NULL;--> statement-breakpoint
ALTER TABLE "card_order" ADD COLUMN "card_link_id" integer;--> statement-breakpoint
ALTER TABLE "card_order" ADD COLUMN "terms" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_link" ADD COLUMN "paid_card" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_link" ADD CONSTRAINT "card_link_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "card_link_code_idx" ON "card_link" USING btree ("code");