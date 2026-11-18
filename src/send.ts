/**
 * POST /emails and /emails/batch — Resend's request shape, sent through the
 * Email Service send binding (env.EMAIL.send). SEND_MODE=log records without
 * sending (local dev, or accounts on Workers Free where arbitrary-recipient
 * sending is not available).
 */
import type { KeyInfo } from "./auth";
import { list, type Env } from "./env";
import { ApiError, err, json, readBody } from "./http";
import { emit, deliver } from "./webhooks";
import {
  b64,
  domainOf,
  formatAddr,
  fromB64,
  guessType,
  iso,
  now,
  parseAddress,
  parseAddressList,
  uuid,
  type Addr,
} from "./util";

/** Email Service limits (developers.cloudflare.com/email-service/platform/limits, Oct 2026). */
export const LIMITS = {
  recipients: 50,
  attachments: 32,
  totalBytes: 25 * 1024 * 1024,
  batch: 100,
};

export interface SendBody {
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  reply_to?: unknown;
  subject?: unknown;
  html?: unknown;
  text?: unknown;
  headers?: unknown;
  attachments?: unknown;
  scheduled_at?: unknown;
  tags?: unknown;
}

export interface Prepared {
  from: Addr;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo?: Addr;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments: {
    filename: string;
    type: string;
    content: Uint8Array;
    contentId?: string;
  }[];
}

/** Validate a Resend-style body. Throws ApiError(422) with a clear message. */
export function prepare(b: SendBody, sendDomains: string[]): Prepared {
  const v = (fn: () => unknown) => {
    try {
      return fn();
    } catch (e) {
      throw err.validation(e instanceof Error ? e.message : String(e));
    }
  };
  if (b.scheduled_at !== undefined)
    throw err.validation("`scheduled_at` is not supported.");
  if (!b.from) throw err.validation("Missing `from` field.");
  const from = v(() => parseAddress(b.from)) as Addr;
  if (sendDomains.length && !sendDomains.includes(domainOf(from.email))) {
    throw new ApiError(
      403,
      "invalid_from_address",
      `The ${domainOf(from.email)} domain is not allowed to send.`,
    );
  }
  const to = v(() => parseAddressList(b.to)) as Addr[];
  const cc = v(() => parseAddressList(b.cc)) as Addr[];
  const bcc = v(() => parseAddressList(b.bcc)) as Addr[];
  if (!to.length && !cc.length && !bcc.length)
    throw err.validation("Missing `to` field.");
  if (to.length + cc.length + bcc.length > LIMITS.recipients) {
    throw err.validation(
      `Too many recipients: at most ${LIMITS.recipients} across to, cc and bcc.`,
    );
  }
  const replyList = v(() => parseAddressList(b.reply_to)) as Addr[];
  if (typeof b.subject !== "string" || !b.subject.trim())
    throw err.validation("Missing `subject` field.");
  if (b.subject.length > 998)
    throw err.validation("`subject` is longer than 998 characters.");
  const html = typeof b.html === "string" && b.html ? b.html : undefined;
  const text = typeof b.text === "string" && b.text ? b.text : undefined;
  if (!html && !text) throw err.validation("Provide `html` or `text`.");

  let headers: Record<string, string> | undefined;
  if (b.headers !== undefined) {
    if (
      typeof b.headers !== "object" ||
      b.headers === null ||
      Array.isArray(b.headers)
    ) {
      throw err.validation("`headers` must be an object of strings.");
    }
    headers = {};
    for (const [k, val] of Object.entries(b.headers)) {
      if (typeof val !== "string")
        throw err.validation(`Header ${k} must be a string.`);
      headers[k] = val;
    }
  }

  const rawAtt = b.attachments === undefined ? [] : b.attachments;
  if (!Array.isArray(rawAtt))
    throw err.validation("`attachments` must be an array.");
  if (rawAtt.length > LIMITS.attachments)
    throw err.validation(`At most ${LIMITS.attachments} attachments.`);
  let total = (html?.length ?? 0) + (text?.length ?? 0);
  const attachments = rawAtt.map((a: unknown, i) => {
    const x = (a ?? {}) as {
      filename?: unknown;
      content?: unknown;
      content_type?: unknown;
      content_id?: unknown;
      path?: unknown;
    };
    if (x.path !== undefined)
      throw err.validation(
        "Attachment `path` (remote URL) is not supported; send `content`.",
      );
    if (typeof x.filename !== "string" || !x.filename)
      throw err.validation(`Attachment ${i + 1}: missing filename.`);
    let content: Uint8Array;
    if (typeof x.content === "string")
      content = v(() => fromB64(x.content as string)) as Uint8Array;
    else if (Array.isArray(x.content))
      content = Uint8Array.from(x.content as number[]);
    else
      throw err.validation(
        `Attachment ${i + 1}: \`content\` must be base64 or a byte array.`,
      );
    total += content.byteLength;
    return {
      filename: x.filename,
      type:
        typeof x.content_type === "string" && x.content_type
          ? x.content_type
          : guessType(x.filename),
      content,
      ...(typeof x.content_id === "string" && x.content_id
        ? { contentId: x.content_id }
        : {}),
    };
  });
  if (total > LIMITS.totalBytes)
    throw err.validation("Message is larger than 25 MiB.");

  return {
    from,
    to,
    cc,
    bcc,
    ...(replyList[0] ? { replyTo: replyList[0] } : {}),
    subject: b.subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(headers ? { headers } : {}),
    attachments,
  };
}

const toCf = (a: Addr): string | EmailAddress =>
  a.name ? { email: a.email, name: a.name } : a.email;

/** Prepared → argument for env.EMAIL.send(). */
export function toBuilder(p: Prepared): EmailMessageBuilder {
  return {
    from: toCf(p.from),
    ...(p.to.length ? { to: p.to.map(toCf) } : {}),
    ...(p.cc.length ? { cc: p.cc.map(toCf) } : {}),
    ...(p.bcc.length ? { bcc: p.bcc.map(toCf) } : {}),
    ...(p.replyTo ? { replyTo: toCf(p.replyTo) } : {}),
    subject: p.subject,
    ...(p.html ? { html: p.html } : {}),
    ...(p.text ? { text: p.text } : {}),
    ...(p.headers ? { headers: p.headers } : {}),
    ...(p.attachments.length
      ? {
          attachments: p.attachments.map((a) =>
            a.contentId
              ? {
                  disposition: "inline" as const,
                  contentId: a.contentId,
                  filename: a.filename,
                  type: a.type,
                  content: a.content,
                }
              : {
                  disposition: "attachment" as const,
                  filename: a.filename,
                  type: a.type,
                  content: a.content,
                },
          ),
        }
      : {}),
  } as EmailMessageBuilder;
}

/** Map a binding error code to an HTTP error (codes from the Workers API docs). */
export function mapSendError(e: unknown): ApiError {
  const code = (e as { code?: string })?.code ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  if (code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED") {
    return new ApiError(
      429,
      code === "E_DAILY_LIMIT_EXCEEDED"
        ? "daily_quota_exceeded"
        : "rate_limit_exceeded",
      msg,
    );
  }
  if (/NOT_READY|INTERNAL_SERVER|TEMPORAR/.test(code)) {
    // Retryable: e.g. a sending domain that is still being provisioned.
    return new ApiError(503, "service_unavailable", `${code}: ${msg}`);
  }
  if (
    code === "E_SENDER_NOT_VERIFIED" ||
    code === "E_SENDER_DOMAIN_NOT_AVAILABLE"
  ) {
    return new ApiError(403, "invalid_from_address", msg);
  }
  if (
    code.startsWith("E_") &&
    /VALIDATION|FIELD|TOO_MANY|HEADER|CONTENT_TOO_LARGE|RECIPIENT/.test(code)
  ) {
    return new ApiError(422, "validation_error", `${code}: ${msg}`);
  }
  return new ApiError(500, "application_error", code ? `${code}: ${msg}` : msg);
}

/** Sent bodies are kept for GET /emails/:id and webmail (D1 rows ≤ 2 MB). */
export const MAX_STORED_BODY = 800_000;

export type SendMode = "cloudflare" | "resend" | "log";

const bare = (id: string) => id.trim().replace(/^<|>$/g, "");

/**
 * Email Sending refuses a custom Message-ID header ("only whitelisted headers
 * and X-* headers are accepted"). Split it off so the message can be sent;
 * the caller records Cloudflare's id → requested id (see inbound rewrite).
 */
export function splitMessageId(headers?: Record<string, string>): {
  headers?: Record<string, string>;
  messageId: string | null;
} {
  if (!headers) return { messageId: null };
  let messageId: string | null = null;
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "message-id") messageId = bare(v);
    else rest[k] = v;
  }
  return { ...(Object.keys(rest).length ? { headers: rest } : {}), messageId };
}

async function viaCloudflare(env: Env, p: Prepared): Promise<string> {
  const { headers, messageId } = splitMessageId(p.headers);
  const r = await env.EMAIL!.send(toBuilder({ ...p, headers }));
  if (messageId && r.messageId) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO message_ids (provider_message_id, requested_message_id, created_at) VALUES (?1, ?2, ?3)`,
    )
      .bind(bare(r.messageId), messageId, now())
      .run();
  }
  return r.messageId;
}

/** SEND_MODE, falling back to "log" when the needed binding/secret is missing. */
export function sendMode(env: Env): SendMode {
  if (env.SEND_MODE === "resend") return env.RESEND_API_KEY ? "resend" : "log";
  if (env.SEND_MODE === "log" || !env.EMAIL) return "log";
  return "cloudflare";
}

/**
 * Relay mode: hand the message to Resend (receive via Cloudflare for free,
 * keep sending via Resend). Returns Resend's email id.
 */
export async function viaResend(
  env: Env,
  p: Prepared,
  idempotencyKey: string,
): Promise<string> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      from: formatAddr(p.from),
      to: p.to.map(formatAddr),
      ...(p.cc.length ? { cc: p.cc.map(formatAddr) } : {}),
      ...(p.bcc.length ? { bcc: p.bcc.map(formatAddr) } : {}),
      ...(p.replyTo ? { reply_to: formatAddr(p.replyTo) } : {}),
      subject: p.subject,
      ...(p.html ? { html: p.html } : {}),
      ...(p.text ? { text: p.text } : {}),
      ...(p.headers ? { headers: p.headers } : {}),
      ...(p.attachments.length
        ? {
            attachments: p.attachments.map((a) => ({
              filename: a.filename,
              content: b64(a.content),
              content_type: a.type,
              ...(a.contentId ? { content_id: a.contentId } : {}),
            })),
          }
        : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let name = "application_error";
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { name?: string; message?: string };
      name = j.name ?? name;
      message = j.message ?? message;
    } catch {
      /* plain text */
    }
    throw new ApiError(
      res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status,
      name,
      `Resend: ${message}`,
    );
  }
  return (JSON.parse(text) as { id: string }).id;
}

interface SendResult {
  id: string;
  ok: boolean;
  error?: ApiError;
}

/** Who sent a message: an API key, or a dashboard/webmail user. */
export interface Sender {
  apiKeyId: string | null;
  userId?: string | null;
}

/** Send one prepared message, record it, emit email.sent / email.failed. */
export async function sendOne(
  env: Env,
  sender: Sender,
  p: Prepared,
  ctx: ExecutionContext,
): Promise<SendResult> {
  const id = uuid();
  const mode = sendMode(env);
  let status: "sent" | "failed" | "logged" = "logged";
  let providerId: string | null = null;
  let error: ApiError | undefined;
  if (mode === "log") {
    console.log(
      "email_logged",
      JSON.stringify({
        id,
        from: formatAddr(p.from),
        to: p.to.map(formatAddr),
        subject: p.subject,
      }),
    );
    if (p.text) console.log(p.text.slice(0, 4000));
  } else {
    try {
      providerId =
        mode === "resend"
          ? await viaResend(env, p, id)
          : await viaCloudflare(env, p);
      status = "sent";
    } catch (e) {
      error = e instanceof ApiError ? e : mapSendError(e);
      status = "failed";
      console.error("email_send_failed", id, error.name, error.message);
    }
  }
  const t = now();
  const html = p.html?.slice(0, MAX_STORED_BODY) ?? null;
  const text = p.text?.slice(0, MAX_STORED_BODY - (html?.length ?? 0)) ?? null;
  const insertSent = env.DB.prepare(
    `INSERT INTO sent_emails (id, api_key_id, from_addr, to_json, cc_json, bcc_json, subject, status, provider_message_id, error_code, error, created_at, user_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  ).bind(
    id,
    sender.apiKeyId,
    formatAddr(p.from),
    JSON.stringify(p.to.map(formatAddr)),
    p.cc.length ? JSON.stringify(p.cc.map(formatAddr)) : null,
    p.bcc.length ? JSON.stringify(p.bcc.map(formatAddr)) : null,
    p.subject,
    status,
    providerId,
    error?.name ?? null,
    error?.message.slice(0, 500) ?? null,
    t,
    sender.userId ?? null,
  );
  await env.DB.batch([
    insertSent,
    env.DB.prepare(
      `INSERT INTO sent_bodies (email_id, html, text, reply_to, message_id, attachments_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      id,
      html,
      text,
      p.replyTo ? formatAddr(p.replyTo) : null,
      splitMessageId(p.headers).messageId,
      p.attachments.length
        ? JSON.stringify(
            p.attachments.map((a) => ({
              filename: a.filename,
              content_type: a.type,
              size: a.content.byteLength,
            })),
          )
        : null,
    ),
  ]);
  const data = {
    email_id: id,
    created_at: iso(t),
    from: formatAddr(p.from),
    to: p.to.map(formatAddr),
    subject: p.subject,
    ...(error ? { error: { name: error.name, message: error.message } } : {}),
  };
  ctx.waitUntil(
    emit(env, error ? "email.failed" : "email.sent", data)
      .then((ids) => deliver(env, ids))
      .catch((e) => console.error("webhook_emit_failed", e)),
  );
  return { id, ok: !error, ...(error ? { error } : {}) };
}

/** Idempotency-Key: same key + same API key within 24 h returns the stored response. */
async function idempotent(
  env: Env,
  key: KeyInfo,
  req: Request,
  run: () => Promise<{ body: unknown; status: number }>,
): Promise<Response> {
  const ik = req.headers.get("idempotency-key")?.slice(0, 256);
  if (!ik) {
    const r = await run();
    return json(r.body, r.status);
  }
  const hit = await env.DB.prepare(
    `SELECT response FROM idempotency WHERE api_key_id = ?1 AND key = ?2 AND created_at > ?3`,
  )
    .bind(key.id, ik, now() - 86_400_000)
    .first<{ response: string }>();
  if (hit)
    return json(JSON.parse(hit.response), 200, {
      "idempotent-replayed": "true",
    });
  const r = await run();
  if (r.status < 300) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO idempotency (api_key_id, key, response, created_at) VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(key.id, ik, JSON.stringify(r.body), now())
      .run();
  }
  return json(r.body, r.status);
}

export async function sendRoute(
  req: Request,
  env: Env,
  key: KeyInfo,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readBody<SendBody>(req);
  const p = prepare(body, list(env.SEND_DOMAINS));
  return idempotent(env, key, req, async () => {
    const r = await sendOne(env, { apiKeyId: key.id }, p, ctx);
    if (r.error) throw r.error;
    return { body: { id: r.id }, status: 200 };
  });
}

export async function batchRoute(
  req: Request,
  env: Env,
  key: KeyInfo,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readBody<SendBody[]>(req);
  if (!Array.isArray(body) || !body.length)
    throw err.validation("Body must be a non-empty array of emails.");
  if (body.length > LIMITS.batch)
    throw err.validation(`At most ${LIMITS.batch} emails per batch.`);
  const domains = list(env.SEND_DOMAINS);
  // Validate everything first (all-or-nothing, like Resend's strict mode).
  const prepared = body.map((b, i) => {
    if ((b as SendBody).attachments !== undefined)
      throw err.validation(
        `Email ${i}: attachments are not supported in batch.`,
      );
    try {
      return prepare(b, domains);
    } catch (e) {
      if (e instanceof ApiError)
        throw new ApiError(e.status, e.name, `Email ${i}: ${e.message}`);
      throw e;
    }
  });
  return idempotent(env, key, req, async () => {
    const data: { id: string }[] = [];
    const errors: { index: number; message: string }[] = [];
    // Sequential: keeps ordering and stays gentle on Email Service rate limits.
    for (let i = 0; i < prepared.length; i++) {
      const r = await sendOne(env, { apiKeyId: key.id }, prepared[i]!, ctx);
      data.push({ id: r.id });
      if (r.error) {
        errors.push({
          index: i,
          message: `${r.error.name}: ${r.error.message}`,
        });
        if (r.error.status === 429) {
          // Quota or rate limit: stop; the caller retries the rest later.
          for (let j = i + 1; j < prepared.length; j++)
            errors.push({ index: j, message: "skipped: rate limited" });
          break;
        }
      }
    }
    return { body: errors.length ? { data, errors } : { data }, status: 200 };
  });
}

interface SentRow {
  id: string;
  from_addr: string;
  to_json: string;
  cc_json: string | null;
  bcc_json: string | null;
  subject: string;
  status: string;
  error: string | null;
  created_at: number;
  html?: string | null;
  text?: string | null;
  reply_to?: string | null;
}

const lastEvent = (status: string) =>
  status === "failed" ? "failed" : status === "logged" ? "logged" : "sent";

export function presentSent(r: SentRow, withBody: boolean) {
  return {
    object: "email",
    id: r.id,
    from: r.from_addr,
    to: JSON.parse(r.to_json) as string[],
    cc: r.cc_json ? (JSON.parse(r.cc_json) as string[]) : null,
    bcc: r.bcc_json ? (JSON.parse(r.bcc_json) as string[]) : null,
    reply_to: r.reply_to ? [r.reply_to] : null,
    subject: r.subject,
    created_at: iso(r.created_at),
    last_event: lastEvent(r.status),
    ...(withBody ? { html: r.html ?? null, text: r.text ?? null } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function getSent(env: Env, id: string): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT e.*, b.html, b.text, b.reply_to FROM sent_emails e
       LEFT JOIN sent_bodies b ON b.email_id = e.id WHERE e.id = ?1`,
  )
    .bind(id)
    .first<SentRow>();
  if (!r) throw err.notFound("Email not found.");
  return json(presentSent(r, true));
}

/** GET /emails?limit&after|before — sent emails, newest first. */
export async function listSent(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20),
  );
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  const cursorId = after ?? before;
  let where = "";
  const binds: unknown[] = [limit + 1];
  if (cursorId) {
    const c = await env.DB.prepare(
      `SELECT created_at FROM sent_emails WHERE id = ?1`,
    )
      .bind(cursorId)
      .first<{ created_at: number }>();
    if (!c) throw err.validation("Unknown cursor.");
    binds.push(c.created_at, cursorId);
    where = after
      ? `WHERE (created_at, id) < (?2, ?3)`
      : `WHERE (created_at, id) > (?2, ?3)`;
  }
  const order = before && !after ? "ASC" : "DESC";
  const { results } = await env.DB.prepare(
    `SELECT * FROM sent_emails ${where} ORDER BY created_at ${order}, id ${order} LIMIT ?1`,
  )
    .bind(...binds)
    .all<SentRow>();
  const has_more = results.length > limit;
  const rows = results.slice(0, limit);
  if (order === "ASC") rows.reverse();
  return json({
    object: "list",
    has_more,
    data: rows.map((r) => presentSent(r, false)),
  });
}
