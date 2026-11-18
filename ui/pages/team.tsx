/** Workspace pages: mailboxes, users, roles (RBAC), audit log, account. */
import { useState } from "preact/hooks";
import { api, type ListResponse } from "../api";
import {
  ago,
  Badge,
  Empty,
  Field,
  fmtDate,
  Loading,
  Modal,
  onInput,
  Page,
  Secret,
  useAction,
  useCan,
  useLoad,
  useMe,
} from "../kit";

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  role_name: string | null;
  disabled_at: string | null;
  last_login_at: string | null;
  created_at: string;
  pending: boolean;
  sessions: number;
}
interface Role {
  key: string;
  name: string;
  description: string | null;
  builtin: boolean;
  users: number;
  permissions: string[];
}
type Catalog = Record<string, { group: string; label: string }>;

// ── mailboxes ──────────────────────────────────────────────────────────────
interface Box {
  id: string;
  address: string;
  name: string;
  signature: string | null;
  created_at: string;
  members: { user_id: string; can_send: number; email: string; name: string }[];
}

export function Mailboxes() {
  const boxes = useLoad(() => api<ListResponse<Box>>("/mailboxes"));
  const users = useLoad(() =>
    api<ListResponse<User>>("/users").catch(() => ({ data: [] as User[] })),
  );
  const [edit, setEdit] = useState<Box | "new" | null>(null);
  return (
    <Page
      title="Mailboxes"
      sub={
        <>
          Webmail inboxes. Mail is filed by recipient: an exact address (
          <code>sales@example.com</code>) wins over a catch-all (
          <code>*@example.com</code>). Messages still arrive in the API without
          a mailbox.
        </>
      }
      actions={
        <button class="btn primary" onClick={() => setEdit("new")}>
          New mailbox
        </button>
      }
    >
      {!boxes.data ? (
        <Loading error={boxes.error} />
      ) : !boxes.data.data.length ? (
        <Empty>No mailboxes yet. Create one, then add members.</Empty>
      ) : (
        <table class="table click">
          <thead>
            <tr>
              <th>Address</th>
              <th>Name</th>
              <th>Members</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {boxes.data.data.map((b) => (
              <tr key={b.id} onClick={() => setEdit(b)}>
                <td>
                  <strong>{b.address}</strong>
                </td>
                <td>{b.name}</td>
                <td class="trunc">
                  {b.members.map((m) => m.name || m.email).join(", ") || (
                    <span class="muted">none</span>
                  )}
                </td>
                <td class="muted">{fmtDate(b.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && (
        <BoxForm
          box={edit === "new" ? null : edit}
          users={users.data?.data ?? []}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            boxes.reload();
          }}
        />
      )}
    </Page>
  );
}

function BoxForm(p: {
  box: Box | null;
  users: User[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [address, setAddress] = useState(p.box?.address ?? "");
  const [name, setName] = useState(p.box?.name ?? "");
  const [signature, setSignature] = useState(p.box?.signature ?? "");
  const [members, setMembers] = useState<Record<string, boolean>>(
    Object.fromEntries(
      (p.box?.members ?? []).map((m) => [m.user_id, m.can_send === 1]),
    ),
  );
  const { busy, run } = useAction();
  const save = () =>
    run(async () => {
      let id = p.box?.id;
      if (id)
        await api(`/mailboxes/${id}`, {
          method: "PATCH",
          body: { name, signature },
        });
      else
        id = (
          await api<{ id: string }>("/mailboxes", {
            body: { address, name, signature },
          })
        ).id;
      await api(`/mailboxes/${id}/members`, {
        method: "PUT",
        body: {
          members: Object.entries(members).map(([user_id, can_send]) => ({
            user_id,
            can_send,
          })),
        },
      });
      p.onSaved();
    }, "Saved");
  return (
    <Modal
      title={p.box ? p.box.address : "New mailbox"}
      onClose={p.onClose}
      wide
    >
      {!p.box && (
        <Field
          label="Address"
          hint="sales@example.com, or *@example.com for a catch-all."
        >
          <input value={address} onInput={onInput(setAddress)} />
        </Field>
      )}
      <Field label="Display name" hint="Shown as the sender name.">
        <input
          value={name}
          placeholder="Sales team"
          onInput={onInput(setName)}
        />
      </Field>
      <Field label="Signature">
        <textarea rows={3} value={signature} onInput={onInput(setSignature)} />
      </Field>
      <fieldset class="checks">
        <legend>Members</legend>
        {!p.users.length && (
          <p class="muted">No users to add (needs users:view).</p>
        )}
        {p.users
          .filter((u) => !u.disabled_at)
          .map((u) => (
            <div class="member" key={u.id}>
              <label>
                <input
                  type="checkbox"
                  checked={u.id in members}
                  onChange={(e) => {
                    const next = { ...members };
                    if (e.currentTarget.checked) next[u.id] = true;
                    else delete next[u.id];
                    setMembers(next);
                  }}
                />
                {u.name} <span class="muted">{u.email}</span>
              </label>
              {u.id in members && (
                <label class="muted">
                  <input
                    type="checkbox"
                    checked={members[u.id]}
                    onChange={(e) =>
                      setMembers({
                        ...members,
                        [u.id]: e.currentTarget.checked,
                      })
                    }
                  />
                  can send
                </label>
              )}
            </div>
          ))}
      </fieldset>
      <div class="row between">
        {p.box ? (
          <button
            class="btn danger"
            onClick={() =>
              confirm(
                `Delete ${p.box!.address}? Its webmail folders go; emails stay in the API logs.`,
              ) &&
              run(
                () => api(`/mailboxes/${p.box!.id}`, { method: "DELETE" }),
                "Deleted",
              ).then(p.onSaved)
            }
          >
            Delete
          </button>
        ) : (
          <span />
        )}
        <button class="btn primary" disabled={busy} onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}

// ── users ──────────────────────────────────────────────────────────────────
export function Users() {
  const me = useMe();
  const manage = useCan("users:manage");
  const users = useLoad(() => api<ListResponse<User>>("/users"));
  const roles = useLoad(() => api<{ data: Role[] }>("/roles"));
  const [invite, setInvite] = useState(false);
  const [link, setLink] = useState<{ link: string; emailed: boolean } | null>(
    null,
  );
  const { run } = useAction();
  const patch = (u: User, body: Record<string, unknown>, ok: string) =>
    run(() => api(`/users/${u.id}`, { method: "PATCH", body }), ok).then(
      users.reload,
    );
  return (
    <Page
      title="Users"
      sub="Everyone who can sign in to this dashboard. Their role decides what they can do."
      actions={
        manage && (
          <button class="btn primary" onClick={() => setInvite(true)}>
            Invite user
          </button>
        )
      }
    >
      {!users.data ? (
        <Loading error={users.error} />
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last sign-in</th>
              {manage && <th />}
            </tr>
          </thead>
          <tbody>
            {users.data.data.map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.name}</strong>{" "}
                  {u.id === me.user.id && <Badge kind="info">you</Badge>}
                  <div class="muted">{u.email}</div>
                </td>
                <td>
                  {manage && u.id !== me.user.id && roles.data ? (
                    <select
                      value={u.role}
                      onChange={(e) =>
                        patch(
                          u,
                          { role: e.currentTarget.value },
                          "Role changed",
                        )
                      }
                    >
                      {roles.data.data.map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    (u.role_name ?? u.role)
                  )}
                </td>
                <td>
                  {u.disabled_at ? (
                    <Badge kind="err">disabled</Badge>
                  ) : u.pending ? (
                    <Badge kind="warn">invited</Badge>
                  ) : (
                    <Badge kind="ok">active</Badge>
                  )}
                </td>
                <td class="muted">{ago(u.last_login_at)}</td>
                {manage && (
                  <td class="right nowrap">
                    <button
                      class="btn sm"
                      onClick={() =>
                        run(() =>
                          api<{ link: string; emailed: boolean }>(
                            `/users/${u.id}/reset`,
                            { body: {} },
                          ),
                        ).then((r) => r && setLink(r))
                      }
                    >
                      {u.pending ? "Invite link" : "Reset password"}
                    </button>{" "}
                    {u.id !== me.user.id && (
                      <button
                        class={`btn sm ${u.disabled_at ? "" : "danger"}`}
                        onClick={() =>
                          patch(
                            u,
                            { disabled: !u.disabled_at },
                            u.disabled_at ? "Enabled" : "Disabled",
                          )
                        }
                      >
                        {u.disabled_at ? "Enable" : "Disable"}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {invite && roles.data && (
        <InviteForm
          roles={roles.data.data}
          onClose={() => setInvite(false)}
          onDone={(r) => {
            setInvite(false);
            setLink(r);
            users.reload();
          }}
        />
      )}
      {link && (
        <Modal title="Link ready" onClose={() => setLink(null)}>
          <p>
            {link.emailed
              ? "The link was emailed. You can also share it yourself:"
              : "Share this link with the user (it was not emailed: set SYSTEM_FROM to send it automatically):"}
          </p>
          <Secret
            value={link.link}
            note="Invite links last 7 days; reset links 1 hour."
          />
        </Modal>
      )}
    </Page>
  );
}

function InviteForm(p: {
  roles: Role[];
  onClose: () => void;
  onDone: (r: { link: string; emailed: boolean }) => void;
}) {
  const me = useMe();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("member");
  const { busy, run } = useAction();
  const assignable = p.roles.filter((r) =>
    r.permissions.every((x) => (me.user.permissions as string[]).includes(x)),
  );
  return (
    <Modal title="Invite user" onClose={p.onClose}>
      <Field label="Email">
        <input type="email" value={email} onInput={onInput(setEmail)} />
      </Field>
      <Field label="Name">
        <input value={name} onInput={onInput(setName)} />
      </Field>
      <Field label="Role">
        <select value={role} onChange={onInput(setRole)}>
          {assignable.map((r) => (
            <option key={r.key} value={r.key}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      <div class="row end">
        <button
          class="btn primary"
          disabled={busy || !email}
          onClick={() =>
            run(async () =>
              p.onDone(
                await api<{ link: string; emailed: boolean }>("/users", {
                  body: { email, name, role },
                }),
              ),
            )
          }
        >
          Invite
        </button>
      </div>
    </Modal>
  );
}

// ── roles ──────────────────────────────────────────────────────────────────
export function Roles() {
  const me = useMe();
  const { data, error, reload } = useLoad(() =>
    api<{ data: Role[]; catalog: Catalog }>("/roles"),
  );
  const [edit, setEdit] = useState<Role | "new" | null>(null);
  return (
    <Page
      title="Roles"
      sub="A role is a set of permissions. Admin always has every permission. You can only grant permissions you have yourself."
      actions={
        <button class="btn primary" onClick={() => setEdit("new")}>
          New role
        </button>
      }
    >
      {!data ? (
        <Loading error={error} />
      ) : (
        <div class="role-grid">
          {data.data.map((r) => (
            <button
              key={r.key}
              class="card role"
              onClick={() =>
                r.key !== "admin" && r.key !== me.user.role && setEdit(r)
              }
              disabled={r.key === "admin"}
            >
              <header>
                <strong>{r.name}</strong>
                {r.builtin && <Badge>built-in</Badge>}
              </header>
              <p class="muted">{r.description ?? ""}</p>
              <small class="muted">
                {r.users} user{r.users === 1 ? "" : "s"} ·{" "}
                {r.key === "admin" ? "all" : r.permissions.length} permissions
              </small>
            </button>
          ))}
        </div>
      )}
      {edit && data && (
        <RoleForm
          role={edit === "new" ? null : edit}
          catalog={data.catalog}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </Page>
  );
}

function RoleForm(p: {
  role: Role | null;
  catalog: Catalog;
  onClose: () => void;
  onSaved: () => void;
}) {
  const me = useMe();
  const [key, setKey] = useState(p.role?.key ?? "");
  const [name, setName] = useState(p.role?.name ?? "");
  const [description, setDescription] = useState(p.role?.description ?? "");
  const [perms, setPerms] = useState<string[]>(p.role?.permissions ?? []);
  const { busy, run } = useAction();
  const groups = new Map<string, string[]>();
  for (const [k, v] of Object.entries(p.catalog))
    groups.set(v.group, [...(groups.get(v.group) ?? []), k]);
  const mine = new Set<string>(me.user.permissions);
  return (
    <Modal
      title={p.role ? `Role: ${p.role.name}` : "New role"}
      onClose={p.onClose}
      wide
    >
      {!p.role && (
        <Field label="Key" hint="Lowercase, e.g. support">
          <input value={key} onInput={onInput(setKey)} />
        </Field>
      )}
      <Field label="Name">
        <input value={name} onInput={onInput(setName)} />
      </Field>
      <Field label="Description">
        <input value={description} onInput={onInput(setDescription)} />
      </Field>
      <div class="perm-groups">
        {[...groups].map(([g, keys]) => (
          <fieldset class="checks" key={g}>
            <legend>{g}</legend>
            {keys.map((k) => (
              <label
                key={k}
                title={mine.has(k) ? "" : "You do not have this permission"}
              >
                <input
                  type="checkbox"
                  disabled={!mine.has(k)}
                  checked={perms.includes(k)}
                  onChange={(e) =>
                    setPerms(
                      e.currentTarget.checked
                        ? [...perms, k]
                        : perms.filter((x) => x !== k),
                    )
                  }
                />
                {p.catalog[k]!.label} <code class="muted">{k}</code>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <div class="row between">
        {p.role && !p.role.builtin ? (
          <button
            class="btn danger"
            onClick={() =>
              confirm(`Delete role ${p.role!.name}?`) &&
              run(
                () => api(`/roles/${p.role!.key}`, { method: "DELETE" }),
                "Deleted",
              ).then(p.onSaved)
            }
          >
            Delete
          </button>
        ) : (
          <span />
        )}
        <button
          class="btn primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (p.role)
                await api(`/roles/${p.role.key}`, {
                  method: "PATCH",
                  body: { name, description, permissions: perms },
                });
              else
                await api("/roles", {
                  body: { key, name, description, permissions: perms },
                });
              p.onSaved();
            }, "Saved")
          }
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

// ── audit ──────────────────────────────────────────────────────────────────
interface AuditRow {
  id: string;
  actor_email: string | null;
  action: string;
  target: string | null;
  detail: unknown;
  created_at: string;
  ts: number;
}

export function Audit() {
  const [before, setBefore] = useState<number[]>([]);
  const cur = before[before.length - 1];
  const { data, error } = useLoad(
    () => api<ListResponse<AuditRow>>(`/audit${cur ? `?before=${cur}` : ""}`),
    [cur],
  );
  return (
    <Page
      title="Audit log"
      sub="Sign-ins and every change made in this dashboard."
    >
      {!data ? (
        <Loading error={error} />
      ) : !data.data.length ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        <>
          <table class="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Target</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((a) => (
                <tr key={a.id}>
                  <td class="nowrap muted">{fmtDate(a.created_at)}</td>
                  <td>{a.actor_email ?? "system"}</td>
                  <td>
                    <code>{a.action}</code>
                  </td>
                  <td class="trunc">{a.target}</td>
                  <td class="trunc muted">
                    {a.detail ? JSON.stringify(a.detail) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div class="pager">
            <button
              class="btn"
              disabled={!before.length}
              onClick={() => setBefore(before.slice(0, -1))}
            >
              ← Newer
            </button>
            <button
              class="btn"
              disabled={!data.has_more}
              onClick={() =>
                setBefore([...before, data.data[data.data.length - 1]!.ts])
              }
            >
              Older →
            </button>
          </div>
        </>
      )}
    </Page>
  );
}

// ── account ────────────────────────────────────────────────────────────────
export function Account() {
  const me = useMe();
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const { busy, run } = useAction();
  return (
    <Page title="Account" sub={me.user.email}>
      <div class="panel">
        <dl class="kv">
          <dt>Name</dt>
          <dd>{me.user.name}</dd>
          <dt>Role</dt>
          <dd>{me.user.role_name}</dd>
          <dt>Permissions</dt>
          <dd>{me.user.permissions.join(", ") || "none"}</dd>
        </dl>
      </div>
      <div class="panel narrow">
        <h3>Change password</h3>
        <input
          type="email"
          hidden
          autocomplete="username"
          value={me.user.email}
        />
        <Field label="Current password">
          <input
            type="password"
            autocomplete="current-password"
            value={current}
            onInput={onInput(setCurrent)}
          />
        </Field>
        <Field
          label="New password"
          hint="At least 10 characters. Other sessions are signed out."
        >
          <input
            type="password"
            autocomplete="new-password"
            value={pw}
            onInput={onInput(setPw)}
          />
        </Field>
        <button
          class="btn primary"
          disabled={busy}
          onClick={() =>
            run(
              () => api("/auth/password", { body: { current, password: pw } }),
              "Password changed",
            ).then(() => {
              setCurrent("");
              setPw("");
            })
          }
        >
          Change password
        </button>
      </div>
      <button
        class="btn"
        onClick={() =>
          api("/auth/logout", { body: {} }).finally(() => {
            location.hash = "#/";
            location.reload();
          })
        }
      >
        Sign out
      </button>
    </Page>
  );
}
