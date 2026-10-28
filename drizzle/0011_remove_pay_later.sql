-- 一律先匯款再劃位；公開劃位連結停用（公開入口改為預購單）
UPDATE "event" SET "pay_first" = true;--> statement-breakpoint
UPDATE "invite_link" SET "status" = 'disabled' WHERE "kind" = 'public';--> statement-breakpoint
UPDATE "orders" SET "pay_due_at" = NULL WHERE "status" = 'pending';
