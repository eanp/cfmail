/**
 * Webmail. Route: #/mail/<mailbox id>/<folder>[/<thread key>].
 * Three columns: folders | conversations | reader. Compose docks bottom-right.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import {
  Badge,
  bytes,
  displayName,
  Empty,
  fmtDate,
  Loading,
  navigate,
  onInput,
  shortTime,
  useAction,
  useLoad,
} from "../kit";

interface Box {
  id: string;
  address: string;
  name: string;
  signature: string | null;
  can_send: number;
  unread: number;
  spam_unread: number;
}
interface ThreadRow {
  thread_key: string;
  latest_id: string;
  direction: "in" | "out";
  from: string;
  to: string[];
  subject: string | null;
  snippet: string | null;
  count: number;
  unread: number;
  starred: boolean;
  has_attachments: boolean;
  created_at: number;
}
interface Msg {
  id: string;
  direction: "in" | "out";
  folder: string;
  from: string;
  to: string[];
  cc: string[];
  reply_to?: string[];
  received_for?: string[];
  subject: string | null;
  snippet: string | null;
  message_id: string | null;
  starred: boolean;
  created_at: string;
  authentication?: Record<string, string> | null;
  has_remote_images: boolean;
  status?: string | null;
  error?: string | null;
  attachments: {
    id?: string;
    filename: string;
    content_type: string;
    size: number;
    url?: string | null;
  }[];
}

const FOLDERS: { key: string; label: string; icon: string }[] = [
  { key: "inbox", label: "Inbox", icon: "📥" },
  { key: "starred", label: "Starred", icon: "★" },
  { key: "sent", label: "Sent", icon: "➤" },
  { key: "archive", label: "Archive", icon: "🗄" },
  { key: "spam", label: "Spam", icon: "⚠" },
  { key: "trash", label: "Trash", icon: "🗑" },
];

interface Draft {
  mode: "new" | "reply" | "replyAll" | "forward";
  parent?: Msg;
  to: string;
  cc: string;
  subject: string;
  text: string;
  from_address?: string;
}

export function Mail({ path }: { path: string[] }) {
  const boxes = useLoad(() => api<{ data: Box[] }>("/mail/mailboxes"));
  const [boxId, folder = "inbox", rawKey] = path;
  const threadKey = rawKey ? decodeURIComponent(rawKey) : undefined;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => {
    setTick((t) => t + 1);
    boxes.reload();
  };

  // Refresh every 60 s while the tab is visible.
  useEffect(() => {
    const t = setInterval(
      () => document.visibilityState === "visible" && refresh(),
      60_000,
    );
    return () => clearInterval(t);
  }, []);

  if (!boxes.data) return <Loading error={boxes.error} />;
  const list = boxes.data.data;
  if (!list.length)
    return (
      <div class="pad">
        <Empty>
          You are not a member of any mailbox yet. Ask an admin to add you under
          <b> Mailboxes</b>.
        </Empty>
      </div>
    );
  const box = list.find((b) => b.id === boxId);
  if (!box) {
    navigate(`/mail/${list[0]!.id}/inbox`);
    return null;
  }
  const base = `/mail/${box.id}`;
  const compose = (d: Partial<Draft> & { mode: Draft["mode"] }) =>
    setDraft({ to: "", cc: "", subject: "", text: "", ...d });

  return (
    <div class={`mail ${threadKey ? "reading" : ""}`}>
      <aside class="mail-side">
        <button
          class="btn primary compose-btn"
          disabled={!box.can_send}
          title={box.can_send ? "" : "You cannot send from this mailbox"}
          onClick={() => compose({ mode: "new" })}
        >
          ✎ Compose
        </button>
        {list.length > 1 ? (
          <select
            class="box-select"
            value={box.id}
            onChange={(e) => navigate(`/mail/${e.currentTarget.value}/inbox`)}
            aria-label="Mailbox"
          >
            {list.map((b) => (
              <option key={b.id} value={b.id}>
                {b.address}
                {b.unread ? ` (${b.unread})` : ""}
              </option>
            ))}
          </select>
        ) : (
          <div class="box-name" title={box.address}>
            {box.address}
          </div>
        )}
        <nav class="folders">
          {FOLDERS.map((f) => {
            const n =
              f.key === "inbox"
                ? box.unread
                : f.key === "spam"
                  ? box.spam_unread
                  : 0;
            return (
              <a
                key={f.key}
                href={`#${base}/${f.key}`}
                class={folder === f.key ? "active" : ""}
              >
                <span aria-hidden="true">{f.icon}</span> {f.label}
                {n > 0 && <span class="count">{n}</span>}
              </a>
            );
          })}
        </nav>
      </aside>
      <ThreadList
        key={`${box.id}/${folder}`}
        box={box}
        folder={folder}
        active={threadKey}
        tick={tick}
        onChange={refresh}
      />
      <section class="reader">
        {threadKey ? (
          <Thread
            key={threadKey}
            box={box}
            folder={folder}
            threadKey={threadKey}
            tick={tick}
            onBack={() => navigate(`${base}/${folder}`)}
            onChange={refresh}
            onCompose={compose}
          />
        ) : (
          <div class="reader-empty muted">Select a conversation</div>
        )}
      </section>
      {draft && (
        <Compose
          box={box}
          draft={draft}
          onClose={() => setDraft(null)}
          onSent={() => {
            setDraft(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ThreadList(p: {
  box: Box;
  folder: string;
  active?: string;
  tick: number;
  onChange: () => void;
}) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState<number[]>([]);
  const before = pages[pages.length - 1];
  const { data, error, reload } = useLoad(
    () =>
      api<{ data: ThreadRow[]; has_more: boolean }>(
        `/mail/threads?mailbox=${p.box.id}&folder=${p.folder}${search ? `&q=${encodeURIComponent(search)}` : ""}${before ? `&before=${before}` : ""}`,
      ),
    [p.box.id, p.folder, search, before, p.tick],
  );
  const [sel, setSel] = useState<Set<string>>(new Set());
  const { run } = useAction();
  useEffect(() => setSel(new Set()), [p.folder, search, before]);

  /** Apply an action to every message of the selected conversations. */
  const bulk = (action: string, label: string) =>
    run(async () => {
      const ids: string[] = [];
      for (const key of sel) {
        const t = await api<{ messages: { id: string }[] }>(
          `/mail/thread?mailbox=${p.box.id}&key=${encodeURIComponent(key)}&folder=${p.folder}`,
        );
        ids.push(...t.messages.map((m) => m.id));
      }
      await api("/mail/action", { body: { ids, action } });
      setSel(new Set());
      p.onChange();
      reload();
    }, label);

  const open = (t: ThreadRow) =>
    navigate(
      `/mail/${p.box.id}/${p.folder}/${encodeURIComponent(t.thread_key)}`,
    );
  const rows = data?.data ?? [];
  return (
    <section class="threads">
      <form
        class="search"
        onSubmit={(e) => {
          e.preventDefault();
          setPages([]);
          setSearch(q.trim());
        }}
      >
        <input
          type="search"
          placeholder="Search mail"
          value={q}
          onInput={onInput(setQ)}
          aria-label="Search mail"
        />
      </form>
      <div class="list-tools">
        <input
          type="checkbox"
          aria-label="Select all"
          checked={!!rows.length && sel.size === rows.length}
          onChange={(e) =>
            setSel(
              e.currentTarget.checked
                ? new Set(rows.map((r) => r.thread_key))
                : new Set(),
            )
          }
        />
        {sel.size > 0 ? (
          <div class="row tight">
            {p.folder === "inbox" && (
              <button
                class="btn sm"
                onClick={() => bulk("archive", "Archived")}
              >
                Archive
              </button>
            )}
            {p.folder === "spam" && (
              <button
                class="btn sm"
                onClick={() => bulk("inbox", "Moved to inbox")}
              >
                Not spam
              </button>
            )}
            {p.folder === "trash" ? (
              <>
                <button
                  class="btn sm"
                  onClick={() => bulk("restore", "Restored")}
                >
                  Restore
                </button>
                <button
                  class="btn sm danger"
                  onClick={() =>
                    confirm("Delete forever?") && bulk("delete", "Deleted")
                  }
                >
                  Delete forever
                </button>
              </>
            ) : (
              <button
                class="btn sm"
                onClick={() => bulk("trash", "Moved to trash")}
              >
                Trash
              </button>
            )}
            <button class="btn sm" onClick={() => bulk("read", "Marked read")}>
              Read
            </button>
            <button
              class="btn sm"
              onClick={() => bulk("unread", "Marked unread")}
            >
              Unread
            </button>
          </div>
        ) : (
          <button
            class="btn sm ghost"
            onClick={() => {
              p.onChange();
              reload();
            }}
            title="Refresh"
          >
            ↻
          </button>
        )}
      </div>
      {search && (
        <div class="search-note muted">
          Results for “{search}”{" "}
          <button
            class="link"
            onClick={() => {
              setQ("");
              setSearch("");
            }}
          >
            clear
          </button>
        </div>
      )}
      {!data ? (
        <Loading error={error} />
      ) : !rows.length ? (
        <Empty>{search ? "No matches." : "Nothing here."}</Empty>
      ) : (
        <ul class="thread-list">
          {rows.map((t) => (
            <li
              key={t.thread_key}
              class={`${t.unread ? "unread" : ""} ${p.active === t.thread_key ? "active" : ""}`}
              onClick={() => open(t)}
            >
              <input
                type="checkbox"
                checked={sel.has(t.thread_key)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const s = new Set(sel);
                  if (e.currentTarget.checked) s.add(t.thread_key);
                  else s.delete(t.thread_key);
                  setSel(s);
                }}
                aria-label="Select conversation"
              />
              <div class="t-main">
                <div class="t-top">
                  <span class="t-from">
                    {t.direction === "out"
                      ? `To: ${t.to.map(displayName).join(", ")}`
                      : displayName(t.from)}
                    {t.count > 1 && <span class="t-count">{t.count}</span>}
                  </span>
                  <span class="t-time">{shortTime(t.created_at)}</span>
                </div>
                <div class="t-subject">
                  {t.starred && <span class="star on">★</span>}
                  {t.subject || "(no subject)"}
                  {t.has_attachments && (
                    <span aria-label="has attachments"> 📎</span>
                  )}
                </div>
                <div class="t-snippet">{t.snippet}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {(pages.length > 0 || data?.has_more) && (
        <div class="pager">
          <button
            class="btn sm"
            disabled={!pages.length}
            onClick={() => setPages(pages.slice(0, -1))}
          >
            ← Newer
          </button>
          <button
            class="btn sm"
            disabled={!data?.has_more}
            onClick={() =>
              setPages([...pages, rows[rows.length - 1]!.created_at])
            }
          >
            Older →
          </button>
        </div>
      )}
    </section>
  );
}

function Thread(p: {
  box: Box;
  folder: string;
  threadKey: string;
  tick: number;
  onBack: () => void;
  onChange: () => void;
  onCompose: (d: Partial<Draft> & { mode: Draft["mode"] }) => void;
}) {
  const { data, error, reload } = useLoad(
    () =>
      api<{ messages: Msg[] }>(
        `/mail/thread?mailbox=${p.box.id}&key=${encodeURIComponent(p.threadKey)}&folder=${p.folder === "trash" ? "trash" : ""}`,
      ),
    [p.threadKey, p.tick],
  );
  const { run } = useAction();
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (data?.messages.length)
      setOpen(new Set([data.messages[data.messages.length - 1]!.id]));
    // Opening a thread marks it read on the server: refresh unread counts.
    if (data) p.onChange();
  }, [data?.messages.length]);

  if (!data) return <Loading error={error} />;
  const msgs = data.messages;
  const ids = msgs.map((m) => m.id);
  const last = msgs[msgs.length - 1]!;
  const starred = msgs.some((m) => m.starred);
  const act = (action: string, label: string, leave = true) =>
    run(async () => {
      await api("/mail/action", { body: { ids, action } });
      p.onChange();
      if (leave) p.onBack();
      else reload();
    }, label);
  const lastIn = [...msgs].reverse().find((m) => m.direction === "in") ?? last;

  const reply = (m: Msg, all: boolean) => {
    const own = p.box.address.toLowerCase();
    const addr = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).toLowerCase();
    const target =
      m.direction === "out" ? m.to : m.reply_to?.length ? m.reply_to : [m.from];
    const cc = all
      ? [...m.to, ...m.cc].filter(
          (x) =>
            addr(x) !== own &&
            !m.received_for?.map((r) => r.toLowerCase()).includes(addr(x)) &&
            !target.includes(x),
        )
      : [];
    p.onCompose({
      mode: all ? "replyAll" : "reply",
      parent: m,
      to: target.join(", "),
      cc: cc.join(", "),
      subject: /^re:/i.test(m.subject ?? "")
        ? (m.subject ?? "")
        : `Re: ${m.subject ?? ""}`,
      text: `\n\nOn ${fmtDate(m.created_at)}, ${m.from} wrote:\n${(m.snippet ?? "").replace(/^/gm, "> ")}`,
      from_address: m.received_for?.[0],
    });
  };

  return (
    <div class="thread">
      <header class="thread-head">
        <button class="btn sm ghost back" onClick={p.onBack} aria-label="Back">
          ←
        </button>
        <h2>{last.subject || "(no subject)"}</h2>
        <div class="row tight">
          <button
            class="btn sm ghost"
            title={starred ? "Unstar" : "Star"}
            onClick={() =>
              act(
                starred ? "unstar" : "star",
                starred ? "Unstarred" : "Starred",
                false,
              )
            }
          >
            <span class={`star ${starred ? "on" : ""}`}>★</span>
          </button>
          {p.folder === "inbox" && (
            <button class="btn sm" onClick={() => act("archive", "Archived")}>
              Archive
            </button>
          )}
          {p.folder === "spam" ? (
            <button
              class="btn sm"
              onClick={() => act("inbox", "Moved to inbox")}
            >
              Not spam
            </button>
          ) : (
            p.folder !== "trash" &&
            p.folder !== "sent" && (
              <button
                class="btn sm"
                onClick={() => act("spam", "Marked as spam")}
              >
                Spam
              </button>
            )
          )}
          {p.folder === "trash" ? (
            <button class="btn sm" onClick={() => act("restore", "Restored")}>
              Restore
            </button>
          ) : (
            <button
              class="btn sm"
              onClick={() => act("trash", "Moved to trash")}
            >
              Trash
            </button>
          )}
          <button class="btn sm" onClick={() => act("unread", "Marked unread")}>
            Unread
          </button>
        </div>
      </header>
      <div class="messages">
        {msgs.map((m) => (
          <Message
            key={m.id}
            m={m}
            open={open.has(m.id)}
            toggle={() => {
              const s = new Set(open);
              if (s.has(m.id)) s.delete(m.id);
              else s.add(m.id);
              setOpen(s);
            }}
          />
        ))}
      </div>
      {!!p.box.can_send && (
        <div class="reply-bar">
          <button class="btn" onClick={() => reply(lastIn, false)}>
            ↩ Reply
          </button>
          <button class="btn" onClick={() => reply(lastIn, true)}>
            ↩↩ Reply all
          </button>
          <button
            class="btn"
            onClick={() =>
              p.onCompose({
                mode: "forward",
                parent: lastIn,
                subject: /^fwd:/i.test(lastIn.subject ?? "")
                  ? (lastIn.subject ?? "")
                  : `Fwd: ${lastIn.subject ?? ""}`,
                from_address: lastIn.received_for?.[0],
              })
            }
          >
            ↪ Forward
          </button>
        </div>
      )}
    </div>
  );
}

function Message({
  m,
  open,
  toggle,
}: {
  m: Msg;
  open: boolean;
  toggle: () => void;
}) {
  const [images, setImages] = useState(false);
  const auth = m.authentication;
  const failed = auth && Object.values(auth).some((v) => v === "fail");
  return (
    <article class={`msg ${open ? "open" : ""}`}>
      <header onClick={toggle}>
        <span class="avatar sm">{displayName(m.from)[0]?.toUpperCase()}</span>
        <div class="msg-who">
          <strong>{displayName(m.from)}</strong>
          {open ? (
            <small class="muted">
              {m.from.includes("<") ? m.from.replace(/^.*</, "<") : ""} to{" "}
              {m.to.join(", ")}
              {m.cc.length ? `, cc ${m.cc.join(", ")}` : ""}
            </small>
          ) : (
            <small class="muted">{m.snippet}</small>
          )}
        </div>
        <span class="muted nowrap">{fmtDate(m.created_at)}</span>
      </header>
      {open && (
        <div class="msg-body">
          {failed && (
            <div class="notice err">
              This message failed sender authentication (
              {Object.entries(auth!)
                .map(([k, v]) => `${k.toUpperCase()} ${v}`)
                .join(", ")}
              ). Be careful with links and attachments.
            </div>
          )}
          {m.status === "failed" && (
            <div class="notice err">Not delivered: {m.error}</div>
          )}
          {m.status === "logged" && (
            <div class="notice warn">
              Log mode: this message was recorded but not sent.
            </div>
          )}
          {m.has_remote_images && !images && (
            <div class="notice info">
              Remote images are hidden.{" "}
              <button class="link" onClick={() => setImages(true)}>
                Show images
              </button>
            </div>
          )}
          <BodyFrame id={m.id} images={images} />
          {!!m.attachments.length && (
            <div class="atts">
              {m.attachments.map((a, i) =>
                a.url ? (
                  <a
                    key={a.id ?? i}
                    class="att"
                    href={a.url}
                    target="_blank"
                    rel="noopener"
                  >
                    📎 {a.filename} <small>{bytes(a.size)}</small>
                  </a>
                ) : (
                  <span key={a.id ?? i} class="att disabled" title="Not stored">
                    📎 {a.filename} <small>{bytes(a.size)}</small>
                  </span>
                ),
              )}
            </div>
          )}
          {auth && !failed && (
            <div class="row tight auth-badges">
              {Object.entries(auth).map(([k, v]) => (
                <Badge key={k} kind={v === "pass" ? "ok" : "muted"}>
                  {k.toUpperCase()} {v}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** Sandboxed iframe that grows to fit its content (best effort). */
function BodyFrame({ id, images }: { id: string; images: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(240);
  // A sandboxed frame without allow-same-origin cannot be measured; give it
  // a generous height that the user can scroll within.
  useEffect(
    () => setH(Math.max(240, Math.round(window.innerHeight * 0.6))),
    [],
  );
  return (
    <iframe
      ref={ref}
      class="body-frame"
      style={{ height: `${h}px` }}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      src={`/app/api/mail/messages/${id}/body${images ? "?images=1" : ""}`}
      title="Message"
    />
  );
}

function Compose(p: {
  box: Box;
  draft: Draft;
  onClose: () => void;
  onSent: () => void;
}) {
  const d = p.draft;
  const catchAll = p.box.address.startsWith("*@");
  const domain = p.box.address.split("@")[1] ?? "";
  const [from, setFrom] = useState(
    catchAll
      ? d.from_address && d.from_address.endsWith(`@${domain}`)
        ? d.from_address
        : `hello@${domain}`
      : p.box.address,
  );
  const [to, setTo] = useState(d.to);
  const [cc, setCc] = useState(d.cc);
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(!!d.cc);
  const [subject, setSubject] = useState(d.subject);
  const [text, setText] = useState(d.text);
  const [files, setFiles] = useState<File[]>([]);
  const [min, setMin] = useState(false);
  const { busy, run } = useAction();
  const split = (s: string) =>
    s
      .split(/[,;\n]/)
      .map((x) => x.trim())
      .filter(Boolean);

  const send = () =>
    run(async () => {
      const total = files.reduce((n, f) => n + f.size, 0);
      if (total > 10 * 1024 * 1024)
        throw new Error("Attachments are larger than 10 MB.");
      const attachments = await Promise.all(
        files.map(async (f) => ({
          filename: f.name,
          content_type: f.type || undefined,
          content: await toBase64(f),
        })),
      );
      await api("/mail/send", {
        body: {
          mailbox_id: p.box.id,
          ...(catchAll ? { from_address: from } : {}),
          to: split(to),
          cc: split(cc),
          bcc: split(bcc),
          subject,
          text,
          ...(d.mode === "forward" && d.parent
            ? { forward_id: d.parent.id }
            : {}),
          ...((d.mode === "reply" || d.mode === "replyAll") && d.parent
            ? { reply_to_id: d.parent.id }
            : {}),
          attachments,
        },
      });
      p.onSent();
    }, "Sent");

  const title =
    d.mode === "new"
      ? "New message"
      : d.mode === "forward"
        ? "Forward"
        : "Reply";
  return (
    <div class={`compose ${min ? "min" : ""}`} role="dialog" aria-label={title}>
      <header onClick={() => setMin(!min)}>
        <strong>{subject || title}</strong>
        <span class="row tight">
          <button
            class="icon"
            aria-label="Minimize"
            onClick={(e) => {
              e.stopPropagation();
              setMin(!min);
            }}
          >
            ▁
          </button>
          <button
            class="icon"
            aria-label="Close"
            onClick={(e) => {
              e.stopPropagation();
              if (!text.trim() || confirm("Discard this draft?")) p.onClose();
            }}
          >
            ✕
          </button>
        </span>
      </header>
      {!min && (
        <div class="compose-body">
          <label class="cline">
            <span>From</span>
            {catchAll ? (
              <input value={from} onInput={onInput(setFrom)} />
            ) : (
              <span class="muted">
                {p.box.name} &lt;{p.box.address}&gt;
              </span>
            )}
          </label>
          <label class="cline">
            <span>To</span>
            <input
              value={to}
              onInput={onInput(setTo)}
              autoFocus={d.mode === "new" || d.mode === "forward"}
            />
            {!showCc && (
              <button class="link" onClick={() => setShowCc(true)}>
                Cc/Bcc
              </button>
            )}
          </label>
          {showCc && (
            <>
              <label class="cline">
                <span>Cc</span>
                <input value={cc} onInput={onInput(setCc)} />
              </label>
              <label class="cline">
                <span>Bcc</span>
                <input value={bcc} onInput={onInput(setBcc)} />
              </label>
            </>
          )}
          <label class="cline">
            <span>Subject</span>
            <input value={subject} onInput={onInput(setSubject)} />
          </label>
          <textarea
            class="compose-text"
            value={text}
            onInput={onInput(setText)}
            autoFocus={d.mode === "reply" || d.mode === "replyAll"}
          />
          {d.mode === "forward" && d.parent && (
            <p class="muted small">
              The original message
              {d.parent.attachments.length ? " and its attachments" : ""} will
              be included.
            </p>
          )}
          {p.box.signature && (
            <p class="muted small">
              Your mailbox signature is added automatically.
            </p>
          )}
          {!!files.length && (
            <div class="atts">
              {files.map((f, i) => (
                <span class="att" key={i}>
                  📎 {f.name} <small>{bytes(f.size)}</small>
                  <button
                    class="icon"
                    aria-label="Remove"
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <footer>
            <button
              class="btn primary"
              disabled={busy || !to.trim()}
              onClick={send}
            >
              {busy ? "Sending…" : "Send"}
            </button>
            <label class="btn ghost" title="Attach files">
              📎
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const add = [...(e.currentTarget.files ?? [])];
                  setFiles([...files, ...add]);
                  e.currentTarget.value = "";
                }}
              />
            </label>
          </footer>
        </div>
      )}
    </div>
  );
}

function toBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error(`Could not read ${f.name}`));
    r.readAsDataURL(f);
  });
}
