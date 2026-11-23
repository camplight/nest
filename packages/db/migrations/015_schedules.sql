-- Schedules, their runs and webhook triggers. Product-owned; ids and settings only.
-- Each run is booked in the engine as one agent.scheduled.trigger event; the engine's events are never mirrored.
CREATE TABLE product_schedules (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  on_flag INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  next_event_id TEXT,
  paused_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX product_schedules_channel ON product_schedules(channel_id);
CREATE INDEX product_schedules_creator ON product_schedules(created_by);
CREATE TABLE product_schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES product_schedules(id) ON DELETE CASCADE,
  due_at INTEGER NOT NULL,
  event_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('scheduled','manual')),
  status TEXT NOT NULL CHECK (status IN ('booked','started','missed','late','superseded')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (schedule_id, kind, due_at)
);
CREATE INDEX product_schedule_runs_status ON product_schedule_runs(status, due_at);
-- Webhook triggers (the store arrives with the webhook routes). Only a sha256 of the token is kept.
CREATE TABLE product_triggers (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  on_flag INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL
);
CREATE INDEX product_triggers_channel ON product_triggers(channel_id);
