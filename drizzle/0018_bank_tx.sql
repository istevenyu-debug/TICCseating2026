CREATE TABLE IF NOT EXISTS "bank_tx" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"amount" integer NOT NULL,
	"last5" text DEFAULT '' NOT NULL,
	"memo" text DEFAULT '' NOT NULL,
	"key" text NOT NULL,
	"ignored" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_tx" ADD CONSTRAINT "bank_tx_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bank_tx_key_idx" ON "bank_tx" USING btree ("event_id","key");