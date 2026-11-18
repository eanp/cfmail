# Setup from zero

Run every command from the repository root, with Node.js 22+. If you work with
several Cloudflare accounts, check `npx wrangler whoami` before each step, or
set `account_id` in `wrangler.toml`.

## 0. Requirements

| Requirement                         | Why                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Domain on **Cloudflare DNS**        | Email Routing and Email Sending only work for zones on Cloudflare                                        |
| **Workers Paid** ($5/month/account) | Needed by Email Sending to send to any address. Without it, use `SEND_MODE=resend`, or only receive mail |
| R2 enabled (optional)               | Attachments larger than 1.5 MB, and copies of the original `.eml`                                        |

## 1. Database, secrets, configuration

```bash
npm install
npx wrangler d1 create cfmail            # copy database_id into wrangler.toml
openssl rand -base64 48 | npx wrangler secret put HASH_SECRET
# only for SEND_MODE=resend:
npx wrangler secret put RESEND_API_KEY
```

Edit `wrangler.toml`:

| Key                       | Example                           | Notes                                                                 |
| ------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| `routes`                  | `mail.example.com`, custom domain | Hostname for the API and the dashboard. `workers_dev` stays `false`   |
| `SEND_DOMAINS`            | `example.com`                     | Domains allowed in `from`                                             |
| `INBOUND_DOMAINS`         | `example.com`                     | Mail for other domains is rejected                                    |
| `SEND_MODE`               | `cloudflare` / `resend` / `log`   | See [architecture.md](architecture.md#outbound-flow)                  |
| `PUBLIC_ORIGIN`           | `https://mail.example.com`        | Used for attachment links, invite links and the CSRF origin check     |
| `SYSTEM_FROM`             | `cfmail <noreply@example.com>`    | Optional: emails invite and reset links. Empty = admins copy the link |
| `[[r2_buckets]]`          | `BUCKET` → `cfmail`               | Uncomment once you have run `wrangler r2 bucket create cfmail`        |
| `namespace_id` rate limit | `5101`                            | Must be unique within the account                                     |

`HASH_SECRET` signs attachment links and protects session and invite tokens.
Rotating it signs everyone out and invalidates open links.

## 2. Deploy

```bash
npm run deploy           # check → D1 migrations (remote) → wrangler deploy
curl https://mail.example.com/
# {"name":"cfmail","version":"0.2.0","sending":"cloudflare","attachments":"d1"}
```

## 3. First admin and first API key

```bash
node scripts/create-admin.mjs you@example.com "Your Name" > admin.sql
npx wrangler d1 execute DB --remote --file admin.sql && rm admin.sql
```

The temporary password is printed once. Sign in at
`https://mail.example.com/app/`, then change it under **Account**. Running the
script again for the same email resets that password and makes the user an
admin, which also serves as account recovery.

Create API keys in the dashboard (**API keys**). Without a dashboard, use
`node scripts/create-key.mjs "my app" > key.sql` and execute it the same way.

## 4. Sending: onboard the domain (Email Sending)

In the Cloudflare dashboard, open **Compute → Email Service → Email Sending →
Onboard Domain** and pick your domain. Cloudflare adds these records:

| Record                              | Value                                        |
| ----------------------------------- | -------------------------------------------- |
| `MX cf-bounce.<domain>`             | `route1/2/3.mx.cloudflare.net`               |
| `TXT cf-bounce.<domain>` (SPF)      | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| `TXT cf-bounce._domainkey.<domain>` | DKIM (managed by Cloudflare)                 |
| `TXT _dmarc.<domain>`               | DMARC (start with `p=none`, tighten later)   |

The sending records live under `cf-bounce`, so they coexist with another
provider's records. A new sending domain needs a few minutes before it is ready.
Until then, cfmail answers `503 service_unavailable`.

To test, send yourself an email from the dashboard (**Emails → Send test
email**). In Gmail, check that SPF, DKIM and DMARC show `pass`.

## 5. Receiving: Email Routing to the Worker

In the Cloudflare dashboard, open the zone, then **Email → Email Routing**, and
enable it. Under **Routing rules**, add an address or the **catch-all**, with
the action **Send to a Worker** and the Worker `cfmail`. You can instead list
the rules in `wrangler.toml` (`addresses = ["*@example.com"]`) and deploy.

**The root MX can only point to one place.** Enabling Email Routing moves the
domain's MX to Cloudflare, so mail stops arriving at any previous provider
(Google Workspace, another email API, …). Switch when you are ready.

To test, mail `test@<domain>` from any account, then check **Emails →
Received**.

## 6. Webmail for your team

1. **Mailboxes → New mailbox**: create `sales@example.com`, or the catch-all
   `*@example.com`.
2. **Users → Invite user**: pick a role. The invite link is emailed when
   `SYSTEM_FROM` is set; otherwise copy it from the dialog.
3. Open the mailbox again and tick its **members**. Untick **can send** for
   read-only access.

Details: [dashboard.md](dashboard.md).

## 7. Connect an app that uses Resend

Give the app a cfmail API key and point its Resend base URL at cfmail. For the
Node SDK, set `RESEND_BASE_URL=https://mail.example.com`. For plain HTTP,
replace `https://api.resend.com` with your hostname. For inbound mail, create a
webhook (**Webhooks → Add endpoint**) to the app's existing Resend webhook
handler. The Svix signature verifies the same way.

## Mixed setups

| Goal                                                | cfmail setting                        |
| --------------------------------------------------- | ------------------------------------- |
| Receive free on Cloudflare, keep sending via Resend | `SEND_MODE=resend` + `RESEND_API_KEY` |
| Everything on Cloudflare (Workers Paid)             | `SEND_MODE=cloudflare`                |
| Try it without sending                              | `SEND_MODE=log`                       |

The first option works on **Workers Free**:

- Email Routing is free on every plan.
- Resend's quota is then spent only on outgoing mail, because incoming mail no
  longer goes through Resend.

## Operations

- **Logs:** `npm run tail`. Look for `mail_received`, `email_send_failed`,
  `webhook_failed` and `mail_file_failed`.
- **Stuck webhooks:** open the delivery log under **Webhooks → endpoint**, fix
  the endpoint, then click **Retry due now**. You can also enable the cron
  `*/5 * * * *`; the Free plan allows 5 cron triggers per account.
- **Backup:**
  `npx wrangler d1 export DB --remote --output cfmail-$(date +%F).sql`. The file
  contains mail, so keep it outside the repository.
- **Send errors:**
  - `E_SENDER_DOMAIN_NOT_AVAILABLE`: the domain is not onboarded.
  - `E_DAILY_LIMIT_EXCEEDED`: the account's daily quota is used up. New accounts
    start low and grow over time.
- **Upgrades:** `git pull && npm install && npm run deploy`. Migrations apply
  automatically.
