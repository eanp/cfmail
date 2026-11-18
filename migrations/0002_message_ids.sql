-- Map Cloudflare-assigned Message-IDs back to the Message-ID the app asked
-- for (Email Sending does not allow a custom Message-ID header). Inbound
-- In-Reply-To / References are rewritten with this so app threading works.
CREATE TABLE message_ids (
  provider_message_id TEXT PRIMARY KEY,   -- without angle brackets
  requested_message_id TEXT NOT NULL,     -- without angle brackets
  created_at INTEGER NOT NULL
);
