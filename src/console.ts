/**
 * Dashboard + webmail JSON API under /app/api/*, for the UI in public/app.
 * Cookie sessions (session.ts), RBAC permissions (permissions.ts). Every
 * route declares its guard; there is no default allow.
 *
 * The Resend-compatible API (Bearer API keys) is separate: see index.ts.
 */
import { createKey, keyInput, listKeys, revokeKey } from "./auth";
import { audit } from "./audit";
import { list, VERSION, type Env } from "./env";
import { ApiError, err, json, readBody, Router } from "./http";
import {
  getThread,
  listMailboxes,
  listThreads,
  mailAction,
  messageBody,
  sendMail,
} from "./mail";
import {
  hashPassword,
  passwordProblem,
  verifyPassword,
  DUMMY_HASH,
} from "./password";
import {
  ADMIN_ROLE,
  ALL_PERMISSIONS,
  effectivePermissions,
  isPermission,
  isRoleKey,
  PERMISSIONS,
  ungrantable,
  type Permission,
} from "./permissions";
import { getAttachment, getReceived, listReceived } from "./received";
import { getSent, listSent, prepare, sendMode, sendOne } from "./send";
import {
  assertSameOrigin,
  createSession,
  deleteUserSessions,
  newToken,
  readSession,
  sessionCookie,
  tokenHash,
  type SessionUser,
} from "./session";
import { domainOf, iso, now, parseAddress, uuid } from "./util";
import {
  createWebhook,
  deleteWebhook,
  deliver,
  getWebhook,
  listDeliveries,
  listWebhooks,
  updateWebhook,
} from "./webhooks";

interface C {
  req: Request;
  url: URL;
  env: Env;
  ctx: ExecutionContext;
  user: SessionUser | null;
}
type P = Record<string, string>;
type H<T> = (c: C & T, p: P) => Promise<Response>;

const pub = (fn: H<object>) => fn as H<object>;
const auth =
  (fn: H<{ user: SessionUser }>): H<object> =>
  async (c, p) => {
    if (!c.user)
      throw new ApiError(401, "unauthorized", "Please sign in again.");
    return fn(c as C & { user: SessionUser }, p);
  };
const can = (perm: Permission, fn: H<{ user: SessionUser }>): H<object> =>
  auth(async (c, p) => {
    if (!c.user.permissions.includes(perm))
      throw new ApiError(403, "forbidden", `Missing permission ${perm}.`);
    return fn(c, p);
  });

const INVITE_TTL = 7 * 24 * 3600_000;
const RESET_TTL = 3600_000;
const LOCKOUT = { window: 15 * 60_000, max: 10 };

const str = (v: unknown, max = 200) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

function origin(c: C): string {
  return (c.env.PUBLIC_ORIGIN || c.url.origin).replace(/\/+$/, "");
}

/** Create an invite/reset link (older links of the same purpose die). */
async function issueLink(
  c: C,
  userId: string,
  purpose: "invite" | "reset",
): Promise<string> {
  const token = newToken();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM user_tokens WHERE user_id = ?1 AND purpose = ?2`,
    ).bind(userId, purpose),
    c.env.DB.prepare(
      `INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(
      await tokenHash(c.env, "link", token),
      userId,
      purpose,
      now() + (purpose === "invite" ? INVITE_TTL : RESET_TTL),
      now(),
    ),
  ]);
  return `${origin(c)}/app/#/${purpose}/${token}`;
}

/** Email a link when SYSTEM_FROM is configured. Returns whether it was sent. */
async function mailLink(
  c: C,
  to: string,
  purpose: "invite" | "reset",
  link: string,
): Promise<boolean> {
  if (!c.env.SYSTEM_FROM) return false;
  const subject =
    purpose === "invite"
      ? "You are invited to cfmail"
      : "Reset your cfmail password";
  const text =
    purpose === "invite"
      ? `You have been invited to the cfmail dashboard at ${origin(c)}.\n\nSet your password (link valid for 7 days):\n${link}\n`
      : `Someone asked to reset your cfmail password.\n\nSet a new password (link valid for 1 hour):\n${link}\n\nIf this wasn't you, ignore this email.`;
  try {
    const p = prepare(
      { from: c.env.SYSTEM_FROM, to, subject, text },
      list(c.env.SEND_DOMAINS),
    );
    const r = await sendOne(c.env, { apiKeyId: null }, p, c.ctx);
    return !r.error;
  } catch (e) {
    console.error("system_mail_failed", purpose, e);
    return false;
  }
}

function assertPassword(pw: unknown, email: string): string {
  const problem = passwordProblem(pw, email);
  if (problem) throw err.validation(problem);
  return pw as string;
}

async function rolePermissions(env: Env, key: string): Promise<Permission[]> {
  const { results } = await env.DB.prepare(
    `SELECT permission FROM role_permissions WHERE role_key = ?1`,
  )
    .bind(key)
    .all<{ permission: string }>();
  return effectivePermissions(
    key,
    results.map((r) => r.permission),
  );
}

/** Actor may assign a role only if they hold every permission it grants. */
async function assertAssignable(c: C & { user: SessionUser }, role: string) {
  const exists = await c.env.DB.prepare(`SELECT 1 FROM roles WHERE key = ?1`)
    .bind(role)
    .first();
  if (!exists) throw err.validation("Unknown role.");
  const missing = ungrantable(
    c.user.permissions,
    await rolePermissions(c.env, role),
  );
  if (missing.length)
    throw new ApiError(
      403,
      "forbidden",
      `You cannot assign a role with permissions you do not have: ${missing.join(", ")}.`,
    );
}

async function activeAdmins(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE role = ?1 AND disabled_at IS NULL`,
  )
    .bind(ADMIN_ROLE)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

const router = new Router<C>()
  // ── auth ────────────────────────────────────────────────────────────────
  .on(
    "GET",
    "/app/api/me",
    auth(async (c) =>
      json({
        user: {
          id: c.user.id,
          email: c.user.email,
          name: c.user.name,
          role: c.user.role,
          role_name: c.user.roleName,
          permissions: c.user.permissions,
        },
        system: {
          version: VERSION,
          sending: sendMode(c.env),
          attachments: c.env.BUCKET ? "r2" : "d1",
          system_mail: !!c.env.SYSTEM_FROM,
        },
      }),
    ),
  )
  .on(
    "POST",
    "/app/api/auth/login",
    pub(async (c) => {
      const b = await readBody<{ email?: unknown; password?: unknown }>(c.req);
      const email = str(b.email, 254).toLowerCase();
      const password = typeof b.password === "string" ? b.password : "";
      const since = now() - LOCKOUT.window;
      const fails = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM auth_failures WHERE email = ?1 AND at > ?2`,
      )
        .bind(email, since)
        .first<{ n: number }>();
      if ((fails?.n ?? 0) >= LOCKOUT.max)
        throw new ApiError(
          429,
          "rate_limit_exceeded",
          "Too many failed attempts. Try again in 15 minutes.",
        );
      const u = await c.env.DB.prepare(
        `SELECT id, email, password_hash, disabled_at FROM users WHERE email = ?1`,
      )
        .bind(email)
        .first<{
          id: string;
          email: string;
          password_hash: string | null;
          disabled_at: number | null;
        }>();
      const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
      if (!u || !ok || !u.password_hash || u.disabled_at) {
        await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO auth_failures (email, at) VALUES (?1, ?2)`,
          ).bind(email, now()),
          c.env.DB.prepare(`DELETE FROM auth_failures WHERE at < ?1`).bind(
            now() - 24 * 3600_000,
          ),
        ]);
        throw new ApiError(
          401,
          "invalid_credentials",
          "Wrong email or password.",
        );
      }
      await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM auth_failures WHERE email = ?1`).bind(
          email,
        ),
        c.env.DB.prepare(
          `UPDATE users SET last_login_at = ?2 WHERE id = ?1`,
        ).bind(u.id, now()),
        c.env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(
          now(),
        ),
      ]);
      const cookie = await createSession(c.env, c.req, u.id);
      await audit(c.env, u, "auth.login", u.email);
      return json({ ok: true }, 200, { "set-cookie": cookie });
    }),
  )
  .on(
    "POST",
    "/app/api/auth/logout",
    pub(async (c) => {
      if (c.user)
        await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?1`)
          .bind(c.user.sessionId)
          .run();
      return json({ ok: true }, 200, {
        "set-cookie": sessionCookie(c.req, "", 0),
      });
    }),
  )
  .on(
    "POST",
    "/app/api/auth/password",
    auth(async (c) => {
      const b = await readBody<{ current?: unknown; password?: unknown }>(
        c.req,
      );
      const row = await c.env.DB.prepare(
        `SELECT password_hash FROM users WHERE id = ?1`,
      )
        .bind(c.user.id)
        .first<{ password_hash: string | null }>();
      if (
        !row?.password_hash ||
        !(await verifyPassword(String(b.current ?? ""), row.password_hash))
      )
        throw err.validation("Current password is wrong.");
      const pw = assertPassword(b.password, c.user.email);
      await c.env.DB.prepare(
        `UPDATE users SET password_hash = ?2 WHERE id = ?1`,
      )
        .bind(c.user.id, await hashPassword(pw))
        .run();
      await deleteUserSessions(c.env, c.user.id, c.user.sessionId);
      await audit(c.env, c.user, "auth.password_change", c.user.email);
      return json({ ok: true });
    }),
  )
  .on(
    "GET",
    "/app/api/auth/link/:token",
    pub(async (c, p) => {
      const t = await c.env.DB.prepare(
        `SELECT t.purpose, u.email, u.name FROM user_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ?1 AND t.used_at IS NULL AND t.expires_at > ?2 AND u.disabled_at IS NULL`,
      )
        .bind(await tokenHash(c.env, "link", p.token!), now())
        .first<{ purpose: string; email: string; name: string }>();
      if (!t) throw err.notFound("This link is invalid or has expired.");
      return json(t);
    }),
  )
  .on(
    "POST",
    "/app/api/auth/link/:token",
    pub(async (c, p) => {
      const b = await readBody<{ password?: unknown }>(c.req);
      const hash = await tokenHash(c.env, "link", p.token!);
      const t = await c.env.DB.prepare(
        `SELECT t.user_id, t.purpose, u.email FROM user_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ?1 AND t.used_at IS NULL AND t.expires_at > ?2 AND u.disabled_at IS NULL`,
      )
        .bind(hash, now())
        .first<{ user_id: string; purpose: string; email: string }>();
      if (!t) throw err.notFound("This link is invalid or has expired.");
      const pw = assertPassword(b.password, t.email);
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE users SET password_hash = ?2, last_login_at = ?3 WHERE id = ?1`,
        ).bind(t.user_id, await hashPassword(pw), now()),
        c.env.DB.prepare(
          `UPDATE user_tokens SET used_at = ?2 WHERE token_hash = ?1`,
        ).bind(hash, now()),
        c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(
          t.user_id,
        ),
      ]);
      await audit(
        c.env,
        { id: t.user_id, email: t.email },
        t.purpose === "invite" ? "auth.invite_accept" : "auth.password_reset",
        t.email,
      );
      const cookie = await createSession(c.env, c.req, t.user_id);
      return json({ ok: true }, 200, { "set-cookie": cookie });
    }),
  )
  .on(
    "POST",
    "/app/api/auth/forgot",
    pub(async (c) => {
      const b = await readBody<{ email?: unknown }>(c.req);
      const email = str(b.email, 254).toLowerCase();
      const u = await c.env.DB.prepare(
        `SELECT id FROM users WHERE email = ?1 AND disabled_at IS NULL AND password_hash IS NOT NULL`,
      )
        .bind(email)
        .first<{ id: string }>();
      if (u && c.env.SYSTEM_FROM) {
        // At most one reset email per 10 minutes per user.
        const recent = await c.env.DB.prepare(
          `SELECT 1 FROM user_tokens WHERE user_id = ?1 AND purpose = 'reset' AND created_at > ?2`,
        )
          .bind(u.id, now() - 600_000)
          .first();
        if (!recent) {
          const link = await issueLink(c, u.id, "reset");
          await mailLink(c, email, "reset", link);
        }
      }
      // Same answer whether or not the account exists.
      return json({
        ok: true,
        email_enabled: !!c.env.SYSTEM_FROM,
      });
    }),
  )

  // ── overview ────────────────────────────────────────────────────────────
  .on(
    "GET",
    "/app/api/overview",
    auth(async (c) => {
      const out: Record<string, unknown> = {
        sending: sendMode(c.env),
        attachments: c.env.BUCKET ? "r2" : "d1",
        send_domains: list(c.env.SEND_DOMAINS),
        inbound_domains: list(c.env.INBOUND_DOMAINS),
      };
      if (c.user.permissions.includes("emails:view")) {
        const day = now() - 86_400_000;
        const month = now() - 30 * 86_400_000;
        const r = await c.env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM sent_emails WHERE created_at > ?1) AS sent_day,
             (SELECT COUNT(*) FROM sent_emails WHERE created_at > ?2) AS sent_month,
             (SELECT COUNT(*) FROM sent_emails WHERE created_at > ?2 AND status = 'failed') AS failed_month,
             (SELECT COUNT(*) FROM received_emails WHERE created_at > ?1) AS received_day,
             (SELECT COUNT(*) FROM received_emails WHERE created_at > ?2) AS received_month,
             (SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'failed' AND created_at > ?2) AS webhook_failed,
             (SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'pending') AS webhook_pending`,
        )
          .bind(day, month)
          .first();
        // Daily counts for the last 14 days (UTC).
        const since = now() - 14 * 86_400_000;
        const daily = await c.env.DB.prepare(
          `SELECT d, SUM(s) AS sent, SUM(r) AS received FROM (
             SELECT date(created_at / 1000, 'unixepoch') AS d, 1 AS s, 0 AS r FROM sent_emails WHERE created_at > ?1
             UNION ALL
             SELECT date(created_at / 1000, 'unixepoch'), 0, 1 FROM received_emails WHERE created_at > ?1
           ) GROUP BY d ORDER BY d`,
        )
          .bind(since)
          .all();
        out.stats = r;
        out.daily = daily.results;
      }
      return json(out);
    }),
  )

  // ── emails (logs) ───────────────────────────────────────────────────────
  .on(
    "GET",
    "/app/api/emails/sent",
    can("emails:view", async (c) => listSent(c.env, c.url)),
  )
  .on(
    "GET",
    "/app/api/emails/sent/:id",
    can("emails:view", async (c, p) => getSent(c.env, p.id!)),
  )
  .on(
    "GET",
    "/app/api/emails/received",
    can("emails:view", async (c) => listReceived(c.env, c.url)),
  )
  .on(
    "GET",
    "/app/api/emails/received/:id",
    can("emails:view", async (c, p) => getReceived(c.env, p.id!)),
  )
  .on(
    "GET",
    "/app/api/emails/received/:id/attachments/:aid",
    can("emails:view", async (c, p) =>
      getAttachment(c.env, c.req, p.id!, p.aid!),
    ),
  )
  .on(
    "POST",
    "/app/api/emails/test",
    can("emails:send", async (c) => {
      const b = await readBody<Record<string, unknown>>(c.req);
      const p = prepare(
        {
          from: b.from,
          to: b.to,
          subject: b.subject,
          text: b.text,
          html: b.html,
        },
        list(c.env.SEND_DOMAINS),
      );
      const r = await sendOne(
        c.env,
        { apiKeyId: null, userId: c.user.id },
        p,
        c.ctx,
      );
      await audit(c.env, c.user, "email.test_send", r.id, {
        to: p.to.map((a) => a.email),
      });
      if (r.error) throw r.error;
      return json({ id: r.id });
    }),
  )

  // ── domains ─────────────────────────────────────────────────────────────
  .on(
    "GET",
    "/app/api/domains",
    can("domains:view", async (c) => {
      const send = list(c.env.SEND_DOMAINS);
      const inbound = list(c.env.INBOUND_DOMAINS);
      const { results: boxes } = await c.env.DB.prepare(
        `SELECT address FROM mailboxes`,
      ).all<{ address: string }>();
      const names = [...new Set([...send, ...inbound])].sort();
      return json({
        data: names.map((name) => ({
          name,
          sending: send.includes(name),
          receiving: inbound.includes(name),
          mailboxes: boxes.filter((b) => domainOf(b.address) === name).length,
        })),
        any_send_domain: send.length === 0,
        any_inbound_domain: inbound.length === 0,
      });
    }),
  )

  // ── API keys ────────────────────────────────────────────────────────────
  .on(
    "GET",
    "/app/api/api-keys",
    can("api_keys:manage", async (c) => json({ data: await listKeys(c.env) })),
  )
  .on(
    "POST",
    "/app/api/api-keys",
    can("api_keys:manage", async (c) => {
      const { name, permission } = keyInput(await readBody(c.req));
      const k = await createKey(c.env, name, permission);
      await audit(c.env, c.user, "api_key.create", k.id, { name, permission });
      return json({ id: k.id, token: k.token }, 201);
    }),
  )
  .on(
    "DELETE",
    "/app/api/api-keys/:id",
    can("api_keys:manage", async (c, p) => {
      if (!(await revokeKey(c.env, p.id!)))
        throw err.notFound("API key not found.");
      await audit(c.env, c.user, "api_key.revoke", p.id!);
      return json({ id: p.id, deleted: true });
    }),
  )

  // ── webhooks ────────────────────────────────────────────────────────────
  .on(
    "GET",
    "/app/api/webhooks",
    can("webhooks:manage", async (c) => listWebhooks(c.env)),
  )
  .on(
    "POST",
    "/app/api/webhooks",
    can("webhooks:manage", async (c) => {
      const res = await createWebhook(c.req, c.env);
      const body = (await res.clone().json()) as { id: string };
      await audit(c.env, c.user, "webhook.create", body.id);
      return res;
    }),
  )
  .on(
    "GET",
    "/app/api/webhooks/:id",
    can("webhooks:manage", async (c, p) => getWebhook(c.env, p.id!)),
  )
  .on(
    "PATCH",
    "/app/api/webhooks/:id",
    can("webhooks:manage", async (c, p) => {
      const res = await updateWebhook(c.req, c.env, p.id!);
      await audit(c.env, c.user, "webhook.update", p.id!);
      return res;
    }),
  )
  .on(
    "DELETE",
    "/app/api/webhooks/:id",
    can("webhooks:manage", async (c, p) => {
      const res = await deleteWebhook(c.env, p.id!);
      await audit(c.env, c.user, "webhook.delete", p.id!);
      return res;
    }),
  )
  .on(
    "GET",
    "/app/api/webhooks/:id/deliveries",
    can("webhooks:manage", async (c, p) => listDeliveries(c.env, p.id!)),
  )
  .on(
    "POST",
    "/app/api/webhooks/retry",
    can("webhooks:manage", async (c) =>
      json({ attempted: await deliver(c.env, undefined, 25) }),
    ),
  )

  // ── mailboxes (admin) ───────────────────────────────────────────────────
  .on(
    "GET",
    "/app/api/mailboxes",
    can("mailboxes:manage", async (c) => {
      const { results } = await c.env.DB.prepare(
        `SELECT b.*, (SELECT json_group_array(json_object('user_id', m.user_id, 'can_send', m.can_send, 'email', u.email, 'name', u.name))
                       FROM mailbox_members m JOIN users u ON u.id = m.user_id WHERE m.mailbox_id = b.id) AS members
           FROM mailboxes b ORDER BY b.address`,
      ).all<
        Record<string, unknown> & { members: string; created_at: number }
      >();
      return json({
        data: results.map((r) => ({
          ...r,
          created_at: iso(r.created_at),
          members: JSON.parse(r.members),
        })),
      });
    }),
  )
  .on(
    "POST",
    "/app/api/mailboxes",
    can("mailboxes:manage", async (c) => {
      const b = await readBody<Record<string, unknown>>(c.req);
      let address = str(b.address, 254).toLowerCase();
      if (address.startsWith("*@")) {
        parseAddress(`x${address.slice(1)}`);
      } else {
        try {
          address = parseAddress(address).email.toLowerCase();
        } catch {
          throw err.validation(
            "Enter an address like sales@example.com or *@example.com.",
          );
        }
      }
      const inbound = list(c.env.INBOUND_DOMAINS);
      if (inbound.length && !inbound.includes(domainOf(address)))
        throw err.validation(
          `${domainOf(address)} is not in INBOUND_DOMAINS, so no mail would arrive.`,
        );
      const id = uuid();
      try {
        await c.env.DB.prepare(
          `INSERT INTO mailboxes (id, address, name, signature, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
          .bind(
            id,
            address,
            str(b.name, 80) || address.split("@")[0],
            str(b.signature, 2000) || null,
            now(),
          )
          .run();
      } catch {
        throw err.validation("That mailbox already exists.");
      }
      await audit(c.env, c.user, "mailbox.create", address);
      return json({ id }, 201);
    }),
  )
  .on(
    "PATCH",
    "/app/api/mailboxes/:id",
    can("mailboxes:manage", async (c, p) => {
      const b = await readBody<Record<string, unknown>>(c.req);
      const r = await c.env.DB.prepare(
        `UPDATE mailboxes SET name = COALESCE(?2, name), signature = ?3 WHERE id = ?1`,
      )
        .bind(p.id, str(b.name, 80) || null, str(b.signature, 2000) || null)
        .run();
      if (!r.meta.changes) throw err.notFound("Mailbox not found.");
      await audit(c.env, c.user, "mailbox.update", p.id!);
      return json({ id: p.id });
    }),
  )
  .on(
    "DELETE",
    "/app/api/mailboxes/:id",
    can("mailboxes:manage", async (c, p) => {
      const box = await c.env.DB.prepare(
        `SELECT address FROM mailboxes WHERE id = ?1`,
      )
        .bind(p.id)
        .first<{ address: string }>();
      if (!box) throw err.notFound("Mailbox not found.");
      // Messages stay available through the API; only the webmail view goes.
      await c.env.DB.batch([
        c.env.DB.prepare(
          `DELETE FROM mail_messages WHERE mailbox_id = ?1`,
        ).bind(p.id),
        c.env.DB.prepare(
          `DELETE FROM mailbox_members WHERE mailbox_id = ?1`,
        ).bind(p.id),
        c.env.DB.prepare(`DELETE FROM mailboxes WHERE id = ?1`).bind(p.id),
      ]);
      await audit(c.env, c.user, "mailbox.delete", box.address);
      return json({ id: p.id, deleted: true });
    }),
  )
  .on(
    "PUT",
    "/app/api/mailboxes/:id/members",
    can("mailboxes:manage", async (c, p) => {
      const b = await readBody<{ members?: unknown }>(c.req);
      const members = (Array.isArray(b.members) ? b.members : [])
        .map((m: { user_id?: unknown; can_send?: unknown }) => ({
          user_id: String(m?.user_id ?? ""),
          can_send: m?.can_send === false ? 0 : 1,
        }))
        .filter((m) => m.user_id);
      const box = await c.env.DB.prepare(
        `SELECT address FROM mailboxes WHERE id = ?1`,
      )
        .bind(p.id)
        .first<{ address: string }>();
      if (!box) throw err.notFound("Mailbox not found.");
      await c.env.DB.batch([
        c.env.DB.prepare(
          `DELETE FROM mailbox_members WHERE mailbox_id = ?1`,
        ).bind(p.id),
        ...members.map((m) =>
          c.env.DB.prepare(
            `INSERT OR IGNORE INTO mailbox_members (mailbox_id, user_id, can_send)
             SELECT ?1, id, ?3 FROM users WHERE id = ?2`,
          ).bind(p.id, m.user_id, m.can_send),
        ),
      ]);
      await audit(c.env, c.user, "mailbox.members", box.address, {
        members: members.map((m) => m.user_id),
      });
      return json({ id: p.id });
    }),
  )

  // ── users ───────────────────────────────────────────────────────────────
  .on(
    "GET",
    "/app/api/users",
    can("users:view", async (c) => {
      const { results } = await c.env.DB.prepare(
        `SELECT u.id, u.email, u.name, u.role, r.name AS role_name, u.disabled_at, u.last_login_at, u.created_at,
                u.password_hash IS NULL AS pending,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?1) AS sessions
           FROM users u LEFT JOIN roles r ON r.key = u.role ORDER BY u.created_at`,
      )
        .bind(now())
        .all<Record<string, number | string | null>>();
      return json({
        data: results.map((u) => ({
          ...u,
          pending: u.pending === 1,
          disabled_at: u.disabled_at ? iso(Number(u.disabled_at)) : null,
          last_login_at: u.last_login_at ? iso(Number(u.last_login_at)) : null,
          created_at: iso(Number(u.created_at)),
        })),
      });
    }),
  )
  .on(
    "POST",
    "/app/api/users",
    can("users:manage", async (c) => {
      const b = await readBody<Record<string, unknown>>(c.req);
      let email: string;
      try {
        email = parseAddress(str(b.email, 254)).email.toLowerCase();
      } catch {
        throw err.validation("Enter a valid email address.");
      }
      const role = str(b.role, 30) || "member";
      await assertAssignable(c, role);
      const id = uuid();
      try {
        await c.env.DB.prepare(
          `INSERT INTO users (id, email, name, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
          .bind(id, email, str(b.name, 80) || email.split("@")[0], role, now())
          .run();
      } catch {
        throw err.validation("A user with that email already exists.");
      }
      const link = await issueLink(c, id, "invite");
      const emailed = await mailLink(c, email, "invite", link);
      await audit(c.env, c.user, "user.invite", email, { role, emailed });
      return json({ id, link, emailed }, 201);
    }),
  )
  .on(
    "PATCH",
    "/app/api/users/:id",
    can("users:manage", async (c, p) => {
      const b = await readBody<{
        name?: unknown;
        role?: unknown;
        disabled?: unknown;
      }>(c.req);
      const u = await c.env.DB.prepare(
        `SELECT id, email, role, disabled_at FROM users WHERE id = ?1`,
      )
        .bind(p.id)
        .first<{
          id: string;
          email: string;
          role: string;
          disabled_at: number | null;
        }>();
      if (!u) throw err.notFound("User not found.");
      const self = u.id === c.user.id;
      const sets: string[] = [];
      const binds: unknown[] = [u.id];
      const set = (col: string, v: unknown) => {
        binds.push(v);
        sets.push(`${col} = ?${binds.length}`);
      };
      let revoke = false;
      if (b.name !== undefined) set("name", str(b.name, 80) || u.email);
      // Changing someone's role/state requires holding everything they have.
      if (b.role !== undefined || b.disabled !== undefined) {
        if (self)
          throw err.validation(
            "You cannot change your own role or disable yourself.",
          );
        await assertAssignable(c, u.role);
      }
      if (b.role !== undefined && b.role !== u.role) {
        const role = str(b.role, 30);
        await assertAssignable(c, role);
        if (
          u.role === ADMIN_ROLE &&
          !u.disabled_at &&
          (await activeAdmins(c.env)) <= 1
        )
          throw err.validation("Keep at least one active admin.");
        set("role", role);
        revoke = true;
      }
      if (b.disabled !== undefined) {
        const disable = b.disabled === true;
        if (
          disable &&
          u.role === ADMIN_ROLE &&
          !u.disabled_at &&
          (await activeAdmins(c.env)) <= 1
        )
          throw err.validation("Keep at least one active admin.");
        set("disabled_at", disable ? now() : null);
        revoke ||= disable;
      }
      if (sets.length)
        await c.env.DB.prepare(
          `UPDATE users SET ${sets.join(", ")} WHERE id = ?1`,
        )
          .bind(...binds)
          .run();
      if (revoke) await deleteUserSessions(c.env, u.id);
      await audit(c.env, c.user, "user.update", u.email, {
        ...(b.role !== undefined ? { role: b.role } : {}),
        ...(b.disabled !== undefined ? { disabled: b.disabled } : {}),
      });
      return json({ id: u.id });
    }),
  )
  .on(
    "POST",
    "/app/api/users/:id/reset",
    can("users:manage", async (c, p) => {
      const u = await c.env.DB.prepare(
        `SELECT id, email, role, password_hash IS NULL AS pending FROM users WHERE id = ?1`,
      )
        .bind(p.id)
        .first<{ id: string; email: string; role: string; pending: number }>();
      if (!u) throw err.notFound("User not found.");
      if (u.id !== c.user.id) await assertAssignable(c, u.role);
      const purpose = u.pending ? "invite" : "reset";
      const link = await issueLink(c, u.id, purpose);
      const emailed = await mailLink(c, u.email, purpose, link);
      await audit(c.env, c.user, `user.${purpose}_link`, u.email, { emailed });
      return json({ link, emailed, purpose });
    }),
  )
  .on(
    "DELETE",
    "/app/api/users/:id/sessions",
    can("users:manage", async (c, p) => {
      const u = await c.env.DB.prepare(
        `SELECT email, role FROM users WHERE id = ?1`,
      )
        .bind(p.id)
        .first<{ email: string; role: string }>();
      if (!u) throw err.notFound("User not found.");
      if (p.id !== c.user.id) await assertAssignable(c, u.role);
      await deleteUserSessions(c.env, p.id!, c.user.sessionId);
      await audit(c.env, c.user, "user.sign_out", u.email);
      return json({ ok: true });
    }),
  )

  // ── roles ───────────────────────────────────────────────────────────────
  .on(
    "GET",
    "/app/api/roles",
    auth(async (c) => {
      if (
        !c.user.permissions.includes("users:view") &&
        !c.user.permissions.includes("roles:manage")
      )
        throw new ApiError(403, "forbidden", "Missing permission users:view.");
      const { results } = await c.env.DB.prepare(
        `SELECT r.key, r.name, r.description, r.builtin,
                (SELECT group_concat(permission) FROM role_permissions p WHERE p.role_key = r.key) AS perms,
                (SELECT COUNT(*) FROM users u WHERE u.role = r.key) AS users
           FROM roles r ORDER BY r.builtin DESC, r.name`,
      ).all<{
        key: string;
        name: string;
        description: string | null;
        builtin: number;
        perms: string | null;
        users: number;
      }>();
      return json({
        catalog: PERMISSIONS,
        data: results.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          builtin: r.builtin === 1,
          users: r.users,
          permissions: effectivePermissions(
            r.key,
            r.perms ? r.perms.split(",") : [],
          ),
        })),
      });
    }),
  )
  .on(
    "POST",
    "/app/api/roles",
    can("roles:manage", async (c) => {
      const b = await readBody<Record<string, unknown>>(c.req);
      const key = str(b.key, 30);
      if (!isRoleKey(key))
        throw err.validation(
          "Key: 2–30 chars, a-z, 0-9 and dashes, starting with a letter.",
        );
      const perms = cleanPerms(c, b.permissions);
      try {
        await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO roles (key, name, description, builtin, created_at) VALUES (?1, ?2, ?3, 0, ?4)`,
          ).bind(
            key,
            str(b.name, 60) || key,
            str(b.description, 200) || null,
            now(),
          ),
          ...perms.map((perm) =>
            c.env.DB.prepare(
              `INSERT INTO role_permissions (role_key, permission) VALUES (?1, ?2)`,
            ).bind(key, perm),
          ),
        ]);
      } catch {
        throw err.validation("A role with that key already exists.");
      }
      await audit(c.env, c.user, "role.create", key, { permissions: perms });
      return json({ key }, 201);
    }),
  )
  .on(
    "PATCH",
    "/app/api/roles/:key",
    can("roles:manage", async (c, p) => {
      const key = p.key!;
      if (key === ADMIN_ROLE)
        throw err.validation("The admin role always has every permission.");
      if (key === c.user.role)
        throw err.validation("You cannot change your own role.");
      const role = await c.env.DB.prepare(
        `SELECT key FROM roles WHERE key = ?1`,
      )
        .bind(key)
        .first();
      if (!role) throw err.notFound("Role not found.");
      await assertAssignable(c, key);
      const b = await readBody<Record<string, unknown>>(c.req);
      const stmts = [
        c.env.DB.prepare(
          `UPDATE roles SET name = COALESCE(?2, name), description = COALESCE(?3, description) WHERE key = ?1`,
        ).bind(key, str(b.name, 60) || null, str(b.description, 200) || null),
      ];
      let perms: Permission[] | undefined;
      if (b.permissions !== undefined) {
        perms = cleanPerms(c, b.permissions);
        stmts.push(
          c.env.DB.prepare(
            `DELETE FROM role_permissions WHERE role_key = ?1`,
          ).bind(key),
          ...perms.map((perm) =>
            c.env.DB.prepare(
              `INSERT INTO role_permissions (role_key, permission) VALUES (?1, ?2)`,
            ).bind(key, perm),
          ),
        );
      }
      await c.env.DB.batch(stmts);
      await audit(
        c.env,
        c.user,
        "role.update",
        key,
        perms ? { permissions: perms } : undefined,
      );
      return json({ key });
    }),
  )
  .on(
    "DELETE",
    "/app/api/roles/:key",
    can("roles:manage", async (c, p) => {
      const r = await c.env.DB.prepare(
        `SELECT builtin, (SELECT COUNT(*) FROM users WHERE role = ?1) AS n FROM roles WHERE key = ?1`,
      )
        .bind(p.key)
        .first<{ builtin: number; n: number }>();
      if (!r) throw err.notFound("Role not found.");
      if (r.builtin) throw err.validation("Built-in roles cannot be deleted.");
      if (r.n) throw err.validation("Move its users to another role first.");
      await c.env.DB.prepare(`DELETE FROM roles WHERE key = ?1`)
        .bind(p.key)
        .run();
      await audit(c.env, c.user, "role.delete", p.key!);
      return json({ key: p.key, deleted: true });
    }),
  )

  // ── audit ───────────────────────────────────────────────────────────────
  .on(
    "GET",
    "/app/api/audit",
    can("audit:view", async (c) => {
      const before = Number(c.url.searchParams.get("before")) || now() + 1;
      const { results } = await c.env.DB.prepare(
        `SELECT * FROM audit_log WHERE created_at < ?1 ORDER BY created_at DESC LIMIT 101`,
      )
        .bind(before)
        .all<
          Record<string, unknown> & {
            created_at: number;
            detail: string | null;
          }
        >();
      return json({
        has_more: results.length > 100,
        data: results.slice(0, 100).map((r) => ({
          ...r,
          detail: r.detail ? JSON.parse(r.detail) : null,
          ts: r.created_at,
          created_at: iso(r.created_at),
        })),
      });
    }),
  )

  // ── webmail ─────────────────────────────────────────────────────────────
  .on(
    "GET",
    "/app/api/mail/mailboxes",
    can("mail:use", async (c) => listMailboxes(c.env, c.user)),
  )
  .on(
    "GET",
    "/app/api/mail/threads",
    can("mail:use", async (c) => listThreads(c.env, c.user, c.url)),
  )
  .on(
    "GET",
    "/app/api/mail/thread",
    can("mail:use", async (c) => getThread(c.env, c.user, c.url)),
  )
  .on(
    "GET",
    "/app/api/mail/messages/:id/body",
    can("mail:use", async (c, p) => messageBody(c.env, c.user, p.id!, c.url)),
  )
  .on(
    "POST",
    "/app/api/mail/action",
    can("mail:use", async (c) => mailAction(c.env, c.user, c.req)),
  )
  .on(
    "POST",
    "/app/api/mail/send",
    can("mail:use", async (c) => sendMail(c.env, c.user, c.req, c.ctx)),
  );

function cleanPerms(c: C & { user: SessionUser }, v: unknown): Permission[] {
  const wanted = Array.isArray(v) ? v.filter(isPermission) : [];
  const uniq = [...new Set(wanted)].filter((p) => ALL_PERMISSIONS.includes(p));
  const missing = ungrantable(c.user.permissions, uniq);
  if (missing.length)
    throw new ApiError(
      403,
      "forbidden",
      `You cannot grant permissions you do not have: ${missing.join(", ")}.`,
    );
  return uniq;
}

export async function handleConsole(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const m = router.match(req.method, url.pathname);
  if (!m) throw err.notFound("Route not found.");
  assertSameOrigin(req, env);
  const user = await readSession(req, env);
  const res = await m.handler({ req, url, env, ctx, user }, m.params);
  if (!res.headers.has("cache-control")) {
    res.headers.set("cache-control", "no-store");
  }
  return res;
}
