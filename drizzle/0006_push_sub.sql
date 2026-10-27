CREATE TABLE IF NOT EXISTS "push_sub" (
	"id" serial PRIMARY KEY NOT NULL,
	"link_id" integer NOT NULL,
	"visitor_id" text,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "push_sub" ADD CONSTRAINT "push_sub_link_id_invite_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."invite_link"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_sub_endpoint_idx" ON "push_sub" USING btree ("endpoint");
