-- Nest send intent and notification receipts; message content remains in OrgOps.
CREATE TABLE product_message_requests (
 id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL,
 channel_id TEXT NOT NULL, input_hash TEXT NOT NULL, payload_hash TEXT NOT NULL,
 event_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, delivered_at INTEGER
);
CREATE TABLE product_mention_notifications (
 request_id TEXT NOT NULL REFERENCES product_message_requests(id),
 recipient_id TEXT NOT NULL, read_at INTEGER,
 PRIMARY KEY(request_id,recipient_id)
);
CREATE INDEX product_mentions_recipient ON product_mention_notifications(recipient_id,read_at);
