-- Dashboard + webmail: users, roles (RBAC), sessions, audit log, mailboxes,
-- per-mailbox message state, and bodies of sent emails. Additive only.

CREATE TABLE roles (
  key TEXT PRIMARY KEY,                    -- a-z0-9-, e.g. "developer"
  name TEXT NOT NULL,
  description TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,      -- built-in roles cannot be deleted
  created_at INTEGER NOT NULL
);

CREATE TABLE role_permissions (
  role_key TEXT NOT NULL REFERENCES roles (key) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_key, permission)
);

-- "admin" has every permission in code (src/permissions.ts), so it has no rows.
INSERT INTO roles (key, name, description, builtin, created_at) VALUES
  ('admin', 'Admin', 'Everything, including users and roles', 1, 0),
  ('developer', 'Developer', 'API keys, webhooks, email logs, own mailboxes', 1, 0),
  ('member', 'Member', 'Webmail for the mailboxes assigned to them', 1, 0);
INSERT INTO role_permissions (role_key, permission) VALUES
  ('developer', 'emails:view'),
  ('developer', 'emails:send'),
  ('developer', 'domains:view'),
  ('developer', 'api_keys:manage'),
  ('developer', 'webhooks:manage'),
  ('developer', 'mail:use'),
  ('member', 'mail:use');

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,              -- lowercased login
  name TEXT NOT NULL,
  role TEXT NOT NULL REFERENCES roles (key),
  password_hash TEXT,                      -- pbkdf2$iter$salt$hash; NULL until invite accepted
  disabled_at INTEGER,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,         -- HMAC of the cookie token
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- One-time links: invite (7 days) and password reset (1 hour).
CREATE TABLE user_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX user_tokens_user ON user_tokens (user_id, purpose);

CREATE TABLE auth_failures (
  email TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX auth_failures_email ON auth_failures (email, at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,                           -- users.id (NULL = system)
  actor_email TEXT,
  action TEXT NOT NULL,                    -- e.g. user.invite, api_key.create
  target TEXT,
  detail TEXT,                             -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_created ON audit_log (created_at DESC);

-- Webmail. A mailbox is one address ("sales@example.com") or a catch-all
-- ("*@example.com"). Inbound mail is filed by its envelope recipient.
CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,            -- lowercased
  name TEXT NOT NULL,                      -- display name used in From
  signature TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE mailbox_members (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  can_send INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mailbox_id, user_id)
);
CREATE INDEX mailbox_members_user ON mailbox_members (user_id);

-- One row per message per mailbox: folder, read and star state are per mailbox.
CREATE TABLE mail_messages (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  email_id TEXT NOT NULL,                  -- received_emails.id or sent_emails.id
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'archive', 'spam', 'trash')),
  prev_folder TEXT,
  message_id TEXT,                         -- Message-ID without <>
  thread_key TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_json TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  sent_by TEXT,                            -- users.id for outbound
  read_at INTEGER,
  starred INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (mailbox_id, direction, email_id)
);
CREATE INDEX mail_messages_folder ON mail_messages (mailbox_id, folder, created_at DESC);
CREATE INDEX mail_messages_thread ON mail_messages (mailbox_id, thread_key, created_at);
CREATE INDEX mail_messages_msgid ON mail_messages (mailbox_id, message_id);

-- Bodies of sent emails (GET /emails/:id returns html/text, like Resend).
CREATE TABLE sent_bodies (
  email_id TEXT PRIMARY KEY REFERENCES sent_emails (id) ON DELETE CASCADE,
  html TEXT,
  text TEXT,
  reply_to TEXT,
  message_id TEXT,                         -- requested Message-ID, without <>
  attachments_json TEXT                    -- [{filename, content_type, size}]
);

ALTER TABLE sent_emails ADD COLUMN user_id TEXT;  -- set when sent from webmail/dashboard
