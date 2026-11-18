/**
 * Permission catalogue for the dashboard (RBAC). Roles live in D1 (`roles`,
 * `role_permissions`); the "admin" role always has every permission in code,
 * so adding a permission here never locks admins out.
 *
 * Shared by the Worker (route guards) and the browser (menus, role editor).
 * API keys are separate: they keep Resend's full_access / sending_access.
 */
export const PERMISSIONS = {
  "emails:view": {
    group: "Emails",
    label: "View every sent and received email (logs)",
  },
  "emails:send": {
    group: "Emails",
    label: "Send test emails from the dashboard",
  },
  "domains:view": { group: "Domains", label: "View sending/receiving domains" },
  "api_keys:manage": {
    group: "API keys",
    label: "Create and revoke API keys",
  },
  "webhooks:manage": {
    group: "Webhooks",
    label: "Create, change and replay webhooks",
  },
  "mail:use": {
    group: "Webmail",
    label: "Use the mailboxes assigned to them",
  },
  "mailboxes:manage": {
    group: "Webmail",
    label: "Create mailboxes and choose their members",
  },
  "users:view": { group: "Team", label: "View users" },
  "users:manage": {
    group: "Team",
    label: "Invite, disable and reset users, change roles",
  },
  "roles:manage": {
    group: "Team",
    label: "Create and change roles and their permissions",
  },
  "audit:view": { group: "Team", label: "View the audit log" },
} as const satisfies Record<string, { group: string; label: string }>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
export const ADMIN_ROLE = "admin";

export function isPermission(v: unknown): v is Permission {
  return typeof v === "string" && Object.hasOwn(PERMISSIONS, v);
}

/** Role keys: lowercase letters, digits, dash; 2–30 chars. */
export function isRoleKey(v: unknown): v is string {
  return typeof v === "string" && /^[a-z][a-z0-9-]{1,29}$/.test(v);
}

/** Effective permissions of a role (admin = everything). */
export function effectivePermissions(
  roleKey: string,
  stored: readonly string[],
): Permission[] {
  if (roleKey === ADMIN_ROLE) return ALL_PERMISSIONS;
  return stored.filter(isPermission);
}

/**
 * Escalation guard: an actor may only grant permissions they hold
 * themselves. Returns the permissions the actor may NOT grant.
 */
export function ungrantable(
  actor: readonly string[],
  wanted: readonly string[],
): string[] {
  const have = new Set(actor);
  return wanted.filter((p) => !have.has(p));
}
