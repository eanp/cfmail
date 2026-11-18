/** Append-only audit log of dashboard actions. Never throws. */
import type { Env } from "./env";
import { now, uuid } from "./util";

export async function audit(
  env: Env,
  actor: { id: string; email: string } | null,
  action: string,
  target: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (id, actor_id, actor_email, action, target, detail, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        uuid(),
        actor?.id ?? null,
        actor?.email ?? null,
        action,
        target,
        detail ? JSON.stringify(detail).slice(0, 4000) : null,
        now(),
      )
      .run();
  } catch (e) {
    console.error("audit_failed", action, e);
  }
}
