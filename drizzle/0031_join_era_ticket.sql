CREATE TABLE IF NOT EXISTS "join_era_ticket" (
	"event_id" integer NOT NULL,
	"ticket_no" text NOT NULL,
	"order_no" text NOT NULL,
	"floor" text DEFAULT '' NOT NULL,
	"row_no" text DEFAULT '' NOT NULL,
	"seat_no" text DEFAULT '' NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'sold' NOT NULL,
	"sold_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "join_era_ticket_event_id_ticket_no_pk" PRIMARY KEY("event_id","ticket_no")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "join_era_ticket" ADD CONSTRAINT "join_era_ticket_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
