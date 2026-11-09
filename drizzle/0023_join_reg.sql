CREATE TABLE IF NOT EXISTS "join_leader" (
	"id" serial PRIMARY KEY NOT NULL,
	"reg_id" integer NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"no_email" boolean DEFAULT false NOT NULL,
	"same_as_head" boolean DEFAULT false NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "join_reg" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"venue_id" integer,
	"venue_text" text DEFAULT '' NOT NULL,
	"head_name" text NOT NULL,
	"head_phone" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "join_venue" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_leader" ADD CONSTRAINT "join_leader_reg_id_join_reg_id_fk" FOREIGN KEY ("reg_id") REFERENCES "public"."join_reg"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_reg" ADD CONSTRAINT "join_reg_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_reg" ADD CONSTRAINT "join_reg_venue_id_join_venue_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."join_venue"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_venue" ADD CONSTRAINT "join_venue_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_leader_code_idx" ON "join_leader" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "join_leader_phone_idx" ON "join_leader" USING btree ("phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "join_reg_status_idx" ON "join_reg" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_venue_code_idx" ON "join_venue" USING btree ("code");