# Limits, costs and risks

Cloudflare figures come from developers.cloudflare.com/email-service, read on 15
Nov 2026; those pages were last updated in Oct–Nov 2026. Resend figures come
from resend.com/pricing, read on 18 Nov 2026. **Email Sending is in beta**, so
check the official pages before you promise anything to anyone.

## Pricing

| Component                                 | Workers Free                                 | Workers Paid ($5/month per account)                |
| ----------------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| Email Routing (receive)                   | **Unlimited**                                | **Unlimited**                                      |
| Worker handling incoming mail             | Normal Workers pricing (1 request per email) | Normal Workers pricing                             |
| Email Sending (to any address)            | **Not available**                            | **3,000/month included**, then **$0.35 per 1,000** |
| Sending to verified destination addresses | Free                                         | Free, does not use the quota                       |
| Dashboard static assets (`/app/`)         | Free, not counted as Worker requests         | Same                                               |
| D1, R2                                    | Normal free quotas                           | Paid quotas                                        |

The sending quota counts email accepted by the receiving server, plus hard
bounces. Email rejected before sending, including by suppression, is not
counted.

## Technical limits (Email Service)

| Item                              | Limit                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Recipients per email              | 50 (to + cc + bcc)                                                                                        |
| Message size (send & receive)     | 25 MiB including attachments                                                                              |
| Attachments per email             | 32                                                                                                        |
| Headers                           | 16 KB total                                                                                               |
| Daily sending quota               | **No number published**: new accounts start with a conservative quota that grows; there is a request form |
| Rate per second                   | Not published (error `E_RATE_LIMIT_EXCEEDED`)                                                             |
| Domains per zone                  | 30 (Routing + Sending combined)                                                                           |
| Routing rules per domain          | 200                                                                                                       |
| Destination addresses per account | 200                                                                                                       |

cfmail's own limits:

| Item                      | Limit                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Batch                     | 100 emails                                                                                                                          |
| Request body              | 40 MB                                                                                                                               |
| Stored body               | 800,000 characters of text + HTML. Longer bodies are cut and marked `truncated: true`; the full `.eml` stays in R2 if one is bound. |
| Attachments in D1 (no R2) | 1.5 MB each                                                                                                                         |
| API rate limit            | 600 requests per minute per key (editable in `wrangler.toml`)                                                                       |
| Webmail sending           | 300 emails per user per day                                                                                                         |

## Example monthly costs

| Profile                                               | Resend only                                            | cfmail (`cloudflare`)                  | cfmail (`resend` relay)                |
| ----------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- | -------------------------------------- |
| 5 people: 1,500 in + 600 out                          | Free (2,100 ≤ 3,000), but busy days can exceed 100/day | $5 (Paid)                              | **$0** (600 out on Resend Free)        |
| 15 people: 6,000 in + 2,500 out                       | Pro **$20**                                            | **$5** (2,500 ≤ 3,000)                 | $0–20 (2,500 out, but > 100/day → Pro) |
| 15 people + 5,000 newsletters/month                   | Pro **$20**                                            | $5 + 4,500 × $0.35/1,000 ≈ **$6.58**   | Pro $20                                |
| 30 people: 12,000 in + 6,000 out + 40,000 newsletters | Pro **$35** (58,000 > 50,000)                          | $5 + 43,000 × $0.35/1,000 ≈ **$20.05** | Pro **$20** (46,000 out)               |

These are rough figures without tax. Resend counts incoming mail toward the same
quota as outgoing mail, while cfmail receives through Email Routing at no cost.
If your account is already on Workers Paid for other reasons, cfmail's only
extra cost is sending above 3,000 emails a month.

## Risks and limitations

1. **Email Sending is in beta.** Behaviour and prices can change. Error
   `not_entitled` (10105) means the account may not use Email Sending yet.
2. **No delivery events.** Email Service shows delivered/bounced status only in
   the Cloudflare dashboard (activity log, 30 days) and in GraphQL Analytics (31
   days). cfmail can only report `email.sent` (accepted by Cloudflare) and
   `email.failed` (rejected when sending).
3. **Unknown daily quota for new accounts.** A large newsletter in the first
   week can hit `E_DAILY_LIMIT_EXCEEDED`. Start small.
4. **Sender reputation** is managed by Cloudflare: bounces must stay under 2%
   and complaints under 0.1%. Accounts with poor reputation can be paused
   (`E_ACCOUNT_SUSPENDED`). Newsletters must include an unsubscribe link.
5. **One root MX.** Moving a domain to Email Routing means its mail no longer
   reaches another provider on that same domain.
6. **CPU on Workers Free.** Parsing large messages in `email()` can exceed 10 ms
   of CPU. Use Workers Paid for real volume. Whether senders retry when the
   handler fails is not documented, so test it on your account.
7. **Not a full mail server:**
   - no IMAP or SMTP for desktop clients;
   - no spam filter beyond SPF/DKIM/DMARC verdicts;
   - no 2FA for the dashboard yet. Cloudflare Access in front of `/app/*` is a
     good complement.
8. **Webhook secrets are stored as-is in D1**, because they are needed for
   signing. Anyone who can read D1 can already read all mail, too.

## Sources

- Email Service overview: https://developers.cloudflare.com/email-service/
- Pricing: https://developers.cloudflare.com/email-service/platform/pricing/
- Limits: https://developers.cloudflare.com/email-service/platform/limits/
- Workers sending API:
  https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
- Send bindings:
  https://developers.cloudflare.com/email-service/configuration/send-bindings/
- Domain onboarding:
  https://developers.cloudflare.com/email-service/configuration/domains/
- Email handler (inbound):
  https://developers.cloudflare.com/email-service/api/route-emails/email-handler/
- Suppressions:
  https://developers.cloudflare.com/email-service/concepts/suppressions/
- Workers Static Assets billing:
  https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- Resend pricing: https://resend.com/pricing
