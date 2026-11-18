CREATE TABLE IF NOT EXISTS "join_gift" (
	"slot_id" integer PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"option_key" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"ver" integer DEFAULT 1 NOT NULL,
	"code" text NOT NULL,
	"chosen_by" text DEFAULT '' NOT NULL,
	"chosen_at" timestamp with time zone,
	"mailed_to" text DEFAULT '' NOT NULL,
	"mailed_ver" integer DEFAULT 0 NOT NULL,
	"mailed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "join_reg" ADD COLUMN "gift_sent_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_gift" ADD CONSTRAINT "join_gift_slot_id_join_slot_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."join_slot"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_gift" ADD CONSTRAINT "join_gift_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_gift_code_idx" ON "join_gift" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "join_gift_event_idx" ON "join_gift" USING btree ("event_id");