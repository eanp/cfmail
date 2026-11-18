/**
 * Webmail: mailboxes, conversations (threads), folders, read/star state,
 * compose / reply / forward. Inbound mail is filed into mailboxes by its
 * envelope recipient when it arrives (fileInbound, called from inbound.ts).
 *
 * Access: a user sees a mailbox only if they are in mailbox_members, and
 * sends from it only with can_send = 1. Everything else answers 404.
 */
import type { Env } from "./env";
import { ApiError, err, json, readBody } from "./http";
import {
  readAttachmentBytes,
  signedAttachmentUrl,
  type AttRow,
} from "./received";
import { prepare, sendOne } from "./send";
import type { SessionUser } from "./session";
import { domainOf, guessType, iso, now, parseAddress, uuid } from "./util";

export const FOLDERS = ["inbox", "sent", "archive", "spam", "trash"] as const;
export type Folder = (typeof FOLDERS)[number];
/** Per-user sending cap from webmail (protects domain reputation). */
export const DAILY_SEND_LIMIT = 300;
const MAX_COMPOSE_BYTES = 15 * 1024 * 1024;

// ── helpers (pure, unit-tested) ───────────────────────────────────────────

/** All `<id>` values in header value(s), without brackets. */
export function messageIds(v: string | string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const line of Array.isArray(v) ? v : v ? [v] : [])
    for (const m of line.matchAll(/<([^<>\s]+)>/g)) out.push(m[1]!);
  return out;
}

export function snippetOf(text: string | null, html: string | null): string {
  const src =
    text ??
    (html ?? "")
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  return src.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Spam verdict from Cloudflare's SPF/DKIM/DMARC results. */
export function looksSpoofed(
  auth: { spf?: string; dkim?: string; dmarc?: string } | null,
): boolean {
  if (!auth) return false;
  if (auth.dmarc === "fail") return true;
  return (
    (auth.spf === "fail" || auth.spf === "softfail") && auth.dkim === "fail"
  );
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text → simple HTML (escaped, links, line breaks). */
export function textToHtml(text: string): string {
  const linked = escapeHtml(text).replace(
    /\bhttps?:\/\/[^\s<>"]+/g,
    (u) => `<a href="${u}">${u}</a>`,
  );
  return `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${linked}</div>`;
}

/** "Re: " / "Fwd: " once, not stacked. */
export function prefixSubject(prefix: "Re" | "Fwd", subject: string): string {
  const s = subject.trim();
  return new RegExp(`^${prefix}:`, "i").test(s) ? s : `${prefix}: ${s}`;
}

/** Folder a message moves to after an action (null = not allowed). */
export function nextFolder(
  current: Folder,
  direction: "in" | "out",
  action: string,
  prev: Folder | null,
): Folder | null {
  switch (action) {
    case "archive":
      return direction === "in" && current !== "archive" ? "archive" : null;
    case "inbox":
      return direction === "in" ? "inbox" : "sent";
    case "spam":
      return direction === "in" ? "spam" : null;
    case "trash":
      return current === "trash" ? null : "trash";
    case "restore":
      return current === "trash"
        ? (prev ?? (direction === "in" ? "inbox" : "sent"))
        : null;
    default:
      return null;
  }
}

// ── inbound filing ─────────────────────────────────────────────────────────

/** Mailbox ids for an envelope recipient: exact address, else catch-all. */
export async function mailboxesFor(env: Env, rcpt: string): Promise<string[]> {
  const a = rcpt.toLowerCase();
  const { results } = await env.DB.prepare(
    `SELECT id, address FROM mailboxes WHERE address IN (?1, ?2)`,
  )
    .bind(a, `*@${domainOf(a)}`)
    .all<{ id: string; address: string }>();
  const exact = results.filter((r) => r.address === a);
  return (exact.length ? exact : results).map((r) => r.id);
}

/** Thread of a message: the thread of any message it references, else a new one. */
export async function threadKeyFor(
  env: Env,
  mailboxId: string,
  own: string | null,
  inReplyTo: string[],
  refs: string[],
): Promise<string> {
  const related = [...new Set([...inReplyTo, ...refs])].slice(-50);
  if (related.length) {
    const hit = await env.DB.prepare(
      `SELECT thread_key FROM mail_messages
        WHERE mailbox_id = ?1 AND message_id IN (SELECT value FROM json_each(?2))
        ORDER BY created_at LIMIT 1`,
    )
      .bind(mailboxId, JSON.stringify(related))
      .first<{ thread_key: string }>();
    if (hit) return hit.thread_key;
  }
  return refs[0] ?? inReplyTo[0] ?? own ?? `local:${uuid()}`;
}

export interface InboundInfo {
  emailId: string;
  envelopeTo: string;
  messageId: string | null;
  headers: Record<string, string | string[]>;
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  attachments: number;
  auth: { spf?: string; dkim?: string; dmarc?: string } | null;
  createdAt: number;
}

export async function fileInbound(env: Env, m: InboundInfo): Promise<number> {
  const boxes = await mailboxesFor(env, m.envelopeTo);
  if (!boxes.length) return 0;
  const own = m.messageId ? (messageIds(m.messageId)[0] ?? m.messageId) : null;
  const inReplyTo = messageIds(m.headers["in-reply-to"]);
  const refs = messageIds(m.headers["references"]);
  const folder: Folder = looksSpoofed(m.auth) ? "spam" : "inbox";
  const snippet = snippetOf(m.text, m.html);
  const stmts = [];
  for (const box of boxes) {
    const key = await threadKeyFor(env, box, own, inReplyTo, refs);
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO mail_messages (id, mailbox_id, direction, email_id, folder, message_id, thread_key,
           from_addr, to_json, subject, snippet, has_attachments, created_at)
         VALUES (?1, ?2, 'in', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        uuid(),
        box,
        m.emailId,
        folder,
        own,
        key,
        m.from,
        JSON.stringify(m.to),
        m.subject,
        snippet,
        m.attachments ? 1 : 0,
        m.createdAt,
      ),
    );
  }
  await env.DB.batch(stmts);
  return boxes.length;
}

// ── access ─────────────────────────────────────────────────────────────────

interface Mailbox {
  id: string;
  address: string;
  name: string;
  signature: string | null;
  can_send: number;
}

async function mailbox(
  env: Env,
  user: SessionUser,
  id: string | null,
): Promise<Mailbox> {
  const box = id
    ? await env.DB.prepare(
        `SELECT b.*, m.can_send FROM mailboxes b JOIN mailbox_members m ON m.mailbox_id = b.id
          WHERE b.id = ?1 AND m.user_id = ?2`,
      )
        .bind(id, user.id)
        .first<Mailbox>()
    : null;
  if (!box) throw err.notFound("Mailbox not found.");
  return box;
}

interface MsgRow {
  id: string;
  mailbox_id: string;
  direction: "in" | "out";
  email_id: string;
  folder: Folder;
  prev_folder: Folder | null;
  message_id: string | null;
  thread_key: string;
  from_addr: string;
  to_json: string;
  subject: string | null;
  snippet: string | null;
  has_attachments: number;
  read_at: number | null;
  starred: number;
  created_at: number;
}

async function messageFor(
  env: Env,
  user: SessionUser,
  id: string,
): Promise<MsgRow> {
  const m = await env.DB.prepare(
    `SELECT mm.* FROM mail_messages mm
       JOIN mailbox_members mb ON mb.mailbox_id = mm.mailbox_id AND mb.user_id = ?2
      WHERE mm.id = ?1`,
  )
    .bind(id, user.id)
    .first<MsgRow>();
  if (!m) throw err.notFound("Message not found.");
  return m;
}

// ── API (session, permission mail:use) ─────────────────────────────────────

export async function listMailboxes(
  env: Env,
  user: SessionUser,
): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.address, b.name, b.signature, m.can_send,
            (SELECT COUNT(*) FROM mail_messages x WHERE x.mailbox_id = b.id AND x.folder = 'inbox' AND x.read_at IS NULL) AS unread,
            (SELECT COUNT(*) FROM mail_messages x WHERE x.mailbox_id = b.id AND x.folder = 'spam' AND x.read_at IS NULL) AS spam_unread
       FROM mailboxes b JOIN mailbox_members m ON m.mailbox_id = b.id
      WHERE m.user_id = ?1 ORDER BY b.address`,
  )
    .bind(user.id)
    .all();
  return json({ data: results });
}

function likeTerm(q: string): string {
  return `%${q.replace(/[%_\\]/g, "").slice(0, 80)}%`;
}

export async function listThreads(
  env: Env,
  user: SessionUser,
  url: URL,
): Promise<Response> {
  const box = await mailbox(env, user, url.searchParams.get("mailbox"));
  const folder = url.searchParams.get("folder") ?? "inbox";
  const q = (url.searchParams.get("q") ?? "").trim();
  const before = Number(url.searchParams.get("before")) || null;
  const binds: unknown[] = [box.id];
  let cond: string;
  if (folder === "starred") cond = `starred = 1 AND folder != 'trash'`;
  else if (folder === "all") cond = `folder NOT IN ('trash', 'spam')`;
  else if ((FOLDERS as readonly string[]).includes(folder)) {
    binds.push(folder);
    cond = `folder = ?${binds.length}`;
  } else throw err.validation("Unknown folder.");
  if (q) {
    binds.push(likeTerm(q));
    const n = binds.length;
    cond += ` AND (subject LIKE ?${n} OR from_addr LIKE ?${n} OR to_json LIKE ?${n} OR snippet LIKE ?${n})`;
  }
  binds.push(before);
  const b = binds.length;
  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT mm.*,
              ROW_NUMBER() OVER (PARTITION BY thread_key ORDER BY created_at DESC) AS rn,
              COUNT(*) OVER (PARTITION BY thread_key) AS n,
              SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) OVER (PARTITION BY thread_key) AS unread,
              MAX(starred) OVER (PARTITION BY thread_key) AS any_star,
              MAX(has_attachments) OVER (PARTITION BY thread_key) AS any_att
         FROM mail_messages mm WHERE mailbox_id = ?1 AND ${cond}
     ) WHERE rn = 1 AND (?${b} IS NULL OR created_at < ?${b})
     ORDER BY created_at DESC LIMIT 51`,
  )
    .bind(...binds)
    .all<
      MsgRow & { n: number; unread: number; any_star: number; any_att: number }
    >();
  const rows = results.slice(0, 50);
  return json({
    has_more: results.length > 50,
    data: rows.map((r) => ({
      thread_key: r.thread_key,
      latest_id: r.id,
      direction: r.direction,
      from: r.from_addr,
      to: JSON.parse(r.to_json) as string[],
      subject: r.subject,
      snippet: r.snippet,
      count: r.n,
      unread: r.unread,
      starred: r.any_star === 1,
      has_attachments: r.any_att === 1,
      created_at: r.created_at,
    })),
  });
}

const REMOTE_IMG =
  /(?:src|background)\s*=\s*["']?\s*https?:|url\(\s*["']?https?:/i;

export async function getThread(
  env: Env,
  user: SessionUser,
  url: URL,
): Promise<Response> {
  const box = await mailbox(env, user, url.searchParams.get("mailbox"));
  const key = url.searchParams.get("key") ?? "";
  const inTrash = url.searchParams.get("folder") === "trash";
  const { results } = await env.DB.prepare(
    `SELECT * FROM mail_messages WHERE mailbox_id = ?1 AND thread_key = ?2
        AND (folder = 'trash') = ?3 ORDER BY created_at`,
  )
    .bind(box.id, key, inTrash ? 1 : 0)
    .all<MsgRow>();
  if (!results.length) throw err.notFound("Conversation not found.");
  const origin = env.PUBLIC_ORIGIN || url.origin;
  const out = [];
  for (const m of results) {
    if (m.direction === "in") {
      const r = await env.DB.prepare(
        `SELECT cc_json, reply_to_json, received_for_json, auth_json, html, text IS NOT NULL AS has_text, headers_json
           FROM received_emails WHERE id = ?1`,
      )
        .bind(m.email_id)
        .first<{
          cc_json: string | null;
          reply_to_json: string | null;
          received_for_json: string;
          auth_json: string | null;
          html: string | null;
          headers_json: string;
        }>();
      const { results: atts } = await env.DB.prepare(
        `SELECT * FROM received_attachments WHERE email_id = ?1`,
      )
        .bind(m.email_id)
        .all<AttRow>();
      const headers = r
        ? (JSON.parse(r.headers_json) as Record<string, string | string[]>)
        : {};
      out.push({
        ...present(m),
        cc: r?.cc_json ? JSON.parse(r.cc_json) : [],
        reply_to: r?.reply_to_json ? JSON.parse(r.reply_to_json) : [],
        received_for: r ? JSON.parse(r.received_for_json) : [],
        authentication: r?.auth_json ? JSON.parse(r.auth_json) : null,
        has_remote_images: !!r?.html && REMOTE_IMG.test(r.html),
        references: messageIds(headers["references"]),
        attachments: await Promise.all(
          atts
            .filter((a) => a.disposition !== "inline" || !a.content_id)
            .map(async (a) => ({
              id: a.id,
              filename: a.filename,
              content_type: a.content_type,
              size: a.size,
              url:
                a.storage === "none"
                  ? null
                  : (await signedAttachmentUrl(env, origin, a.id)).url,
            })),
        ),
      });
    } else {
      const s = await env.DB.prepare(
        `SELECT e.cc_json, e.status, e.error, b.attachments_json FROM sent_emails e
           LEFT JOIN sent_bodies b ON b.email_id = e.id WHERE e.id = ?1`,
      )
        .bind(m.email_id)
        .first<{
          cc_json: string | null;
          status: string;
          error: string | null;
          attachments_json: string | null;
        }>();
      out.push({
        ...present(m),
        cc: s?.cc_json ? JSON.parse(s.cc_json) : [],
        status: s?.status ?? null,
        error: s?.error ?? null,
        has_remote_images: false,
        attachments: s?.attachments_json ? JSON.parse(s.attachments_json) : [],
      });
    }
  }
  const unread = results.filter((m) => m.read_at === null).map((m) => m.id);
  if (unread.length) {
    await env.DB.prepare(
      `UPDATE mail_messages SET read_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))`,
    )
      .bind(JSON.stringify(unread), now())
      .run();
  }
  return json({ thread_key: key, messages: out });
}

function present(m: MsgRow) {
  return {
    id: m.id,
    direction: m.direction,
    folder: m.folder,
    from: m.from_addr,
    to: JSON.parse(m.to_json) as string[],
    subject: m.subject,
    snippet: m.snippet,
    message_id: m.message_id,
    starred: m.starred === 1,
    created_at: iso(m.created_at),
  };
}

/**
 * The message body as a standalone document, shown in a sandboxed iframe.
 * No scripts, no forms, no same-origin; remote images only with ?images=1.
 */
export async function messageBody(
  env: Env,
  user: SessionUser,
  id: string,
  url: URL,
): Promise<Response> {
  const m = await messageFor(env, user, id);
  const origin = env.PUBLIC_ORIGIN || url.origin;
  let html: string | null;
  let text: string | null;
  if (m.direction === "in") {
    const r = await env.DB.prepare(
      `SELECT html, text FROM received_emails WHERE id = ?1`,
    )
      .bind(m.email_id)
      .first<{ html: string | null; text: string | null }>();
    html = r?.html ?? null;
    text = r?.text ?? null;
    if (html && html.includes("cid:")) {
      const { results } = await env.DB.prepare(
        `SELECT id, content_id FROM received_attachments WHERE email_id = ?1 AND content_id IS NOT NULL AND storage != 'none'`,
      )
        .bind(m.email_id)
        .all<{ id: string; content_id: string }>();
      for (const a of results) {
        const signed = await signedAttachmentUrl(env, origin, a.id, 1800_000);
        html = html.split(`cid:${a.content_id}`).join(signed.url);
      }
    }
  } else {
    const r = await env.DB.prepare(
      `SELECT html, text FROM sent_bodies WHERE email_id = ?1`,
    )
      .bind(m.email_id)
      .first<{ html: string | null; text: string | null }>();
    html = r?.html ?? null;
    text = r?.text ?? null;
  }
  const images = url.searchParams.get("images") === "1";
  const content = html
    ? html
    : `<pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,monospace">${escapeHtml(text ?? "")}</pre>`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;color:#111;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${content}</body></html>`;
  return new Response(doc, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": [
        "sandbox allow-popups allow-popups-to-escape-sandbox",
        "default-src 'none'",
        `img-src data: ${origin}${images ? " https: http:" : ""}`,
        "style-src 'unsafe-inline'",
        "font-src data:",
        "form-action 'none'",
        "frame-ancestors 'self'",
      ].join("; "),
    },
  });
}

export async function mailAction(
  env: Env,
  user: SessionUser,
  req: Request,
): Promise<Response> {
  const b = await readBody<{ ids?: unknown; action?: unknown }>(req);
  const ids = Array.isArray(b.ids)
    ? b.ids.filter((x): x is string => typeof x === "string").slice(0, 500)
    : [];
  const action = String(b.action ?? "");
  if (!ids.length) throw err.validation("No messages selected.");
  const { results } = await env.DB.prepare(
    `SELECT mm.* FROM mail_messages mm
       JOIN mailbox_members mb ON mb.mailbox_id = mm.mailbox_id AND mb.user_id = ?2
      WHERE mm.id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify(ids), user.id)
    .all<MsgRow>();
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  const upd = (sql: string, ...args: unknown[]) =>
    stmts.push(env.DB.prepare(sql).bind(...args));
  for (const m of results) {
    switch (action) {
      case "read":
        upd(`UPDATE mail_messages SET read_at = ?2 WHERE id = ?1`, m.id, t);
        break;
      case "unread":
        upd(`UPDATE mail_messages SET read_at = NULL WHERE id = ?1`, m.id);
        break;
      case "star":
      case "unstar":
        upd(
          `UPDATE mail_messages SET starred = ?2 WHERE id = ?1`,
          m.id,
          action === "star" ? 1 : 0,
        );
        break;
      case "delete":
        if (m.folder === "trash")
          upd(`DELETE FROM mail_messages WHERE id = ?1`, m.id);
        break;
      default: {
        const to = nextFolder(m.folder, m.direction, action, m.prev_folder);
        if (
          !to &&
          !["archive", "inbox", "spam", "trash", "restore"].includes(action)
        )
          throw err.validation("Unknown action.");
        if (to && to !== m.folder)
          upd(
            `UPDATE mail_messages SET folder = ?2, prev_folder = ?3 WHERE id = ?1`,
            m.id,
            to,
            m.folder,
          );
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ updated: stmts.length });
}

interface ComposeBody {
  mailbox_id?: unknown;
  from_address?: unknown;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  text?: unknown;
  reply_to_id?: unknown;
  forward_id?: unknown;
  attachments?: unknown;
}

export async function sendMail(
  env: Env,
  user: SessionUser,
  req: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  const b = await readBody<ComposeBody>(req, MAX_COMPOSE_BYTES * 1.4);
  const box = await mailbox(
    env,
    user,
    typeof b.mailbox_id === "string" ? b.mailbox_id : null,
  );
  if (!box.can_send)
    throw new ApiError(403, "forbidden", "You cannot send from this mailbox.");
  const sentToday = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sent_emails WHERE user_id = ?1 AND created_at > ?2`,
  )
    .bind(user.id, now() - 86_400_000)
    .first<{ n: number }>();
  if ((sentToday?.n ?? 0) >= DAILY_SEND_LIMIT)
    throw new ApiError(
      429,
      "daily_quota_exceeded",
      `Webmail limit: ${DAILY_SEND_LIMIT} emails per user per day.`,
    );

  // From: the mailbox address; a catch-all mailbox sends as any local part.
  let fromEmail = box.address;
  if (box.address.startsWith("*@")) {
    const wanted = String(b.from_address ?? "")
      .trim()
      .toLowerCase();
    if (!wanted || domainOf(wanted) !== box.address.slice(2))
      throw err.validation(
        `Choose a From address @${box.address.slice(2)} for this catch-all mailbox.`,
      );
    fromEmail = parseAddress(wanted).email;
  }

  const parentId =
    typeof b.reply_to_id === "string"
      ? b.reply_to_id
      : typeof b.forward_id === "string"
        ? b.forward_id
        : null;
  const parent = parentId ? await messageFor(env, user, parentId) : null;
  if (parent && parent.mailbox_id !== box.id)
    throw err.validation("That message is in another mailbox.");

  let text = typeof b.text === "string" ? b.text : "";
  if (box.signature) text += `\n\n-- \n${box.signature}`;
  const headers: Record<string, string> = {};
  const ownId = `${uuid()}@${domainOf(fromEmail)}`;
  headers["Message-ID"] = `<${ownId}>`;
  const attachments: Record<string, unknown>[] = [];

  if (parent && typeof b.reply_to_id === "string" && parent.message_id) {
    let refs: string[] = [];
    if (parent.direction === "in") {
      const r = await env.DB.prepare(
        `SELECT headers_json FROM received_emails WHERE id = ?1`,
      )
        .bind(parent.email_id)
        .first<{ headers_json: string }>();
      if (r)
        refs = messageIds(
          (JSON.parse(r.headers_json) as Record<string, string | string[]>)[
            "references"
          ],
        );
    }
    refs = [
      ...refs.filter((x) => x !== parent.message_id),
      parent.message_id,
    ].slice(-20);
    headers["In-Reply-To"] = `<${parent.message_id}>`;
    headers["References"] = refs.map((x) => `<${x}>`).join(" ");
  }
  if (parent && typeof b.forward_id === "string") {
    if (parent.direction === "in") {
      const r = await env.DB.prepare(
        `SELECT text, html FROM received_emails WHERE id = ?1`,
      )
        .bind(parent.email_id)
        .first<{ text: string | null; html: string | null }>();
      text += `\n\n---------- Forwarded message ----------\nFrom: ${parent.from_addr}\nDate: ${iso(parent.created_at)}\nSubject: ${parent.subject ?? ""}\n\n${r?.text ?? snippetOf(null, r?.html ?? null)}`;
      const { results } = await env.DB.prepare(
        `SELECT * FROM received_attachments WHERE email_id = ?1 AND storage != 'none'`,
      )
        .bind(parent.email_id)
        .all<AttRow>();
      for (const a of results) {
        const bytes = await readAttachmentBytes(env, a);
        if (bytes)
          attachments.push({
            filename: a.filename,
            content: [...bytes],
            content_type: a.content_type,
            ...(a.content_id ? { content_id: a.content_id } : {}),
          });
      }
    }
  }
  if (Array.isArray(b.attachments)) {
    for (const a of b.attachments as {
      filename?: unknown;
      content?: unknown;
      content_type?: unknown;
    }[]) {
      attachments.push({
        filename: a.filename,
        content: a.content,
        content_type:
          typeof a.content_type === "string" && a.content_type
            ? a.content_type
            : guessType(String(a.filename ?? "")),
      });
    }
  }

  const name = box.name.replace(/[<>"]/g, "");
  const p = prepare(
    {
      from: name ? `${name} <${fromEmail}>` : fromEmail,
      to: b.to,
      cc: b.cc,
      bcc: b.bcc,
      subject: b.subject,
      text,
      html: textToHtml(text),
      headers,
      attachments,
    },
    [],
  );
  const r = await sendOne(env, { apiKeyId: null, userId: user.id }, p, ctx);
  if (r.error) throw r.error;
  // Replies join the parent's conversation; new mail and forwards start one.
  const threadKey =
    parent && typeof b.reply_to_id === "string" ? parent.thread_key : ownId;
  await env.DB.prepare(
    `INSERT INTO mail_messages (id, mailbox_id, direction, email_id, folder, message_id, thread_key, from_addr,
       to_json, subject, snippet, has_attachments, sent_by, read_at, created_at)
     VALUES (?1, ?2, 'out', ?3, 'sent', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
  )
    .bind(
      uuid(),
      box.id,
      r.id,
      ownId,
      threadKey,
      p.from.name ? `${p.from.name} <${p.from.email}>` : p.from.email,
      JSON.stringify(
        [...p.to, ...p.cc].map((a) =>
          a.name ? `${a.name} <${a.email}>` : a.email,
        ),
      ),
      p.subject,
      snippetOf(p.text ?? null, null),
      p.attachments.length ? 1 : 0,
      user.id,
      now(),
    )
    .run();
  return json({ id: r.id });
}
