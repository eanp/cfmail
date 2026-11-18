# Security policy

## Reporting a vulnerability

Please **don't** open a public issue. Use GitHub's private reporting: **Security
→ Report a vulnerability** on this repository.

You'll get a reply within 7 days. Include the cfmail version (`GET /` on your
deployment), what you did, and what happened.

## Scope

cfmail stores and serves email, API keys, webhook secrets and dashboard
accounts. Things we treat as security bugs:

- reading or changing mail, attachments, users, keys or webhooks without the
  required API key permission or dashboard permission;
- privilege escalation between roles, or bypassing the escalation guards;
- script execution or data access through email content (HTML, attachments,
  headers) shown in the dashboard or webmail;
- forging attachment, invite or reset links, or webhook signatures;
- secrets (API keys, passwords, tokens, `HASH_SECRET`) written to logs or
  returned where they should not be.

Out of scope: anyone who can already read your D1 database or your Cloudflare
account, and the limits documented in
[docs/security.md](docs/security.md#not-covered-yet).

## Supported versions

Only the latest release receives fixes.
