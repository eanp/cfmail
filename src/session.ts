/**
 * Dashboard sessions. Cookie `cfm_session` = random 32-byte token; D1 keeps
 * only HMAC("session:" + token, HASH_SECRET), so a copy of the table cannot
 * be used to log in. One D1 read per request: revocation is instant.
 *
 * Cookie: HttpOnly, SameSite=Strict, Path=/app, Secure on https. CSRF:
 * SameSite=Strict plus an Origin check on every non-GET request.
 */
import type { Env } from "./env";
import { ApiError } from "./http";
import { effectivePermissions, type Permission } from "./permissions";
import { b64url, hmac, now, randomBytes, uuid } from "./util";

export const COOKIE = "cfm_session";
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
const IDLE_MS = 12 * 3600_000;
const TOUCH_MS = 10 * 60_000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  roleName: string;
  permissions: Permission[];
  sessionId: string;
}

function secret(env: Env): Uint8Array {
  if (!env.HASH_SECRET || env.HASH_SECRET.length < 16)
    throw new ApiError(
      500,
      "application_error",
      "HASH_SECRET is not set (needed for dashboard sessions).",
    );
  return new TextEncoder().encode(env.HASH_SECRET);
}

/** HMAC of a token with a purpose prefix (sessions, invite/reset links). */
export async function tokenHash(
  env: Env,
  purpose: string,
  token: string,
): Promise<string> {
  return b64url(await hmac(secret(env), `${purpose}:${token}`));
}

export function newToken(): string {
  return b64url(randomBytes(32));
}

export function getCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(req: Request, token: string, maxAgeMs: number) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/app; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

export async function createSession(
  env: Env,
  req: Request,
  userId: string,
): Promise<string> {
  const token = newToken();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, last_seen_at, user_agent, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5)`,
  )
    .bind(
      uuid(),
      userId,
      await tokenHash(env, "session", token),
      t + SESSION_TTL_MS,
      t,
      req.headers.get("user-agent")?.slice(0, 200) ?? null,
    )
    .run();
  return sessionCookie(req, token, SESSION_TTL_MS);
}

export async function readSession(
  req: Request,
  env: Env,
): Promise<SessionUser | null> {
  const token = getCookie(req, COOKIE);
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare(
    `SELECT s.id AS sid, s.expires_at, s.last_seen_at, u.id, u.email, u.name, u.role,
            r.name AS role_name,
            (SELECT group_concat(permission) FROM role_permissions WHERE role_key = u.role) AS perms
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN roles r ON r.key = u.role
      WHERE s.token_hash = ?1 AND u.disabled_at IS NULL`,
  )
    .bind(await tokenHash(env, "session", token))
    .first<{
      sid: string;
      expires_at: number;
      last_seen_at: number;
      id: string;
      email: string;
      name: string;
      role: string;
      role_name: string | null;
      perms: string | null;
    }>();
  const t = now();
  if (!row || row.expires_at < t || t - row.last_seen_at > IDLE_MS) return null;
  if (t - row.last_seen_at > TOUCH_MS) {
    await env.DB.prepare(`UPDATE sessions SET last_seen_at = ?2 WHERE id = ?1`)
      .bind(row.sid, t)
      .run();
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    roleName: row.role_name ?? row.role,
    permissions: effectivePermissions(
      row.role,
      row.perms ? row.perms.split(",") : [],
    ),
    sessionId: row.sid,
  };
}

/** Revoke every session of a user, optionally keeping one. */
export async function deleteUserSessions(
  env: Env,
  userId: string,
  keep = "",
): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND id != ?2`)
    .bind(userId, keep)
    .run();
}

/** Non-GET requests must come from our own origin (CSRF defence). */
export function assertSameOrigin(req: Request, env: Env): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  const allowed = new Set([new URL(req.url).origin]);
  if (env.PUBLIC_ORIGIN) allowed.add(env.PUBLIC_ORIGIN.replace(/\/+$/, ""));
  if (!origin || !allowed.has(origin))
    throw new ApiError(403, "invalid_origin", "Cross-origin request refused.");
}
