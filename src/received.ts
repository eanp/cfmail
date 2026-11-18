/**
 * Received-email API in Resend's shape:
 *   GET /emails/receiving?limit&after|before
 *   GET /emails/receiving/:id                    (html keeps cid: references)
 *   GET /emails/receiving/:id/attachments        (list)
 *   GET /emails/receiving/:id/attachments/:aid   (metadata + signed download_url)
 *   GET /attachments/:aid?exp&sig                (public, signed: the file)
 */
import type { Env } from "./env";
import { err, json } from "./http";
import { b64url, hmac, iso, now, timingSafeEqual } from "./util";

const URL_TTL_MS = 60 * 60 * 1000;

interface Row {
  id: string;
  message_id: string | null;
  from_addr: string;
  to_json: string;
  cc_json: string | null;
  bcc_json: string | null;
  reply_to_json: string | null;
  received_for_json: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  truncated: number;
  headers_json: string;
  auth_json: string | null;
  raw_size: number;
  created_at: number;
}

export interface AttRow {
  id: string;
  email_id: string;
  filename: string;
  content_type: string;
  disposition: string;
  content_id: string | null;
  size: number;
  storage: string;
}

const parse = <T>(s: string | null): T | null =>
  s ? (JSON.parse(s) as T) : null;

function presentAtt(a: AttRow) {
  return {
    id: a.id,
    filename: a.filename,
    content_type: a.content_type,
    content_disposition: a.disposition,
    content_id: a.content_id,
    size: a.size,
    ...(a.storage === "none"
      ? { unavailable: "too large to store without R2" }
      : {}),
  };
}

export async function listReceived(env: Env, url: URL): Promise<Response> {
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
      `SELECT created_at FROM received_emails WHERE id = ?1`,
    )
      .bind(cursorId)
      .first<{ created_at: number }>();
    if (!c) throw err.validation("Unknown cursor.");
    binds.push(c.created_at, cursorId);
    // Newest first. `after` = older than the cursor, `before` = newer.
    where = after
      ? `WHERE (created_at, id) < (?2, ?3)`
      : `WHERE (created_at, id) > (?2, ?3)`;
  }
  const order = before && !after ? "ASC" : "DESC";
  const { results } = await env.DB.prepare(
    `SELECT id, from_addr, to_json, subject, message_id, created_at FROM received_emails ${where}
      ORDER BY created_at ${order}, id ${order} LIMIT ?1`,
  )
    .bind(...binds)
    .all<{
      id: string;
      from_addr: string;
      to_json: string;
      subject: string | null;
      message_id: string | null;
      created_at: number;
    }>();
  const has_more = results.length > limit;
  const rows = results.slice(0, limit);
  if (order === "ASC") rows.reverse();
  return json({
    object: "list",
    has_more,
    data: rows.map((r) => ({
      id: r.id,
      created_at: iso(r.created_at),
      from: r.from_addr,
      to: JSON.parse(r.to_json) as string[],
      subject: r.subject,
      message_id: r.message_id,
    })),
  });
}

export async function getReceived(env: Env, id: string): Promise<Response> {
  const r = await env.DB.prepare(`SELECT * FROM received_emails WHERE id = ?1`)
    .bind(id)
    .first<Row>();
  if (!r) throw err.notFound("Email not found.");
  const { results } = await env.DB.prepare(
    `SELECT * FROM received_attachments WHERE email_id = ?1`,
  )
    .bind(id)
    .all<AttRow>();
  return json({
    object: "email",
    id: r.id,
    from: r.from_addr,
    to: JSON.parse(r.to_json) as string[],
    cc: parse<string[]>(r.cc_json),
    bcc: parse<string[]>(r.bcc_json),
    reply_to: parse<string[]>(r.reply_to_json),
    received_for: JSON.parse(r.received_for_json) as string[],
    subject: r.subject,
    html: r.html,
    html_format: "cid",
    text: r.text,
    headers: JSON.parse(r.headers_json) as Record<string, string | string[]>,
    message_id: r.message_id,
    created_at: iso(r.created_at),
    authentication: parse(r.auth_json),
    attachments: results.map(presentAtt),
    size: r.raw_size,
    truncated: !!r.truncated,
  });
}

export async function deleteReceived(env: Env, id: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, storage FROM received_attachments WHERE email_id = ?1`,
  )
    .bind(id)
    .all<{ id: string; storage: string }>();
  const row = await env.DB.prepare(
    `SELECT raw_key FROM received_emails WHERE id = ?1`,
  )
    .bind(id)
    .first<{ raw_key: string | null }>();
  if (!row) throw err.notFound("Email not found.");
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM attachment_blobs WHERE attachment_id IN (SELECT id FROM received_attachments WHERE email_id = ?1)`,
    ).bind(id),
    env.DB.prepare(`DELETE FROM received_attachments WHERE email_id = ?1`).bind(
      id,
    ),
    env.DB.prepare(
      `DELETE FROM mail_messages WHERE direction = 'in' AND email_id = ?1`,
    ).bind(id),
    env.DB.prepare(`DELETE FROM received_emails WHERE id = ?1`).bind(id),
  ]);
  if (env.BUCKET) {
    const keys = [
      ...results
        .filter((a) => a.storage === "r2")
        .map((a) => `att/${id}/${a.id}`),
      ...(row.raw_key ? [row.raw_key] : []),
    ];
    if (keys.length) await env.BUCKET.delete(keys);
  }
  return json({ object: "email", id, deleted: true });
}

async function signature(env: Env, aid: string, exp: number): Promise<string> {
  if (!env.HASH_SECRET) throw new Error("HASH_SECRET is not set");
  return b64url(
    await hmac(new TextEncoder().encode(env.HASH_SECRET), `att.${aid}.${exp}`),
  );
}

/** Signed, expiring download URL for a received attachment (no auth needed). */
export async function signedAttachmentUrl(
  env: Env,
  origin: string,
  aid: string,
  ttlMs = URL_TTL_MS,
): Promise<{ url: string; exp: number }> {
  const exp = now() + ttlMs;
  return {
    url: `${origin}/attachments/${aid}?exp=${exp}&sig=${await signature(env, aid, exp)}`,
    exp,
  };
}

/** Bytes of a stored attachment (R2 or D1), or null when not stored. */
export async function readAttachmentBytes(
  env: Env,
  a: { id: string; email_id: string; storage: string },
): Promise<Uint8Array | null> {
  if (a.storage === "r2") {
    const obj = await env.BUCKET?.get(`att/${a.email_id}/${a.id}`);
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }
  if (a.storage !== "d1") return null;
  const blob = await env.DB.prepare(
    `SELECT data FROM attachment_blobs WHERE attachment_id = ?1`,
  )
    .bind(a.id)
    .first<{ data: ArrayBuffer | number[] }>();
  if (!blob) return null;
  return blob.data instanceof ArrayBuffer
    ? new Uint8Array(blob.data)
    : Uint8Array.from(blob.data);
}

export async function listAttachments(
  env: Env,
  emailId: string,
): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM received_attachments WHERE email_id = ?1`,
  )
    .bind(emailId)
    .all<AttRow>();
  return json({
    object: "list",
    has_more: false,
    data: results.map(presentAtt),
  });
}

export async function getAttachment(
  env: Env,
  req: Request,
  emailId: string,
  aid: string,
): Promise<Response> {
  const a = await env.DB.prepare(
    `SELECT * FROM received_attachments WHERE id = ?1 AND email_id = ?2`,
  )
    .bind(aid, emailId)
    .first<AttRow>();
  if (!a) throw err.notFound("Attachment not found.");
  const origin = env.PUBLIC_ORIGIN || new URL(req.url).origin;
  const signed = await signedAttachmentUrl(env, origin, a.id);
  const exp = signed.exp;
  const download_url = a.storage === "none" ? null : signed.url;
  return json({
    object: "attachment",
    ...presentAtt(a),
    download_url,
    expires_at: iso(exp),
  });
}

/** Public, signed download. */
export async function downloadAttachment(
  env: Env,
  url: URL,
  aid: string,
): Promise<Response> {
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (
    !Number.isFinite(exp) ||
    exp < now() ||
    !timingSafeEqual(sig, await signature(env, aid, exp))
  ) {
    return new Response("Link expired or invalid", { status: 403 });
  }
  const a = await env.DB.prepare(
    `SELECT * FROM received_attachments WHERE id = ?1`,
  )
    .bind(aid)
    .first<AttRow>();
  if (!a || a.storage === "none")
    return new Response("Not found", { status: 404 });
  const headers = {
    "content-type": a.content_type,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
  if (a.storage === "r2") {
    const obj = await env.BUCKET?.get(`att/${a.email_id}/${a.id}`);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, { headers });
  }
  const blob = await env.DB.prepare(
    `SELECT data FROM attachment_blobs WHERE attachment_id = ?1`,
  )
    .bind(aid)
    .first<{ data: ArrayBuffer | number[] }>();
  if (!blob) return new Response("Not found", { status: 404 });
  const body =
    blob.data instanceof ArrayBuffer ? blob.data : Uint8Array.from(blob.data);
  return new Response(body, { headers });
}
