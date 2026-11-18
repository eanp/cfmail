/**
 * API keys: `cfm_` + 32 random bytes (base64url). Only the SHA-256 hash is
 * stored. Two permissions, like Resend: full_access and sending_access.
 */
import type { Env } from "./env";
import { err } from "./http";
import { b64url, iso, now, randomBytes, sha256Hex, uuid } from "./util";

export type Permission = "full_access" | "sending_access";

export interface KeyInfo {
  id: string;
  permission: Permission;
}

export function newKey(): string {
  return `cfm_${b64url(randomBytes(32))}`;
}

export async function authenticate(req: Request, env: Env): Promise<KeyInfo> {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) throw err.missingKey();
  const hash = await sha256Hex(m[1]!);
  const row = await env.DB.prepare(
    `SELECT id, permission FROM api_keys WHERE key_hash = ?1 AND revoked_at IS NULL`,
  )
    .bind(hash)
    .first<{ id: string; permission: Permission }>();
  if (!row) throw err.invalidKey();
  return row;
}

/** Touch last_used_at at most once a minute per key (saves D1 writes). */
export function touchKey(env: Env, ctx: ExecutionContext, id: string): void {
  ctx.waitUntil(
    env.DB.prepare(
      `UPDATE api_keys SET last_used_at = ?2 WHERE id = ?1 AND (last_used_at IS NULL OR last_used_at < ?2 - 60000)`,
    )
      .bind(id, now())
      .run()
      .then(
        () => undefined,
        () => undefined,
      ),
  );
}

export function requireFull(k: KeyInfo): void {
  if (k.permission !== "full_access") throw err.restricted();
}

export async function createKey(
  env: Env,
  name: string,
  permission: Permission,
): Promise<{ id: string; token: string }> {
  const token = newKey();
  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO api_keys (id, name, key_hash, prefix, permission, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(
      id,
      name,
      await sha256Hex(token),
      token.slice(0, 10),
      permission,
      now(),
    )
    .run();
  return { id, token };
}

export async function listKeys(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, prefix, permission, created_at, last_used_at FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC`,
  ).all<{
    id: string;
    name: string;
    prefix: string;
    permission: string;
    created_at: number;
    last_used_at: number | null;
  }>();
  return results.map((k) => ({
    ...k,
    created_at: iso(k.created_at),
    last_used_at: k.last_used_at ? iso(k.last_used_at) : null,
  }));
}

export function keyInput(b: { name?: unknown; permission?: unknown }): {
  name: string;
  permission: Permission;
} {
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
  if (!name) throw err.validation("Missing `name`.");
  return {
    name,
    permission:
      b.permission === "sending_access" ? "sending_access" : "full_access",
  };
}

/** Revoke a key; false when it does not exist (or is already revoked). */
export async function revokeKey(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE api_keys SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL`,
  )
    .bind(id, now())
    .run();
  return r.meta.changes > 0;
}
