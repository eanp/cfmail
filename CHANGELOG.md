# Changelog

All notable changes are listed here. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[SemVer](https://semver.org/).

## [Unreleased]

## [0.2.0] — 2026-11-18

### Added

- Dashboard at `/app/` (one Worker, served as static assets): overview with
  14-day chart, sent/received email logs with preview and raw JSON, test send,
  domains, API keys, webhooks with delivery log and retry.
- Team webmail: mailboxes (address or catch-all), members with send rights,
  conversations, folders (inbox, starred, sent, archive, spam, trash), search,
  compose / reply / reply all / forward with attachments, signatures, sandboxed
  HTML with remote images blocked by default.
- Users and roles (RBAC): 11 permissions, built-in `admin`, `developer`,
  `member` roles, custom roles, invite and reset links (emailed when
  `SYSTEM_FROM` is set), sign-in lockout, audit log, escalation guards.
- `GET /emails` (list sent emails); `GET /emails/:id` now returns `html`, `text`
  and `reply_to`.
- `scripts/create-admin.mjs` for the first admin and account recovery.
- Migration `0003_console.sql` (additive).

### Changed

- Inbound mail is filed into matching webmail mailboxes on arrival.
- Deleting a received email through the API also removes it from webmail.

## [0.1.0] — 2026-11-15

### Added

- Resend-compatible Worker: `POST /emails`, `POST /emails/batch`
  (Idempotency-Key), `GET /emails/:id`, received emails (`/emails/receiving`,
  attachments with signed `download_url`), webhooks (CRUD, delivery history,
  retry), `/domains`, `/api-keys`.
- Inbound via Email Routing (`email()` handler): postal-mime parsing,
  SPF/DKIM/DMARC from Cloudflare's `Authentication-Results`, D1 storage,
  attachments in R2 (optional) or D1 (≤ 1.5 MB).
- Svix-format webhook signatures, 7 attempts with backoff.
- Send modes `cloudflare` (send_email binding), `resend` (relay), `log`.
- Custom `Message-ID` handling: sent without the header (refused by Email
  Sending), replies rewritten to the requested id so threading keeps working.
- API keys `full_access` / `sending_access`, SHA-256 hashed;
  `scripts/create-key.mjs`.
