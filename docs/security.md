# Security model

## What is protected, and how

| Asset                | Protection                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API keys             | Random 32 bytes (`cfm_…`). Only the SHA-256 hash is stored. The token is shown once                                                                           |
| Dashboard passwords  | PBKDF2-SHA256, 100,000 iterations (the Workers runtime maximum), 16-byte salt. Unknown emails are checked against a dummy hash so timing does not reveal them |
| Sessions             | Random 32-byte cookie token. D1 stores only `HMAC(HASH_SECRET, token)`. 7-day maximum, 12 h idle timeout                                                      |
| Invite / reset links | Random 32-byte token, HMAC stored, one-time use, 7 days / 1 hour, older links of the same kind invalidated                                                    |
| Attachment links     | HMAC-signed URL with expiry (1 h; 30 min for inline images in webmail)                                                                                        |
| Webhook payloads     | Svix signature (HMAC-SHA256) with a per-endpoint `whsec_` secret                                                                                              |

## Browser

- **Cookie:** `cfm_session` is `HttpOnly` and `SameSite=Strict`. It is scoped to
  `Path=/app` and is `Secure` on https, so it is never sent to the public API.
- **CSRF:** `SameSite=Strict` cookies, and every non-GET `/app/api` request must
  carry an `Origin` equal to the Worker's own origin or `PUBLIC_ORIGIN`.
- **Dashboard CSP:** `public/_headers` sets the following on `/app/*`:
  - `script-src 'self'`, so there are no inline scripts;
  - `frame-ancestors 'none'`;
  - `object-src 'none'` and `base-uri 'none'`;
  - `X-Frame-Options: DENY` and `nosniff`.
- **Email HTML** is never inserted into the dashboard page. It loads in an
  iframe with `sandbox="allow-popups allow-popups-to-escape-sandbox"` (no
  scripts, no same-origin, no forms). The response has its own policy:
  `Content-Security-Policy: sandbox …; default-src 'none'; img-src data: <origin>`.
  Remote images are only allowed after the user clicks **Show images**.
- **Attachment downloads** use `Content-Disposition: attachment`, `nosniff` and
  `CSP: sandbox`.

## Authorization

- **API:** `sending_access` keys can only send. Everything else needs
  `full_access`.
- **Dashboard:**
  - Every route declares a permission, and there is no default allow.
  - Permissions are read from D1 on every request, so changes apply immediately.
  - The escalation rules (grant only what you hold, etc.) are listed in
    [dashboard.md](dashboard.md#roles-and-permissions-rbac).
- **Webmail:** a mailbox or message is only visible to its members. Any other ID
  answers 404, not 403, so it does not reveal that the mailbox or message
  exists.

## Abuse and rate limits

- **API:** 600 requests per minute per key (the `API_LIMIT` binding).
- **Sign-in:** 10 failures per email within 15 minutes locks that email until
  the window passes. Failure records older than 24 hours are pruned.
- **Forgot password:** at most one email per user per 10 minutes, and the same
  response whether or not the account exists.
- **Webmail:** 300 emails per user per day. Sends go through the same domain
  allow-list (`SEND_DOMAINS`) as the API.

## Secrets

| Secret           | Where                         | Rotation effect                                         |
| ---------------- | ----------------------------- | ------------------------------------------------------- |
| `HASH_SECRET`    | `wrangler secret put`         | Signs everyone out, invalidates attachment/invite links |
| `RESEND_API_KEY` | `wrangler secret put` (relay) | None for cfmail                                         |
| Webhook secrets  | D1 (needed to sign)           | Recreate the webhook to rotate                          |

Never commit `.dev.vars`, `*.sql` files containing keys or passwords, or D1
exports, which contain mail. All of these are already in `.gitignore`.

## Not covered yet

- Two-factor authentication. Until it lands, put Cloudflare Access (SSO, IdP
  MFA) in front of `/app/*`.
- Encryption at rest of webhook secrets beyond what D1 provides.
- Malware scanning of attachments.

Report vulnerabilities privately: see [SECURITY.md](../SECURITY.md).
