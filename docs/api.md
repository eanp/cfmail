# REST API

The base URL is your cfmail hostname (e.g. `https://mail.example.com`). Every
request uses JSON and the header `Authorization: Bearer cfm_…`.

The API follows Resend's paths, JSON shapes, error shape and webhook signatures,
so existing Resend clients and SDKs work once their base URL points at cfmail.
The parts that are not implemented are listed in the
[compatibility table](#compatibility-with-resend).

## API keys and permissions

| Permission       | Allowed                                      |
| ---------------- | -------------------------------------------- |
| `full_access`    | Every endpoint                               |
| `sending_access` | Only `POST /emails` and `POST /emails/batch` |

Create keys in the dashboard (**API keys**), with `POST /api-keys`, or for the
very first key with `scripts/create-key.mjs` (see [setup.md](setup.md)). Only
the SHA-256 hash of a key is stored, and the token is shown once.

## Endpoints

| Method & path                                | Permission | Notes                                                                                     |
| -------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `GET /`                                      | public     | Name, version, send mode (`cloudflare`/`resend`/`log`), attachment storage                |
| `POST /emails`                               | sending    | Send one email. `Idempotency-Key` header supported (24 h)                                 |
| `POST /emails/batch`                         | sending    | Up to 100 emails, no attachments. All are validated first, then sent in order             |
| `GET /emails?limit&after&before`             | full       | Sent emails, newest first, `has_more`                                                     |
| `GET /emails/:id`                            | full       | One sent email, with `html`, `text`, `last_event` (`sent`/`failed`/`logged`)              |
| `GET /emails/receiving?limit&after&before`   | full       | Received emails, newest first, `has_more`                                                 |
| `GET /emails/receiving/:id`                  | full       | A received email (Resend shape), HTML keeps `cid:` references, plus `authentication`      |
| `DELETE /emails/receiving/:id`               | full       | Delete a received email and its attachments                                               |
| `GET /emails/receiving/:id/attachments`      | full       | List attachments                                                                          |
| `GET /emails/receiving/:id/attachments/:aid` | full       | Metadata and a signed `download_url` (valid 1 hour)                                       |
| `GET /attachments/:aid?exp&sig`              | signed     | The attachment file; needs a valid signature, no API key                                  |
| `GET/POST /webhooks`                         | full       | List / create (`signing_secret` `whsec_…` is returned on create)                          |
| `GET/PATCH/DELETE /webhooks/:id`             | full       | Read (with secret), change `endpoint`/`events`/`status`, delete                           |
| `GET /webhooks/:id/deliveries`               | full       | Last 50 deliveries: status, attempts, HTTP code, error                                    |
| `POST /webhooks/retry`                       | full       | Deliver what is due now (max 25)                                                          |
| `GET /domains`                               | full       | Sending (`SEND_DOMAINS`) and receiving (`INBOUND_DOMAINS`) domains from the configuration |
| `GET/POST /api-keys`, `DELETE /api-keys/:id` | full       | Manage keys (the token is shown once)                                                     |

Paging works like Resend's: pass `after=<id>` for older items and `before=<id>`
for newer ones. `limit` is 1–100 and defaults to 20.

## Send an email

```bash
curl -X POST https://mail.example.com/emails \
  -H "Authorization: Bearer $CFMAIL_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1234-confirmation" \
  -d '{
    "from": "Example <noreply@example.com>",
    "to": ["customer@gmail.com"],
    "cc": "sales@example.com",
    "reply_to": "sales@example.com",
    "subject": "Your order",
    "html": "<p>Thanks for your order.</p>",
    "text": "Thanks for your order.",
    "headers": { "List-Unsubscribe": "<https://example.com/unsubscribe?t=...>" },
    "attachments": [{ "filename": "invoice.pdf", "content": "<base64>" }]
  }'
# → { "id": "5dc9dfbb-…" }
```

Supported fields:

| Field                     | Format                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `from`, `to`, `cc`, `bcc` | A string or an array. `Name <email>` is accepted.                                                                              |
| `reply_to`                | The first address is used.                                                                                                     |
| `subject`                 | Text, up to 998 characters.                                                                                                    |
| `html`, `text`            | The body.                                                                                                                      |
| `headers`                 | An object of strings.                                                                                                          |
| `attachments`             | Each has a `filename`, a `content` (base64 or a byte array), an optional `content_type`, and a `content_id` for inline images. |

The total message is limited to 50 recipients across `to`, `cc` and `bcc`, 32
attachments and 25 MiB.

## Errors

Errors use the same shape as Resend:
`{ "statusCode": 422, "name": "validation_error", "message": "Missing `to` field." }`.

| Code | `name`                                        | When                                                                  |
| ---- | --------------------------------------------- | --------------------------------------------------------------------- |
| 401  | `missing_api_key`, `restricted_api_key`       | No key, or a `sending_access` key on a full-access endpoint           |
| 403  | `invalid_api_key`, `invalid_from_address`     | Wrong key / sender domain not allowed or not onboarded                |
| 404  | `not_found`                                   | —                                                                     |
| 422  | `validation_error`                            | Bad input; Cloudflare's code (`E_…`) is included in the message       |
| 429  | `rate_limit_exceeded`, `daily_quota_exceeded` | cfmail rate limit (600/min per key by default) or Email Service quota |
| 500  | `application_error`                           | Anything else (the `E_…` code is included)                            |
| 503  | `service_unavailable`                         | Retryable, e.g. a sending domain still being provisioned              |

Batch responses work differently:

- An email that fails still gets an id.
- The response lists the failures as `errors: [{ index, message }]`.
- On a 429, the rest of the batch is skipped and listed in `errors`, so the
  caller can retry those emails later.

## Webhooks

Events are `email.received`, `email.sent` and `email.failed`. Example payload:

```json
{
  "type": "email.received",
  "created_at": "2026-11-15T03:12:00.000Z",
  "data": {
    "email_id": "25db6e19-…",
    "from": "Budi <budi@vendor.example>",
    "to": ["Sales <sales@example.com>"],
    "received_for": ["sales@example.com"],
    "subject": "Request for quotation",
    "message_id": "<abc@vendor.example>",
    "attachments": [
      {
        "id": "…",
        "filename": "rfq.pdf",
        "content_type": "application/pdf",
        "size": 12345
      }
    ]
  }
}
```

Headers: `svix-id`, `svix-timestamp`, `svix-signature` (`v1,<base64>`). The
signed content is `${svix-id}.${svix-timestamp}.${body}`, HMAC-SHA256 with the
base64 key after `whsec_`. Any Svix or Resend webhook verifier accepts it as is.
Answer 2xx for success. Anything else is retried after 1, 5, 30, 120, 360 and
720 minutes (7 attempts in total). Retries run when mail arrives, when
`POST /webhooks/retry` is called, or on the optional cron.

## Compatibility with Resend

| Resend feature                                                         | cfmail                                                                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POST /emails`, `POST /emails/batch`                                   | Yes (batch without attachments, as in Resend)                                                                     |
| `Idempotency-Key`                                                      | Yes (24 h, per API key)                                                                                           |
| `GET /emails`, `GET /emails/:id`                                       | Yes (`last_event` is `sent`, `failed` or `logged`)                                                                |
| `GET /emails/receiving[/:id]`, attachments + `download_url`            | Yes                                                                                                               |
| `GET/POST/PATCH/DELETE /webhooks`                                      | Yes                                                                                                               |
| Svix-signed webhooks                                                   | Yes                                                                                                               |
| API key permissions `full_access` / `sending_access`                   | Yes (no per-domain restriction)                                                                                   |
| Events `email.delivered`, `bounced`, `opened`, `clicked`, `complained` | **No** (Email Service does not expose delivery events to Workers yet)                                             |
| Custom `Message-ID` header                                             | Sent without it (Email Sending refuses it); replies are rewritten to the requested id, so threading keeps working |
| `scheduled_at`, `attachments[].path` (URL)                             | No (rejected with 422)                                                                                            |
| `tags`                                                                 | Accepted and ignored                                                                                              |
| `PATCH /emails/:id`, cancel                                            | No                                                                                                                |
| `/domains` CRUD, audiences, contacts, broadcasts, templates            | No (domains are configured in the Cloudflare dashboard and `wrangler.toml`)                                       |

## Dashboard API

The dashboard and webmail use a separate JSON API under `/app/api/*`. It is
authenticated with a session cookie and guarded by role permissions. It is not
part of the Resend-compatible surface and may change between minor versions. See
[dashboard.md](dashboard.md).
