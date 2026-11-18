-- cfmail schema. Additive migrations only; never edit an applied one.
-- Timestamps are epoch milliseconds.

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,          -- SHA-256 hex of the full key
  prefix TEXT NOT NULL,                   -- first chars, for display
  permission TEXT NOT NULL CHECK (permission IN ('full_access', 'sending_access')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE sent_emails (
  id TEXT PRIMARY KEY,
  api_key_id TEXT,
  from_addr TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT,
  bcc_json TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'logged')),
  provider_message_id TEXT,
  error_code TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX sent_emails_created ON sent_emails (created_at DESC);

CREATE TABLE idempotency (
  api_key_id TEXT NOT NULL,
  key TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (api_key_id, key)
);

CREATE TABLE received_emails (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  envelope_from TEXT,
  from_addr TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT,
  bcc_json TEXT,
  reply_to_json TEXT,
  received_for_json TEXT NOT NULL,
  subject TEXT,
  text TEXT,
  html TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  headers_json TEXT NOT NULL,
  auth_json TEXT,
  raw_key TEXT,                            -- R2 key of the original .eml
  raw_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX received_emails_created ON received_emails (created_at DESC, id DESC);

CREATE TABLE received_attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES received_emails (id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  disposition TEXT NOT NULL,
  content_id TEXT,
  size INTEGER NOT NULL,
  storage TEXT NOT NULL CHECK (storage IN ('r2', 'd1', 'none'))
);
CREATE INDEX received_attachments_email ON received_attachments (email_id);

CREATE TABLE attachment_blobs (
  attachment_id TEXT PRIMARY KEY REFERENCES received_attachments (id) ON DELETE CASCADE,
  data BLOB NOT NULL
);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  events_json TEXT NOT NULL,
  secret TEXT NOT NULL,                    -- whsec_… (needed to sign)
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  created_at INTEGER NOT NULL
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,                     -- also the svix-id header
  webhook_id TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_status INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at DESC);
