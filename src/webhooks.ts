/**
 * Webhooks, signed exactly like Svix (which Resend uses), so any Resend
 * webhook receiver verifies them unchanged:
 *   svix-id, svix-timestamp, svix-signature: "v1,<base64 HMAC-SHA256>"
 *   signed content = `${id}.${timestamp}.${body}`, key = base64 after "whsec_".
 *
 * Delivery: first attempt right away (ctx.waitUntil); failures are retried
 * with backoff by processDue(), which runs on cron (optional), on inbound
 * mail and on API calls.
 */
import type { Env } from "./env";
import { err, json, readBody } from "./http";
import { b64, fromB64, hmac, iso, now, randomBytes, uuid } from "./util";

export const EVENTS = ["email.received", "email.sent", "email.failed"] as const;
export type EventType = (typeof EVENTS)[number];

/** Minutes until the next attempt after attempt N (1-based). */
const BACKOFF_MIN = [1, 5, 30, 120, 360, 720];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;

export function newSecret(): string {
  return `whsec_${b64(randomBytes(24))}`;
}

export async function sign(
  secret: string,
  id: string,
  ts: number,
  body: string,
): Promise<string> {
  const mac = await hmac(
    fromB64(secret.slice("whsec_".length)),
    `${id}.${ts}.${body}`,
  );
  return `v1,${b64(mac)}`;
}

interface HookRow {
  id: string;
  endpoint: string;
  events_json: string;
  secret: string;
  status: string;
  created_at: number;
}

/** Queue an event for every enabled webhook subscribed to it; returns delivery ids. */
export async function emit(
  env: Env,
  type: EventType,
  data: Record<string, unknown>,
): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, events_json FROM webhooks WHERE status = 'enabled'`,
  ).all<{ id: string; events_json: string }>();
  const hooks = results.filter((h) =>
    (JSON.parse(h.events_json) as string[]).includes(type),
  );
  if (!hooks.length) return [];
  const t = now();
  const payload = JSON.stringify({ type, created_at: iso(t), data });
  const ids = hooks.map(() => `msg_${uuid().replace(/-/g, "")}`);
  await env.DB.batch(
    hooks.map((h, i) =>
      env.DB.prepare(
        `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, next_attempt_at, created_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)`,
      ).bind(ids[i], h.id, type, payload, t),
    ),
  );
  return ids;
}

/** Try to deliver the given (or all due) pending deliveries. */
export async function deliver(
  env: Env,
  ids?: string[],
  limit = 10,
): Promise<number> {
  const rows = ids?.length
    ? (
        await env.DB.prepare(
          `SELECT d.id, d.payload, d.attempts, w.endpoint, w.secret FROM webhook_deliveries d
             JOIN webhooks w ON w.id = d.webhook_id
            WHERE d.id IN (SELECT value FROM json_each(?1)) AND d.status = 'pending'`,
        )
          .bind(JSON.stringify(ids))
          .all<Due>()
      ).results
    : (
        await env.DB.prepare(
          `SELECT d.id, d.payload, d.attempts, w.endpoint, w.secret FROM webhook_deliveries d
             JOIN webhooks w ON w.id = d.webhook_id
            WHERE d.status = 'pending' AND d.next_attempt_at <= ?1 AND w.status = 'enabled'
            ORDER BY d.next_attempt_at LIMIT ?2`,
        )
          .bind(now(), limit)
          .all<Due>()
      ).results;
  await Promise.all(rows.map((r) => attempt(env, r)));
  return rows.length;
}

interface Due {
  id: string;
  payload: string;
  attempts: number;
  endpoint: string;
  secret: string;
}

async function attempt(env: Env, d: Due): Promise<void> {
  const ts = Math.floor(now() / 1000);
  let status = 0;
  let error = "";
  try {
    const res = await fetch(d.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "cfmail-webhooks/1",
        "svix-id": d.id,
        "svix-timestamp": String(ts),
        "svix-signature": await sign(d.secret, d.id, ts, d.payload),
      },
      body: d.payload,
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (!res.ok) error = (await res.text()).slice(0, 300);
    else await res.body?.cancel();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const n = d.attempts + 1;
  const ok = status >= 200 && status < 300;
  const final = ok ? "delivered" : n >= MAX_ATTEMPTS ? "failed" : "pending";
  const next = now() + (BACKOFF_MIN[n - 1] ?? 720) * 60_000;
  await env.DB.prepare(
    `UPDATE webhook_deliveries SET status = ?2, attempts = ?3, next_attempt_at = ?4, last_status = ?5,
       last_error = ?6, delivered_at = ?7 WHERE id = ?1`,
  )
    .bind(
      d.id,
      final,
      n,
      next,
      status || null,
      error || null,
      ok ? now() : null,
    )
    .run();
  if (!ok)
    console.warn(
      "webhook_failed",
      d.id,
      d.endpoint,
      status,
      error.slice(0, 120),
    );
}

// ── API (full_access) ──────────────────────────────────────────────────────

function present(h: HookRow, withSecret = false) {
  return {
    object: "webhook",
    id: h.id,
    endpoint: h.endpoint,
    events: JSON.parse(h.events_json) as string[],
    status: h.status,
    created_at: iso(h.created_at),
    ...(withSecret ? { signing_secret: h.secret } : {}),
  };
}

export async function listWebhooks(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM webhooks ORDER BY created_at DESC`,
  ).all<HookRow>();
  return json({
    object: "list",
    has_more: false,
    data: results.map((h) => present(h)),
  });
}

export async function getWebhook(env: Env, id: string): Promise<Response> {
  const h = await env.DB.prepare(`SELECT * FROM webhooks WHERE id = ?1`)
    .bind(id)
    .first<HookRow>();
  if (!h) throw err.notFound("Webhook not found.");
  return json(present(h, true));
}

function cleanEndpoint(v: unknown): string {
  let u: URL;
  try {
    u = new URL(String(v));
  } catch {
    throw err.validation("`endpoint` must be a valid URL.");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
    throw err.validation("`endpoint` must use https.");
  }
  return u.toString();
}

function cleanEvents(v: unknown): string[] {
  const ev = Array.isArray(v) ? v.map(String) : [];
  if (!ev.length)
    throw err.validation("`events` must list at least one event.");
  const bad = ev.filter((e) => !(EVENTS as readonly string[]).includes(e));
  if (bad.length)
    throw err.validation(
      `Unsupported events: ${bad.join(", ")}. Supported: ${EVENTS.join(", ")}.`,
    );
  return [...new Set(ev)];
}

export async function createWebhook(req: Request, env: Env): Promise<Response> {
  const b = await readBody<{ endpoint?: unknown; events?: unknown }>(req);
  const h: HookRow = {
    id: uuid(),
    endpoint: cleanEndpoint(b.endpoint),
    events_json: JSON.stringify(cleanEvents(b.events)),
    secret: newSecret(),
    status: "enabled",
    created_at: now(),
  };
  await env.DB.prepare(
    `INSERT INTO webhooks (id, endpoint, events_json, secret, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(h.id, h.endpoint, h.events_json, h.secret, h.status, h.created_at)
    .run();
  return json({ object: "webhook", id: h.id, signing_secret: h.secret }, 201);
}

export async function updateWebhook(
  req: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const b = await readBody<{
    endpoint?: unknown;
    events?: unknown;
    status?: unknown;
  }>(req);
  const sets: string[] = [];
  const binds: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    binds.push(v);
    sets.push(`${col} = ?${binds.length}`);
  };
  if (b.endpoint !== undefined) set("endpoint", cleanEndpoint(b.endpoint));
  if (b.events !== undefined)
    set("events_json", JSON.stringify(cleanEvents(b.events)));
  if (b.status !== undefined) {
    if (b.status !== "enabled" && b.status !== "disabled")
      throw err.validation("`status` must be enabled or disabled.");
    set("status", b.status);
  }
  if (!sets.length) throw err.validation("Nothing to update.");
  const r = await env.DB.prepare(
    `UPDATE webhooks SET ${sets.join(", ")} WHERE id = ?1`,
  )
    .bind(...binds)
    .run();
  if (!r.meta.changes) throw err.notFound("Webhook not found.");
  return json({ object: "webhook", id });
}

export async function deleteWebhook(env: Env, id: string): Promise<Response> {
  const r = await env.DB.prepare(`DELETE FROM webhooks WHERE id = ?1`)
    .bind(id)
    .run();
  if (!r.meta.changes) throw err.notFound("Webhook not found.");
  return json({ object: "webhook", id, deleted: true });
}

export async function listDeliveries(env: Env, id: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, event_type, status, attempts, last_status, last_error, created_at, delivered_at, next_attempt_at
       FROM webhook_deliveries WHERE webhook_id = ?1 ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return json({ object: "list", data: results });
}
