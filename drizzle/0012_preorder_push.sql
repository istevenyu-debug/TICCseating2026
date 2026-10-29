-- 預購單：送出時給訂購人的裝置一組隨機查詢碼，用來查進度、收推播
ALTER TABLE "preorder" ADD COLUMN "view_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "preorder_view_token_idx" ON "preorder" ("view_token");--> statement-breakpoint
ALTER TABLE "push_sub" ALTER COLUMN "link_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "push_sub" ADD COLUMN "preorder_id" integer REFERENCES "preorder"("id") ON DELETE CASCADE;
