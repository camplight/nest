-- App-event triggers (Composio) live beside webhook triggers. An app trigger has no token: its token_hash is
-- `app:<id>`, which no webhook call can produce (those are 64 hex characters), and its token_hint is ''.
-- composio_trigger_id is the Composio trigger instance; connected_account_id is the creator's account it runs on.
ALTER TABLE product_triggers ADD COLUMN kind TEXT NOT NULL DEFAULT 'webhook' CHECK (kind IN ('webhook','app'));
ALTER TABLE product_triggers ADD COLUMN app_slug TEXT;
ALTER TABLE product_triggers ADD COLUMN trigger_slug TEXT;
ALTER TABLE product_triggers ADD COLUMN composio_trigger_id TEXT;
ALTER TABLE product_triggers ADD COLUMN connected_account_id TEXT;
ALTER TABLE product_triggers ADD COLUMN trigger_config_json TEXT;
CREATE UNIQUE INDEX product_triggers_composio ON product_triggers(composio_trigger_id) WHERE composio_trigger_id IS NOT NULL;
-- Composio event ids already delivered, for dedupe; rows older than 7 days are pruned as new events arrive.
CREATE TABLE product_app_trigger_events (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE INDEX product_app_trigger_events_received ON product_app_trigger_events(received_at);
