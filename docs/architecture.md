# Architecture

cfmail is one Cloudflare Worker with three entry points, a D1 database and an
optional R2 bucket.

```
                     ┌──────────────────────────── cfmail Worker ────────────────────────────┐
outside sender ─SMTP─▶ Cloudflare MX ─▶ email()  ─▶ postal-mime ─▶ D1 (+R2) ─┬▶ mailboxes (webmail)
                     │                                                       └▶ webhook email.received ─▶ apps
apps ─HTTPS, API key─▶ fetch(): /emails, /webhooks, … ─▶ Email Sending ─▶ recipients
                     │          /attachments/:id?sig  (signed download links)
team ─browser────────▶ static /app/ (HTML, JS, CSS) + fetch(): /app/api/* (cookie session, RBAC)
                     │ scheduled() (optional cron): webhook retries
                     └─────────────────────────────────────────────────────────────────────────┘
```

| Piece                   | Where                                          | What it does                                                                                  |
| ----------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `email()` handler       | `src/inbound.ts`                               | Parses each incoming message and stores it. Files it into webmail. Emits `email.received`     |
| Resend-compatible API   | `src/index.ts`, `send.ts`, `received.ts`       | Send, batch, read sent/received mail, attachments, webhooks, API keys                         |
| Webhooks                | `src/webhooks.ts`                              | Svix-signed delivery, retried 7 times with backoff                                            |
| Dashboard / webmail API | `src/console.ts`, `mail.ts`                    | `/app/api/*`: sessions, users, roles, mailboxes, conversations, compose                       |
| RBAC                    | `src/permissions.ts`, `session.ts`, `audit.ts` | Permission catalogue, sessions, audit log                                                     |
| UI                      | `ui/` → `public/app/`                          | Preact single-page app, bundled by esbuild, served as static assets                           |
| Storage                 | D1 (`migrations/`), R2 (optional)              | Mail, attachments ≤ 1.5 MB (without R2), users, keys, webhooks; R2 holds attachments + `.eml` |

## Data model (short)

- **API side**:
  - `received_emails` and `received_attachments` hold inbound mail.
  - `sent_emails` and `sent_bodies` hold outbound mail.
  - `api_keys` stores only the SHA-256 hash of each key.
  - `webhooks` and `webhook_deliveries` hold endpoints and their delivery log.
  - `idempotency` stores responses for 24 hours.
  - `message_ids` is described under
    [Threading and Message-ID](#threading-and-message-id).
- **Dashboard side**:
  - `users`, `roles`, `role_permissions`, `sessions`, `user_tokens` (invite and
    reset links), `auth_failures` and `audit_log`.
- **Webmail**:
  - `mailboxes` holds addresses and catch-alls.
  - `mailbox_members` records who can read a mailbox and who can send from it.
  - `mail_messages` has one row per message per mailbox. Folder, read state and
    stars live here. The row points at the stored email; the body itself is
    never copied.

Migrations are additive and are never edited after release.

## Inbound flow

1. Email Routing delivers a message to the Worker, once per envelope recipient.
2. Mail for a domain outside `INBOUND_DOMAINS` is rejected at SMTP time.
3. `postal-mime` parses the message. SPF, DKIM and DMARC verdicts are read from
   Cloudflare's `Authentication-Results` header.
4. Text and HTML go to D1, capped at 800,000 characters (`truncated: true` when
   cut). Attachments go to R2, or to D1 if they are 1.5 MB or less. The raw
   `.eml` is saved to R2 when a bucket is bound.
5. **Webmail filing**: the envelope recipient is matched against mailboxes. An
   exact address wins; otherwise a catch-all `*@domain` mailbox is used. The
   message joins the conversation of any message it references through
   `In-Reply-To` or `References`. If DMARC fails, or SPF and DKIM both fail, it
   goes to Spam.
6. `email.received` is queued for every subscribed webhook and delivered right
   away. Failures retry later.

A message with no matching mailbox is still stored and still visible through the
API and the dashboard's Emails page.

## Outbound flow

`POST /emails` validates the body, sends it, records it with its body, and then
emits `email.sent` or `email.failed`. Webmail and dashboard test sends use the
same path, so their mail also shows up in the logs and webhooks.

`SEND_MODE` chooses the transport:

| Mode         | Transport                                     | Needs                                              |
| ------------ | --------------------------------------------- | -------------------------------------------------- |
| `cloudflare` | `send_email` binding (Email Sending)          | Workers Paid, domain onboarded in Email Sending    |
| `resend`     | `https://api.resend.com/emails`               | Secret `RESEND_API_KEY`, domain verified at Resend |
| `log`        | None: the message is recorded and logged only | Nothing (local development)                        |

## Threading and Message-ID

Email Sending refuses a custom `Message-ID` header. When an app or the webmail
asks for one, cfmail:

1. sends the message without that header;
2. stores Cloudflare's Message-ID next to the requested one (`message_ids`);
3. when a reply arrives, rewrites `In-Reply-To` and `References` back to the
   requested id.

Conversations in apps and in the webmail therefore keep working.

## One Worker or two?

**One Worker is enough** for the API, the dashboard and the webmail, and it is
the default:

- The UI is static files under `public/`. Workers Static Assets serves them
  before the Worker runs, and those requests are free and do not count as Worker
  requests.
- The API uses `Authorization: Bearer` keys and the dashboard uses a separate
  cookie (`Path=/app`, `SameSite=Strict`). The two never share credentials.
- A single deployment means a single migration path and a single set of bindings
  to keep in sync.

Split it only for a specific reason:

| Reason                                                     | How                                                                                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Different hostnames for API and webmail                    | No split needed: add two `routes` (e.g. `api.example.com` and `mail.example.com`) to the same Worker                                                                        |
| Put the dashboard behind Cloudflare Access (SSO)           | Protect the `/app/*` path, or a dashboard hostname, with an Access application. Leave the API and `/attachments/*` outside Access                                           |
| Independent deploys or a team-specific UI on another stack | Build your own UI against `/app/api/*` and the API, or deploy a second Worker that shares the same D1 database binding. Keep **one** Worker owning `email()` and migrations |

## Limits that shape the design

These limits are explained in [limits-and-costs.md](limits-and-costs.md):

- D1 rows are at most 2 MB, which is why bodies are capped and large attachments
  go to R2.
- Email Service allows 50 recipients, 32 attachments and 25 MiB per message.
- The batch endpoint is limited to 100 emails, and it sends them in order.
