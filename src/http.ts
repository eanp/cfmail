/**
 * Responses, errors and a tiny router. Error bodies follow Resend's shape
 * ({ statusCode, name, message }) so existing Resend clients keep working.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    override readonly name: string,
    message: string,
  ) {
    super(message);
  }
}

export const err = {
  missingKey: () =>
    new ApiError(
      401,
      "missing_api_key",
      "Missing API key in the authorization header.",
    ),
  invalidKey: () => new ApiError(403, "invalid_api_key", "API key is invalid."),
  restricted: () =>
    new ApiError(
      401,
      "restricted_api_key",
      "This API key is restricted to only send emails.",
    ),
  validation: (m: string) => new ApiError(422, "validation_error", m),
  notFound: (m = "The requested resource was not found.") =>
    new ApiError(404, "not_found", m),
  rateLimit: () =>
    new ApiError(429, "rate_limit_exceeded", "Too many requests. Slow down."),
  conflict: (m: string) => new ApiError(409, "invalid_idempotent_request", m),
};

export function json(
  data: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(e: ApiError): Response {
  return json(
    { statusCode: e.status, name: e.name, message: e.message },
    e.status,
  );
}

export async function readBody<T>(
  req: Request,
  max = 40 * 1024 * 1024,
): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > max) throw err.validation("Request body is too large.");
  try {
    return (await req.json()) as T;
  } catch {
    throw err.validation("Body must be valid JSON.");
  }
}

type Handler<C> = (ctx: C, params: Record<string, string>) => Promise<Response>;

/** Method + path pattern (`:param` segments) → handler. */
export class Router<C> {
  private routes: { method: string; parts: string[]; handler: Handler<C> }[] =
    [];

  on(method: string, path: string, handler: Handler<C>): this {
    this.routes.push({
      method,
      parts: path.split("/").filter(Boolean),
      handler,
    });
    return this;
  }

  match(
    method: string,
    pathname: string,
  ): { handler: Handler<C>; params: Record<string, string> } | null {
    const segs = pathname.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i]!;
        const s = segs[i]!;
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
        else if (p !== s) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }
}
