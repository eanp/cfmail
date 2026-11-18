/** Developer pages: overview, email logs, domains, API keys, webhooks. */
import { useState } from "preact/hooks";
import { api, type ListResponse } from "../api";
import {
  ago,
  Badge,
  bytes,
  Empty,
  Field,
  fmtDate,
  Json,
  Loading,
  Modal,
  navigate,
  onInput,
  Page,
  Secret,
  useAction,
  useCan,
  useLoad,
  useMe,
} from "../kit";

// ── overview ───────────────────────────────────────────────────────────────
interface Overview {
  sending: string;
  attachments: string;
  send_domains: string[];
  inbound_domains: string[];
  stats?: Record<string, number>;
  daily?: { d: string; sent: number; received: number }[];
}

const MODE_TEXT: Record<string, string> = {
  cloudflare: "Cloudflare Email Sending",
  resend: "Relay to Resend",
  log: "Log only (nothing is sent)",
};

export function Overview() {
  const me = useMe();
  const { data, error } = useLoad(() => api<Overview>("/overview"));
  if (!data) return <Loading error={error} />;
  const s = data.stats;
  return (
    <Page title="Overview" sub={`Signed in as ${me.user.email}`}>
      {data.sending === "log" && (
        <div class="notice warn">
          Sending is in <b>log</b> mode: emails are recorded but not delivered.
          Set <code>SEND_MODE</code> to <code>cloudflare</code> or{" "}
          <code>resend</code> to deliver.
        </div>
      )}
      {s && (
        <div class="cards">
          <Stat label="Sent (24 h)" value={s.sent_day} />
          <Stat label="Received (24 h)" value={s.received_day} />
          <Stat label="Sent (30 days)" value={s.sent_month} />
          <Stat label="Received (30 days)" value={s.received_month} />
          <Stat
            label="Failed sends (30 days)"
            value={s.failed_month}
            bad={!!s.failed_month}
          />
          <Stat
            label="Webhook deliveries failed / pending"
            value={`${s.webhook_failed ?? 0} / ${s.webhook_pending ?? 0}`}
            bad={!!s.webhook_failed}
          />
        </div>
      )}
      {data.daily && <Daily rows={data.daily} />}
      <div class="panel">
        <h3>Configuration</h3>
        <dl class="kv">
          <dt>Sending</dt>
          <dd>{MODE_TEXT[data.sending] ?? data.sending}</dd>
          <dt>Send domains</dt>
          <dd>{data.send_domains.join(", ") || "any onboarded domain"}</dd>
          <dt>Inbound domains</dt>
          <dd>{data.inbound_domains.join(", ") || "any routed domain"}</dd>
          <dt>Attachment storage</dt>
          <dd>{data.attachments === "r2" ? "R2" : "D1 (up to 1.5 MB each)"}</dd>
          <dt>Version</dt>
          <dd>{me.system.version}</dd>
        </dl>
      </div>
    </Page>
  );
}

function Stat(p: { label: string; value: unknown; bad?: boolean }) {
  return (
    <div class={`card stat ${p.bad ? "bad" : ""}`}>
      <span class="muted">{p.label}</span>
      <strong>{String(p.value ?? 0)}</strong>
    </div>
  );
}

/** 14-day bar chart of sent vs received (pure CSS). */
function Daily({
  rows,
}: {
  rows: { d: string; sent: number; received: number }[];
}) {
  const days: { d: string; sent: number; received: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    days.push(rows.find((r) => r.d === d) ?? { d, sent: 0, received: 0 });
  }
  const max = Math.max(1, ...days.map((d) => Math.max(d.sent, d.received)));
  return (
    <div class="panel">
      <h3>
        Last 14 days <span class="legend sent">sent</span>
        <span class="legend recv">received</span>
      </h3>
      <div
        class="bars"
        role="img"
        aria-label="Emails sent and received per day"
      >
        {days.map((d) => (
          <div
            class="bar-day"
            key={d.d}
            title={`${d.d}: ${d.sent} sent, ${d.received} received`}
          >
            <div class="bar-pair">
              <span
                class="bar sent"
                style={{ height: `${(d.sent / max) * 100}%` }}
              />
              <span
                class="bar recv"
                style={{ height: `${(d.received / max) * 100}%` }}
              />
            </div>
            <small>{d.d.slice(8)}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── email logs ─────────────────────────────────────────────────────────────
interface EmailRow {
  id: string;
  from: string;
  to: string[];
  subject: string | null;
  created_at: string;
  last_event?: string;
}

const EVENT_KIND: Record<string, "ok" | "err" | "warn"> = {
  sent: "ok",
  failed: "err",
  logged: "warn",
};

export function Emails({ kind }: { kind: "sent" | "received" }) {
  const [cursor, setCursor] = useState<string[]>([]);
  const after = cursor[cursor.length - 1];
  const { data, error } = useLoad(
    () =>
      api<ListResponse<EmailRow>>(
        `/emails/${kind}?limit=50${after ? `&after=${after}` : ""}`,
      ),
    [kind, after],
  );
  const [test, setTest] = useState(false);
  const canSend = useCan("emails:send");
  return (
    <Page
      title="Emails"
      sub="Every email sent through the API or webmail, and every email received."
      actions={
        canSend && (
          <button class="btn primary" onClick={() => setTest(true)}>
            Send test email
          </button>
        )
      }
    >
      <div class="tabs">
        <a class={kind === "sent" ? "active" : ""} href="#/emails/sent">
          Sent
        </a>
        <a class={kind === "received" ? "active" : ""} href="#/emails/received">
          Received
        </a>
      </div>
      {!data ? (
        <Loading error={error} />
      ) : !data.data.length ? (
        <Empty>No emails yet.</Empty>
      ) : (
        <>
          <table class="table click">
            <thead>
              <tr>
                {kind === "sent" && <th>Status</th>}
                <th>{kind === "sent" ? "To" : "From"}</th>
                <th>Subject</th>
                {kind === "received" && <th>To</th>}
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => navigate(`/emails/${kind}/${e.id}`)}
                >
                  {kind === "sent" && (
                    <td>
                      <Badge kind={EVENT_KIND[e.last_event ?? ""] ?? "muted"}>
                        {e.last_event}
                      </Badge>
                    </td>
                  )}
                  <td class="trunc">
                    {kind === "sent" ? e.to.join(", ") : e.from}
                  </td>
                  <td class="trunc">{e.subject ?? "(no subject)"}</td>
                  {kind === "received" && (
                    <td class="trunc">{e.to.join(", ")}</td>
                  )}
                  <td class="nowrap muted" title={fmtDate(e.created_at)}>
                    {ago(e.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div class="pager">
            <button
              class="btn"
              disabled={!cursor.length}
              onClick={() => setCursor(cursor.slice(0, -1))}
            >
              ← Newer
            </button>
            <button
              class="btn"
              disabled={!data.has_more}
              onClick={() =>
                setCursor([...cursor, data.data[data.data.length - 1]!.id])
              }
            >
              Older →
            </button>
          </div>
        </>
      )}
      {test && <TestSend onClose={() => setTest(false)} />}
    </Page>
  );
}

function TestSend({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const domains = useLoad(() =>
    api<{ data: { name: string; sending: boolean }[] }>("/domains").catch(
      () => ({ data: [] }),
    ),
  );
  const first =
    domains.data?.data.find((d) => d.sending)?.name ?? "example.com";
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(me.user.email);
  const [subject, setSubject] = useState("Test email from cfmail");
  const [text, setText] = useState("It works.");
  const { busy, run } = useAction();
  return (
    <Modal title="Send test email" onClose={onClose}>
      <Field label="From">
        <input
          placeholder={`test@${first}`}
          value={from}
          onInput={onInput(setFrom)}
        />
      </Field>
      <Field label="To">
        <input value={to} onInput={onInput(setTo)} />
      </Field>
      <Field label="Subject">
        <input value={subject} onInput={onInput(setSubject)} />
      </Field>
      <Field label="Text">
        <textarea rows={4} value={text} onInput={onInput(setText)} />
      </Field>
      <div class="row end">
        <button
          class="btn primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await api<{ id: string }>("/emails/test", {
                body: { from: from || `test@${first}`, to, subject, text },
              });
              onClose();
              navigate(`/emails/sent/${r.id}`);
            }, "Sent")
          }
        >
          Send
        </button>
      </div>
    </Modal>
  );
}

interface Detail extends EmailRow {
  cc?: string[] | null;
  bcc?: string[] | null;
  reply_to?: string[] | null;
  html?: string | null;
  text?: string | null;
  error?: string;
  headers?: Record<string, string | string[]>;
  authentication?: Record<string, string> | null;
  attachments?: {
    id: string;
    filename: string;
    content_type: string;
    size: number;
    unavailable?: string;
  }[];
  received_for?: string[];
  size?: number;
}

export function EmailDetail({
  kind,
  id,
}: {
  kind: "sent" | "received";
  id: string;
}) {
  const { data, error } = useLoad(
    () => api<Detail>(`/emails/${kind}/${id}`),
    [kind, id],
  );
  const [tab, setTab] = useState<"preview" | "text" | "json">("preview");
  const { run } = useAction();
  if (!data) return <Loading error={error} />;
  const download = (aid: string) =>
    run(async () => {
      const a = await api<{ download_url: string | null }>(
        `/emails/received/${id}/attachments/${aid}`,
      );
      if (a.download_url) window.open(a.download_url, "_blank", "noopener");
    });
  return (
    <Page
      title={data.subject ?? "(no subject)"}
      sub={<a href={`#/emails/${kind}`}>← All {kind} emails</a>}
    >
      <div class="panel">
        <dl class="kv">
          <dt>ID</dt>
          <dd>
            <code>{data.id}</code>
          </dd>
          {data.last_event && (
            <>
              <dt>Status</dt>
              <dd>
                <Badge kind={EVENT_KIND[data.last_event] ?? "muted"}>
                  {data.last_event}
                </Badge>
                {data.error && <span class="err-text"> {data.error}</span>}
              </dd>
            </>
          )}
          <dt>From</dt>
          <dd>{data.from}</dd>
          <dt>To</dt>
          <dd>{data.to.join(", ")}</dd>
          {!!data.cc?.length && (
            <>
              <dt>Cc</dt>
              <dd>{data.cc.join(", ")}</dd>
            </>
          )}
          {!!data.bcc?.length && (
            <>
              <dt>Bcc</dt>
              <dd>{data.bcc.join(", ")}</dd>
            </>
          )}
          {!!data.reply_to?.length && (
            <>
              <dt>Reply-To</dt>
              <dd>{data.reply_to.join(", ")}</dd>
            </>
          )}
          {data.received_for && (
            <>
              <dt>Delivered to</dt>
              <dd>{data.received_for.join(", ")}</dd>
            </>
          )}
          <dt>Date</dt>
          <dd>{fmtDate(data.created_at)}</dd>
          {data.authentication && (
            <>
              <dt>Authentication</dt>
              <dd class="row">
                {Object.entries(data.authentication).map(([k, v]) => (
                  <Badge
                    key={k}
                    kind={v === "pass" ? "ok" : v === "fail" ? "err" : "muted"}
                  >
                    {k.toUpperCase()} {v}
                  </Badge>
                ))}
              </dd>
            </>
          )}
          {data.size !== undefined && (
            <>
              <dt>Size</dt>
              <dd>{bytes(data.size)}</dd>
            </>
          )}
        </dl>
        {!!data.attachments?.length && (
          <div class="atts">
            {data.attachments.map((a) => (
              <button
                key={a.id}
                class="att"
                disabled={!!a.unavailable}
                title={a.unavailable}
                onClick={() => download(a.id)}
              >
                📎 {a.filename} <small>{bytes(a.size)}</small>
              </button>
            ))}
          </div>
        )}
      </div>
      <div class="tabs">
        {(["preview", "text", "json"] as const).map((t) => (
          <a
            key={t}
            href="javascript:void 0"
            class={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t === "preview" ? "Preview" : t === "text" ? "Plain text" : "JSON"}
          </a>
        ))}
      </div>
      {tab === "preview" &&
        (data.html ? (
          <iframe
            class="preview"
            sandbox=""
            srcdoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">${data.html}`}
            title="Email preview"
          />
        ) : (
          <pre class="plain">{data.text ?? "(no body stored)"}</pre>
        ))}
      {tab === "text" && (
        <pre class="plain">{data.text ?? "(no plain-text part)"}</pre>
      )}
      {tab === "json" && <Json value={data} />}
    </Page>
  );
}

// ── domains ────────────────────────────────────────────────────────────────
export function Domains() {
  const { data, error } = useLoad(() =>
    api<{
      data: {
        name: string;
        sending: boolean;
        receiving: boolean;
        mailboxes: number;
      }[];
      any_send_domain: boolean;
      any_inbound_domain: boolean;
    }>("/domains"),
  );
  return (
    <Page
      title="Domains"
      sub={
        <>
          Domains come from <code>SEND_DOMAINS</code> and{" "}
          <code>INBOUND_DOMAINS</code>. DNS is set up in the Cloudflare
          dashboard (Email Sending onboarding and Email Routing).
        </>
      }
    >
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          {(data.any_send_domain || data.any_inbound_domain) && (
            <div class="notice info">
              {data.any_send_domain && (
                <div>
                  No SEND_DOMAINS set: any domain onboarded in Email Sending may
                  be used in From.
                </div>
              )}
              {data.any_inbound_domain && (
                <div>
                  No INBOUND_DOMAINS set: mail for any domain routed to this
                  Worker is accepted.
                </div>
              )}
            </div>
          )}
          {!data.data.length ? (
            <Empty>No domains configured.</Empty>
          ) : (
            <table class="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Sending</th>
                  <th>Receiving</th>
                  <th>Mailboxes</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((d) => (
                  <tr key={d.name}>
                    <td>
                      <strong>{d.name}</strong>
                    </td>
                    <td>
                      {d.sending ? (
                        <Badge kind="ok">enabled</Badge>
                      ) : (
                        <Badge>off</Badge>
                      )}
                    </td>
                    <td>
                      {d.receiving ? (
                        <Badge kind="ok">enabled</Badge>
                      ) : (
                        <Badge>off</Badge>
                      )}
                    </td>
                    <td>{d.mailboxes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Page>
  );
}

// ── API keys ───────────────────────────────────────────────────────────────
interface Key {
  id: string;
  name: string;
  prefix: string;
  permission: string;
  created_at: string;
  last_used_at: string | null;
}

export function ApiKeys() {
  const { data, error, reload } = useLoad(() =>
    api<ListResponse<Key>>("/api-keys"),
  );
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [perm, setPerm] = useState("sending_access");
  const { busy, run } = useAction();
  return (
    <Page
      title="API keys"
      sub="Bearer keys for the Resend-compatible API. Only a hash is stored."
      actions={
        <button class="btn primary" onClick={() => setCreating(true)}>
          Create API key
        </button>
      }
    >
      {!data ? (
        <Loading error={error} />
      ) : !data.data.length ? (
        <Empty>No API keys yet.</Empty>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th>Permission</th>
              <th>Last used</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.data.map((k) => (
              <tr key={k.id}>
                <td>
                  <strong>{k.name}</strong>
                </td>
                <td>
                  <code>{k.prefix}…</code>
                </td>
                <td>
                  <Badge
                    kind={k.permission === "full_access" ? "warn" : "info"}
                  >
                    {k.permission === "full_access"
                      ? "Full access"
                      : "Sending access"}
                  </Badge>
                </td>
                <td class="muted">{ago(k.last_used_at)}</td>
                <td class="muted">{fmtDate(k.created_at)}</td>
                <td class="right">
                  <button
                    class="btn sm danger"
                    onClick={() =>
                      confirm(
                        `Revoke "${k.name}"? Apps using it stop working immediately.`,
                      ) &&
                      run(
                        () => api(`/api-keys/${k.id}`, { method: "DELETE" }),
                        "Revoked",
                      ).then(reload)
                    }
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && (
        <Modal
          title={token ? "API key created" : "Create API key"}
          onClose={() => {
            setCreating(false);
            setToken(null);
            setName("");
          }}
        >
          {token ? (
            <Secret
              value={token}
              note="Copy it now: it will not be shown again."
            />
          ) : (
            <>
              <Field label="Name">
                <input
                  value={name}
                  placeholder="production app"
                  onInput={onInput(setName)}
                />
              </Field>
              <Field
                label="Permission"
                hint="Sending access can only call POST /emails and /emails/batch."
              >
                <select value={perm} onChange={onInput(setPerm)}>
                  <option value="sending_access">Sending access</option>
                  <option value="full_access">Full access</option>
                </select>
              </Field>
              <div class="row end">
                <button
                  class="btn primary"
                  disabled={busy || !name.trim()}
                  onClick={() =>
                    run(async () => {
                      const r = await api<{ token: string }>("/api-keys", {
                        body: { name, permission: perm },
                      });
                      setToken(r.token);
                      reload();
                    })
                  }
                >
                  Create
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </Page>
  );
}

// ── webhooks ───────────────────────────────────────────────────────────────
const EVENTS = ["email.received", "email.sent", "email.failed"];
interface Hook {
  id: string;
  endpoint: string;
  events: string[];
  status: string;
  created_at: string;
  signing_secret?: string;
}

export function Webhooks({ id }: { id?: string }) {
  return id ? <WebhookDetail id={id} /> : <WebhookList />;
}

function WebhookList() {
  const { data, error, reload } = useLoad(() =>
    api<ListResponse<Hook>>("/webhooks"),
  );
  const [creating, setCreating] = useState(false);
  return (
    <Page
      title="Webhooks"
      sub="Signed with Svix headers (svix-id, svix-timestamp, svix-signature). Failed deliveries retry up to 7 times."
      actions={
        <button class="btn primary" onClick={() => setCreating(true)}>
          Add endpoint
        </button>
      }
    >
      {!data ? (
        <Loading error={error} />
      ) : !data.data.length ? (
        <Empty>No webhooks yet.</Empty>
      ) : (
        <table class="table click">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Events</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((h) => (
              <tr key={h.id} onClick={() => navigate(`/webhooks/${h.id}`)}>
                <td class="trunc">
                  <code>{h.endpoint}</code>
                </td>
                <td>{h.events.join(", ")}</td>
                <td>
                  <Badge kind={h.status === "enabled" ? "ok" : "muted"}>
                    {h.status}
                  </Badge>
                </td>
                <td class="muted">{fmtDate(h.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && (
        <HookForm
          onClose={() => setCreating(false)}
          onSaved={(nid) => {
            setCreating(false);
            reload();
            navigate(`/webhooks/${nid}`);
          }}
        />
      )}
    </Page>
  );
}

function HookForm(p: {
  hook?: Hook;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [endpoint, setEndpoint] = useState(p.hook?.endpoint ?? "");
  const [events, setEvents] = useState<string[]>(
    p.hook?.events ?? ["email.received"],
  );
  const { busy, run } = useAction();
  return (
    <Modal
      title={p.hook ? "Edit webhook" : "Add webhook endpoint"}
      onClose={p.onClose}
    >
      <Field label="Endpoint URL" hint="Must be https.">
        <input
          value={endpoint}
          placeholder="https://app.example.com/webhooks/email"
          onInput={onInput(setEndpoint)}
        />
      </Field>
      <fieldset class="checks">
        <legend>Events</legend>
        {EVENTS.map((ev) => (
          <label key={ev}>
            <input
              type="checkbox"
              checked={events.includes(ev)}
              onChange={(e) =>
                setEvents(
                  e.currentTarget.checked
                    ? [...events, ev]
                    : events.filter((x) => x !== ev),
                )
              }
            />
            <code>{ev}</code>
          </label>
        ))}
      </fieldset>
      <div class="row end">
        <button
          class="btn primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (p.hook) {
                await api(`/webhooks/${p.hook.id}`, {
                  method: "PATCH",
                  body: { endpoint, events },
                });
                p.onSaved(p.hook.id);
              } else {
                const r = await api<{ id: string }>("/webhooks", {
                  body: { endpoint, events },
                });
                p.onSaved(r.id);
              }
            }, "Saved")
          }
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

interface Delivery {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
  next_attempt_at: number;
}

function WebhookDetail({ id }: { id: string }) {
  const hook = useLoad(() => api<Hook>(`/webhooks/${id}`), [id]);
  const dels = useLoad(
    () => api<ListResponse<Delivery>>(`/webhooks/${id}/deliveries`),
    [id],
  );
  const [editing, setEditing] = useState(false);
  const [show, setShow] = useState(false);
  const { busy, run } = useAction();
  const h = hook.data;
  if (!h) return <Loading error={hook.error} />;
  return (
    <Page
      title={new URL(h.endpoint).host}
      sub={<a href="#/webhooks">← All webhooks</a>}
      actions={
        <>
          <button class="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            class="btn"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  api(`/webhooks/${id}`, {
                    method: "PATCH",
                    body: {
                      status: h.status === "enabled" ? "disabled" : "enabled",
                    },
                  }),
                "Updated",
              ).then(hook.reload)
            }
          >
            {h.status === "enabled" ? "Disable" : "Enable"}
          </button>
          <button
            class="btn danger"
            onClick={() =>
              confirm("Delete this webhook and its delivery history?") &&
              run(
                () => api(`/webhooks/${id}`, { method: "DELETE" }),
                "Deleted",
              ).then(() => navigate("/webhooks"))
            }
          >
            Delete
          </button>
        </>
      }
    >
      <div class="panel">
        <dl class="kv">
          <dt>Endpoint</dt>
          <dd>
            <code>{h.endpoint}</code>
          </dd>
          <dt>Events</dt>
          <dd>{h.events.join(", ")}</dd>
          <dt>Status</dt>
          <dd>
            <Badge kind={h.status === "enabled" ? "ok" : "muted"}>
              {h.status}
            </Badge>
          </dd>
          <dt>Signing secret</dt>
          <dd>
            {show && h.signing_secret ? (
              <Secret value={h.signing_secret} />
            ) : (
              <button class="btn sm" onClick={() => setShow(true)}>
                Reveal
              </button>
            )}
          </dd>
        </dl>
      </div>
      <div class="section-head">
        <h3>Recent deliveries</h3>
        <button
          class="btn sm"
          disabled={busy}
          onClick={() =>
            run(
              () => api("/webhooks/retry", { body: {} }),
              "Retry started",
            ).then(dels.reload)
          }
        >
          Retry due now
        </button>
      </div>
      {!dels.data ? (
        <Loading error={dels.error} />
      ) : !dels.data.data.length ? (
        <Empty>No deliveries yet.</Empty>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>HTTP</th>
              <th>Error</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {dels.data.data.map((d) => (
              <tr key={d.id}>
                <td>
                  <code>{d.event_type}</code>
                </td>
                <td>
                  <Badge
                    kind={
                      d.status === "delivered"
                        ? "ok"
                        : d.status === "failed"
                          ? "err"
                          : "warn"
                    }
                  >
                    {d.status}
                  </Badge>
                </td>
                <td>{d.attempts}</td>
                <td>{d.last_status ?? "—"}</td>
                <td class="trunc muted" title={d.last_error ?? ""}>
                  {d.last_error ?? ""}
                </td>
                <td class="muted nowrap">{fmtDate(d.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <HookForm
          hook={h}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            hook.reload();
          }}
        />
      )}
    </Page>
  );
}
