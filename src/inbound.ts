/**
 * Inbound mail: Email Routing → this Worker's email() handler.
 * Parse with postal-mime, store in D1 (+ R2 when bound), emit email.received.
 * The stored record is served in Resend's "received email" shape (received.ts).
 */
import PostalMime, { type Address, type Email } from "postal-mime";
import { list, type Env } from "./env";
import { fileInbound } from "./mail";
import { deliver, emit } from "./webhooks";
import { domainOf, iso, now, uuid } from "./util";

/** D1 rows are at most 2 MB; keep text and html well under that together. */
export const MAX_BODY_CHARS = 800_000;
/** Attachments kept in D1 when there is no R2 bucket. */
export const MAX_D1_ATTACHMENT = 1_500_000;

export function flatten(list?: Address[]): string[] {
  const out: string[] = [];
  for (const a of list ?? []) {
    if (a.group)
      for (const m of a.group)
        out.push(m.name ? `${m.name} <${m.address}>` : m.address);
    else if (a.address)
      out.push(a.name ? `${a.name} <${a.address}>` : a.address);
  }
  return out;
}

/** Headers → { lowercased-name: value | value[] } (Resend shape). */
export function headerRecord(
  h: Email["headers"],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const { key, value } of h) {
    const k = key.toLowerCase();
    const prev = out[k];
    out[k] =
      prev === undefined
        ? value
        : Array.isArray(prev)
          ? [...prev, value]
          : [prev, value];
  }
  return out;
}

/**
 * SPF/DKIM/DMARC verdicts from the first Authentication-Results header added
 * by Cloudflare (service id mx.cloudflare.net), as the docs recommend.
 */
export function authResults(
  h: Email["headers"],
): { spf?: string; dkim?: string; dmarc?: string } | null {
  const ar = h.find(
    (x) =>
      x.key.toLowerCase() === "authentication-results" &&
      /mx\.cloudflare\.net/i.test(x.value),
  );
  if (!ar) return null;
  const pick = (k: string) =>
    new RegExp(`\\b${k}=(\\w+)`, "i").exec(ar.value)?.[1]?.toLowerCase();
  const r: { spf?: string; dkim?: string; dmarc?: string } = {};
  for (const k of ["spf", "dkim", "dmarc"] as const) {
    const v = pick(k);
    if (v) r[k] = v;
  }
  return r;
}

function bytes(c: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof c === "string") return new TextEncoder().encode(c);
  return c instanceof Uint8Array ? c : new Uint8Array(c);
}

/**
 * Replies to mail we sent through Email Sending reference Cloudflare's
 * Message-ID. Swap those back to the Message-ID the app asked for, so the
 * app's threading (In-Reply-To / References) keeps working.
 */
export async function restoreThreadIds(
  env: Env,
  headers: Record<string, string | string[]>,
): Promise<Record<string, string | string[]>> {
  const keys = ["in-reply-to", "references"] as const;
  const ids = new Set<string>();
  for (const k of keys) {
    const v = headers[k];
    for (const line of Array.isArray(v) ? v : v ? [v] : []) {
      for (const m of line.matchAll(/<([^<>\s]+)>/g)) ids.add(m[1]!);
    }
  }
  if (!ids.size) return headers;
  const { results } = await env.DB.prepare(
    `SELECT provider_message_id AS p, requested_message_id AS r FROM message_ids
      WHERE provider_message_id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify([...ids].slice(0, 100)))
    .all<{ p: string; r: string }>();
  if (!results.length) return headers;
  const map = new Map(results.map((x) => [x.p, x.r]));
  const swap = (line: string) =>
    line.replace(/<([^<>\s]+)>/g, (all, id: string) =>
      map.has(id) ? `<${map.get(id)}>` : all,
    );
  const out = { ...headers };
  for (const k of keys) {
    const v = out[k];
    if (v !== undefined) out[k] = Array.isArray(v) ? v.map(swap) : swap(v);
  }
  return out;
}

export interface StoreInput {
  raw: Uint8Array;
  envelopeFrom: string;
  envelopeTo: string;
}

/** Parse + store one message. Returns the new email id. Exported for tests and /dev routes. */
export async function storeInbound(
  env: Env,
  input: StoreInput,
): Promise<{ id: string; data: Record<string, unknown> }> {
  const email = await PostalMime.parse(input.raw, {
    attachmentEncoding: "arraybuffer",
  });
  const id = uuid();
  const t = now();

  let rawKey: string | null = null;
  if (env.BUCKET) {
    rawKey = `raw/${id}.eml`;
    await env.BUCKET.put(rawKey, input.raw, {
      httpMetadata: { contentType: "message/rfc822" },
    });
  }

  let text = email.text ?? null;
  let html = email.html ?? null;
  let truncated = 0;
  if ((text?.length ?? 0) + (html?.length ?? 0) > MAX_BODY_CHARS) {
    truncated = 1;
    html = html ? html.slice(0, Math.floor(MAX_BODY_CHARS * 0.7)) : null;
    text = text ? text.slice(0, MAX_BODY_CHARS - (html?.length ?? 0)) : null;
  }

  const from = flatten(email.from ? [email.from] : [])[0] ?? input.envelopeFrom;
  const headers = await restoreThreadIds(env, headerRecord(email.headers));
  const auth = authResults(email.headers);

  const atts = email.attachments.map((a, i) => {
    const data = bytes(a.content);
    const filename = a.filename || `attachment-${i + 1}`;
    const storage: "r2" | "d1" | "none" = env.BUCKET
      ? "r2"
      : data.byteLength <= MAX_D1_ATTACHMENT
        ? "d1"
        : "none";
    return {
      id: uuid(),
      filename,
      content_type: a.mimeType || "application/octet-stream",
      disposition: a.disposition === "inline" ? "inline" : "attachment",
      content_id: a.contentId ? a.contentId.replace(/^<|>$/g, "") : null,
      size: data.byteLength,
      storage,
      data,
    };
  });
  if (env.BUCKET) {
    await Promise.all(
      atts.map((a) =>
        env.BUCKET!.put(`att/${id}/${a.id}`, a.data, {
          httpMetadata: { contentType: a.content_type },
        }),
      ),
    );
  }

  const stmts = [
    env.DB.prepare(
      `INSERT INTO received_emails (id, message_id, envelope_from, from_addr, to_json, cc_json, bcc_json, reply_to_json,
         received_for_json, subject, text, html, truncated, headers_json, auth_json, raw_key, raw_size, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
    ).bind(
      id,
      email.messageId ?? null,
      input.envelopeFrom,
      from,
      JSON.stringify(flatten(email.to)),
      email.cc?.length ? JSON.stringify(flatten(email.cc)) : null,
      email.bcc?.length ? JSON.stringify(flatten(email.bcc)) : null,
      email.replyTo?.length ? JSON.stringify(flatten(email.replyTo)) : null,
      JSON.stringify([input.envelopeTo]),
      email.subject ?? null,
      text,
      html,
      truncated,
      JSON.stringify(headers),
      auth ? JSON.stringify(auth) : null,
      rawKey,
      input.raw.byteLength,
      t,
    ),
    ...atts.map((a) =>
      env.DB.prepare(
        `INSERT INTO received_attachments (id, email_id, filename, content_type, disposition, content_id, size, storage)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        a.id,
        id,
        a.filename,
        a.content_type,
        a.disposition,
        a.content_id,
        a.size,
        a.storage,
      ),
    ),
    ...atts
      .filter((a) => a.storage === "d1")
      .map((a) =>
        env.DB.prepare(
          `INSERT INTO attachment_blobs (attachment_id, data) VALUES (?1, ?2)`,
        ).bind(a.id, a.data),
      ),
  ];
  await env.DB.batch(stmts);
  // Webmail: file into the recipient's mailbox(es). A failure here must not
  // lose the message, which is already stored and visible through the API.
  try {
    await fileInbound(env, {
      emailId: id,
      envelopeTo: input.envelopeTo,
      messageId: email.messageId ?? null,
      headers,
      from,
      to: flatten(email.to),
      subject: email.subject ?? null,
      text,
      html,
      attachments: atts.filter((a) => a.disposition === "attachment").length,
      auth,
      createdAt: t,
    });
  } catch (e) {
    console.error("mail_file_failed", id, e);
  }

  const data = {
    email_id: id,
    created_at: iso(t),
    from,
    to: flatten(email.to),
    cc: flatten(email.cc),
    bcc: flatten(email.bcc),
    received_for: [input.envelopeTo],
    subject: email.subject ?? null,
    message_id: email.messageId ?? null,
    attachments: atts.map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type,
      content_disposition: a.disposition,
      content_id: a.content_id,
      size: a.size,
    })),
  };
  return { id, data };
}

/** The Email Routing entry point. */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const allowed = list(env.INBOUND_DOMAINS);
  if (allowed.length && !allowed.includes(domainOf(message.to))) {
    message.setReject("Unknown recipient domain");
    return;
  }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const { id, data } = await storeInbound(env, {
    raw,
    envelopeFrom: message.from,
    envelopeTo: message.to,
  });
  console.log("mail_received", id, message.to, raw.byteLength);
  ctx.waitUntil(
    emit(env, "email.received", data)
      .then((ids) => deliver(env, ids))
      .then(() => deliver(env)) // also retry anything overdue
      .catch((e) => console.error("webhook_emit_failed", e)),
  );
}
