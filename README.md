<div align="center">

# cfmail

**Your own email platform on Cloudflare: a Resend-compatible API, a dashboard
and a team webmail, in one Worker.**

[![CI](https://github.com/eanp/cfmail/actions/workflows/ci.yml/badge.svg)](https://github.com/eanp/cfmail/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Runs on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f6821f)

[English](README.md) · [Bahasa Indonesia](README.id.md)

</div>

- **Receive** mail for your domains through Cloudflare Email Routing. Mail is
  parsed, stored in D1 (attachments in R2 or D1), and pushed to your apps as
  signed webhooks. Receiving is free and has no volume limit.
- **Send** through Cloudflare Email Sending, or relay to Resend, with the same
  request body Resend uses: `POST /emails`, batches, idempotency keys and
  attachments.
- **Drop-in API**: paths, JSON shapes, errors, API key permissions and
  Svix-signed webhooks match Resend. An existing app switches by changing the
  base URL and the API key.
- **Dashboard**: emails sent and received, domains, API keys, webhooks with a
  delivery log, and an overview.
- **Webmail for your team**: mailboxes such as `sales@` or a catch-all,
  conversations, folders, stars, search, reply, forward and attachments.
- **Users and roles (RBAC)**: invite people, build roles from fine-grained
  permissions, and keep an audit log of every change.

Everything runs in your Cloudflare account. Your mail is kept as long as you
want, in your own D1 database and R2 bucket.

## How it fits together

```
sender ──SMTP──▶ Cloudflare MX ──▶ email()  ─┐
                                            ├─▶ D1 (+R2) ──▶ webhooks ──▶ your apps
your app ──HTTPS + API key──▶ /emails ───────┤
                                            └─▶ Email Sending ──▶ recipients
your team ──browser──▶ /app/ (dashboard + webmail, cookie session)
```

One Worker is enough for the API, the dashboard and the webmail. The UI is
static files served by Workers Static Assets, and asset requests are free. See
[docs/architecture.md](docs/architecture.md#one-worker-or-two) for when you
might split it.

## Quick start (local)

Requires Node.js 22+.

```bash
git clone https://github.com/eanp/cfmail && cd cfmail
npm install
cp .dev.vars.example .dev.vars            # SEND_MODE=log: nothing is really sent
npm run db:migrate:local
node scripts/create-admin.mjs you@example.com "Your Name" > admin.sql
npx wrangler d1 execute DB --local --file admin.sql && rm admin.sql
npm run dev                                # http://localhost:8787/app/
```

Simulate an incoming email:

```bash
curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=a@outside.com&to=sales@example.com" \
  --data-binary @message.eml
```

Deploying to your own account takes about 15 minutes:
[docs/setup.md](docs/setup.md).

## Use it from your app

With the official Resend Node SDK, point it at cfmail through the environment:

```bash
RESEND_BASE_URL=https://mail.example.com   # your cfmail hostname
RESEND_API_KEY=cfm_...                     # a cfmail API key
```

```ts
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
await resend.emails.send({
  from: "Example <hello@example.com>",
  to: "customer@gmail.com",
  subject: "Welcome",
  html: "<p>Hi!</p>",
});
```

Or call it with plain HTTP. See [docs/api.md](docs/api.md) for every endpoint
and the full compatibility table.

## Documentation

| Doc                                                  | What's inside                                               |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)         | Components, data flow, storage, one Worker or two           |
| [docs/setup.md](docs/setup.md)                       | Deploy from zero: D1, secrets, Email Sending, Email Routing |
| [docs/api.md](docs/api.md)                           | REST API, webhooks, errors, Resend compatibility table      |
| [docs/dashboard.md](docs/dashboard.md)               | Dashboard, webmail, mailboxes, users, roles and permissions |
| [docs/limits-and-costs.md](docs/limits-and-costs.md) | Cloudflare limits and pricing, cost examples, known risks   |
| [docs/security.md](docs/security.md)                 | Threat model, sessions, CSRF, HTML sandboxing, secrets      |

Changes: [CHANGELOG.md](CHANGELOG.md). Contributing:
[CONTRIBUTING.md](CONTRIBUTING.md). Security reports:
[SECURITY.md](SECURITY.md).

## Status

`0.2.0`, used in production by its author. Cloudflare Email Sending is still in
**beta** and needs **Workers Paid** ($5/month) to send to any address. Without
it, use `SEND_MODE=resend` to keep receiving for free on Cloudflare while
sending through Resend. Read
[docs/limits-and-costs.md](docs/limits-and-costs.md) before you rely on it.

Not included yet: delivery events (`email.delivered`, `email.bounced`,
opens/clicks), scheduled sending, contacts/broadcasts, IMAP/SMTP access and 2FA.

## License

[MIT](LICENSE)
