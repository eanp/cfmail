# Contributing to cfmail

Thanks for helping! Issues and pull requests are welcome in English or Bahasa
Indonesia.

## Development setup

You need Node.js 22+. You do **not** need a Cloudflare account: `wrangler dev`
runs the Worker, D1 and the email handler locally.

```bash
npm install
cp .dev.vars.example .dev.vars        # SEND_MODE=log
npm run db:migrate:local
node scripts/create-admin.mjs you@example.com > admin.sql
npx wrangler d1 execute DB --local --file admin.sql && rm admin.sql
npm run dev                            # http://localhost:8787/app/
npm run check                          # typecheck + tests + prettier + UI build
```

Send yourself a message through the local Email Routing handler:

```bash
curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=a@b.com&to=sales@example.com" \
  --data-binary @message.eml
```

## Layout

```
src/index.ts        Worker entry: Resend-compatible API, email(), scheduled()
src/send.ts         validation + sending (cloudflare / resend / log)
src/inbound.ts      Email Routing handler: parse, store, file, webhook
src/received.ts     received-email API, signed attachment links
src/webhooks.ts     Svix-signed webhooks with retries
src/console.ts      dashboard API under /app/api (guards on every route)
src/mail.ts         webmail: mailboxes, threads, folders, compose
src/permissions.ts  RBAC catalogue (shared with the UI)
src/session.ts      cookie sessions, CSRF origin check
ui/                 Preact app → public/app/app.js (esbuild)
migrations/         D1 schema, additive only
```

## Rules of thumb

- **Keep the public API a strict subset of Resend's**: paths, JSON shapes, error
  shape and Svix signatures. Any difference goes in the compatibility table in
  `docs/api.md`.
- **Migrations are additive.** Never edit a migration that has been released;
  add a new one.
- **Every dashboard route declares a permission.** Escalation rules live in
  `src/console.ts`. Add a test when you touch them.
- **Never render email HTML in the dashboard origin.** Use the sandboxed body
  endpoint.
- **Limits and prices** for Cloudflare or Resend must come from official pages,
  with the date you read them, in `docs/limits-and-costs.md`.
- **Never commit secrets**: `.dev.vars`, generated `*.sql` with keys or
  passwords, D1 exports.
- Add a line to `CHANGELOG.md` under _Unreleased_ and update the doc you touch.
- Commit messages: short imperative subject; the body explains why.
