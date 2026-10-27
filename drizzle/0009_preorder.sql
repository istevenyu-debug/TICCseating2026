ALTER TABLE "event" ADD COLUMN "preorder_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "preorder" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"no" text NOT NULL,
	"items" jsonb NOT NULL,
	"amount" integer NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"paid_amount" integer NOT NULL,
	"last5" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"link_id" integer,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"seen_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "preorder" ADD CONSTRAINT "preorder_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "preorder" ADD CONSTRAINT "preorder_link_id_invite_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."invite_link"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "preorder_no_idx" ON "preorder" USING btree ("no");
