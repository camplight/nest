-- Webhook triggers that Nest paused (the creator can no longer post in the chat, the agent left, or the chat is gone)
-- carry why, for the creator's Needs you item; a person's pause leaves it NULL. updated_at orders those items.
ALTER TABLE product_triggers ADD COLUMN paused_reason TEXT;
ALTER TABLE product_triggers ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX product_triggers_creator ON product_triggers(created_by);
