CREATE TABLE IF NOT EXISTS "checkin_practice" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"gate_id" integer,
	"key" text,
	"serial" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"result" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"raw" text DEFAULT '' NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crew" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"friend" boolean DEFAULT false NOT NULL,
	"gate_id" integer,
	"mail_notif_id" integer,
	"mailed_gate" text DEFAULT '' NOT NULL,
	"line_at" timestamp with time zone,
	"removed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gate" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gate" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkin_practice" ADD CONSTRAINT "checkin_practice_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew" ADD CONSTRAINT "crew_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checkin_practice_key_idx" ON "checkin_practice" USING btree ("event_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crew_code_idx" ON "crew" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crew_email_idx" ON "crew" USING btree ("event_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crew_gate_idx" ON "crew" USING btree ("gate_id");