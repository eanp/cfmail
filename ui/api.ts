/** Fetch wrapper for /app/api: JSON in/out, errors as ApiError. */
import type { Permission } from "../src/permissions";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/app/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers:
      opts.body === undefined ? {} : { "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const e = (data ?? {}) as { name?: string; message?: string };
    if (res.status === 401 && path !== "/me" && !path.startsWith("/auth/"))
      window.dispatchEvent(new Event("cfm:signed-out"));
    throw new ApiError(
      res.status,
      e.name ?? "error",
      e.message ?? `Request failed (${res.status}).`,
    );
  }
  return data as T;
}

export interface Me {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    role_name: string;
    permissions: Permission[];
  };
  system: {
    version: string;
    sending: string;
    attachments: string;
    system_mail: boolean;
  };
}

export interface ListResponse<T> {
  data: T[];
  has_more?: boolean;
}
