CREATE TABLE IF NOT EXISTS "join_era" (
	"event_id" integer NOT NULL,
	"order_no" text NOT NULL,
	"qty" integer NOT NULL,
	"status" text DEFAULT 'sold' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "join_era_event_id_order_no_pk" PRIMARY KEY("event_id","order_no")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "join_report" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"reg_id" integer NOT NULL,
	"order_no" text NOT NULL,
	"qty" integer NOT NULL,
	"reporter" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "join_slot" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"reg_id" integer NOT NULL,
	"no" integer NOT NULL,
	"pos" double precision NOT NULL,
	"status" text DEFAULT 'wait' NOT NULL,
	"misses" integer DEFAULT 0 NOT NULL,
	"turn_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"soon_mailed" boolean DEFAULT false NOT NULL,
	"turn_mailed" boolean DEFAULT false NOT NULL,
	"seat_id" text,
	"rep_name" text DEFAULT '' NOT NULL,
	"rep_phone" text DEFAULT '' NOT NULL,
	"picked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "join_reg" ADD COLUMN "email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "join_reg" ADD COLUMN "report_code" text;--> statement-breakpoint
ALTER TABLE "join_reg" ADD COLUMN "pick_code" text;--> statement-breakpoint
ALTER TABLE "join_reg" ADD COLUMN "links_sent_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_era" ADD CONSTRAINT "join_era_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_report" ADD CONSTRAINT "join_report_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_report" ADD CONSTRAINT "join_report_reg_id_join_reg_id_fk" FOREIGN KEY ("reg_id") REFERENCES "public"."join_reg"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_slot" ADD CONSTRAINT "join_slot_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_slot" ADD CONSTRAINT "join_slot_reg_id_join_reg_id_fk" FOREIGN KEY ("reg_id") REFERENCES "public"."join_reg"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_report_order_idx" ON "join_report" USING btree ("event_id","order_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "join_report_reg_idx" ON "join_report" USING btree ("reg_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_slot_no_idx" ON "join_slot" USING btree ("event_id","no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_slot_seat_idx" ON "join_slot" USING btree ("event_id","seat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "join_slot_reg_idx" ON "join_slot" USING btree ("reg_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_reg_report_idx" ON "join_reg" USING btree ("report_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_reg_pick_idx" ON "join_reg" USING btree ("pick_code");