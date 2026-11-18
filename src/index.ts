/**
 * cfmail Worker entry.
 *   fetch     → Resend-compatible REST API (Bearer API key) + signed downloads
 *               + dashboard/webmail API under /app/api (console.ts); the UI
 *               itself is static files in public/app (Workers assets)
 *   email     → Email Routing inbound (inbound.ts)
 *   scheduled → webhook retries (optional cron)
 */
import {
  authenticate,
  createKey,
  keyInput,
  listKeys,
  requireFull,
  revokeKey,
  touchKey,
  type KeyInfo,
} from "./auth";
import { handleConsole } from "./console";
import { list, VERSION, type Env } from "./env";
import { ApiError, err, errorResponse, json, readBody, Router } from "./http";
import { handleEmail } from "./inbound";
import {
  deleteReceived,
  downloadAttachment,
  getAttachment,
  getReceived,
  listAttachments,
  listReceived,
} from "./received";
import { batchRoute, getSent, listSent, sendMode, sendRoute } from "./send";
import {
  createWebhook,
  deleteWebhook,
  deliver,
  getWebhook,
  listDeliveries,
  listWebhooks,
  updateWebhook,
} from "./webhooks";

interface Ctx {
  req: Request;
  url: URL;
  env: Env;
  ctx: ExecutionContext;
  key: KeyInfo;
}

const full =
  (fn: (c: Ctx, p: Record<string, string>) => Promise<Response>) =>
  async (c: Ctx, p: Record<string, string>) => {
    requireFull(c.key);
    return fn(c, p);
  };

const api = new Router<Ctx>()
  // Sending (sending_access is enough)
  .on("POST", "/emails", async (c) => sendRoute(c.req, c.env, c.key, c.ctx))
  .on("POST", "/emails/batch", async (c) =>
    batchRoute(c.req, c.env, c.key, c.ctx),
  )
  // Everything else needs full_access
  .on(
    "GET",
    "/emails",
    full(async (c) => listSent(c.env, c.url)),
  )
  .on(
    "GET",
    "/emails/receiving",
    full(async (c) => listReceived(c.env, c.url)),
  )
  .on(
    "GET",
    "/emails/receiving/:id",
    full(async (c, p) => getReceived(c.env, p.id!)),
  )
  .on(
    "DELETE",
    "/emails/receiving/:id",
    full(async (c, p) => deleteReceived(c.env, p.id!)),
  )
  .on(
    "GET",
    "/emails/receiving/:id/attachments",
    full(async (c, p) => listAttachments(c.env, p.id!)),
  )
  .on(
    "GET",
    "/emails/receiving/:id/attachments/:aid",
    full(async (c, p) => getAttachment(c.env, c.req, p.id!, p.aid!)),
  )
  .on(
    "GET",
    "/emails/:id",
    full(async (c, p) => getSent(c.env, p.id!)),
  )
  .on(
    "GET",
    "/webhooks",
    full(async (c) => listWebhooks(c.env)),
  )
  .on(
    "POST",
    "/webhooks",
    full(async (c) => createWebhook(c.req, c.env)),
  )
  .on(
    "GET",
    "/webhooks/:id",
    full(async (c, p) => getWebhook(c.env, p.id!)),
  )
  .on(
    "PATCH",
    "/webhooks/:id",
    full(async (c, p) => updateWebhook(c.req, c.env, p.id!)),
  )
  .on(
    "DELETE",
    "/webhooks/:id",
    full(async (c, p) => deleteWebhook(c.env, p.id!)),
  )
  .on(
    "GET",
    "/webhooks/:id/deliveries",
    full(async (c, p) => listDeliveries(c.env, p.id!)),
  )
  .on(
    "POST",
    "/webhooks/retry",
    full(async (c) => json({ attempted: await deliver(c.env, undefined, 25) })),
  )
  .on(
    "GET",
    "/domains",
    full(async (c) =>
      json({
        object: "list",
        has_more: false,
        data: list(c.env.SEND_DOMAINS).map((name) => ({
          object: "domain",
          id: name,
          name,
          status: "configured",
        })),
        inbound: list(c.env.INBOUND_DOMAINS),
      }),
    ),
  )
  .on(
    "GET",
    "/api-keys",
    full(async (c) => json({ object: "list", data: await listKeys(c.env) })),
  )
  .on(
    "POST",
    "/api-keys",
    full(async (c) => {
      const { name, permission } = keyInput(await readBody(c.req));
      const k = await createKey(c.env, name, permission);
      return json({ id: k.id, token: k.token }, 201);
    }),
  )
  .on(
    "DELETE",
    "/api-keys/:id",
    full(async (c, p) => {
      if (p.id === c.key.id)
        throw err.validation("You cannot revoke the key you are using.");
      if (!(await revokeKey(c.env, p.id!)))
        throw err.notFound("API key not found.");
      return json({ id: p.id, deleted: true });
    }),
  );

async function handleFetch(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/") {
    return json({
      name: "cfmail",
      version: VERSION,
      sending: sendMode(env),
      attachments: env.BUCKET ? "r2" : "d1",
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/attachments/")) {
    return downloadAttachment(
      env,
      url,
      decodeURIComponent(url.pathname.slice("/attachments/".length)),
    );
  }
  if (url.pathname.startsWith("/app/api/"))
    return handleConsole(req, env, ctx, url);
  if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
    // Static UI files are served before the Worker runs; anything that gets
    // here under /app is a client-side route → the app shell.
    if (env.ASSETS && req.method === "GET")
      return env.ASSETS.fetch(new Request(new URL("/app/", url), req));
    throw err.notFound("Route not found.");
  }
  const m = api.match(req.method, url.pathname);
  if (!m) throw err.notFound("Route not found.");
  const key = await authenticate(req, env);
  if (env.API_LIMIT) {
    const { success } = await env.API_LIMIT.limit({ key: key.id });
    if (!success) throw err.rateLimit();
  }
  touchKey(env, ctx, key.id);
  return m.handler({ req, url, env, ctx, key }, m.params);
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    try {
      return await handleFetch(req, env, ctx);
    } catch (e) {
      if (e instanceof ApiError) return errorResponse(e);
      console.error("api_error", req.method, new URL(req.url).pathname, e);
      return errorResponse(
        new ApiError(500, "application_error", "Internal error."),
      );
    }
  },
  async email(message, env, ctx): Promise<void> {
    await handleEmail(message, env, ctx);
  },
  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(deliver(env, undefined, 25).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
