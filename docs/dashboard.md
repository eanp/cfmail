# Dashboard and webmail

The dashboard lives at `https://<your-host>/app/`. It is one page app with two
halves: **Mail** for everyone who handles email, and the developer/admin pages
for whoever runs the platform. What each person sees depends on their role.

## Pages

| Page      | Permission         | What it does                                                                              |
| --------- | ------------------ | ----------------------------------------------------------------------------------------- |
| Mail      | `mail:use`         | Webmail for the mailboxes the user is a member of                                         |
| Overview  | signed in          | Configuration and send mode; counters and a 14-day chart with `emails:view`               |
| Emails    | `emails:view`      | Every sent and received email, with status, preview, plain text, raw JSON and attachments |
| Send test | `emails:send`      | Send a test message from any allowed domain                                               |
| Domains   | `domains:view`     | Sending and receiving domains, with mailbox counts                                        |
| API keys  | `api_keys:manage`  | Create (`full_access` / `sending_access`) and revoke keys                                 |
| Webhooks  | `webhooks:manage`  | Endpoints, events, enable/disable, signing secret, delivery log, retry                    |
| Mailboxes | `mailboxes:manage` | Create mailboxes, display name, signature, members, and who can send                      |
| Users     | `users:view`       | List users. With `users:manage`: invite, change role, disable, reset link, sign out       |
| Roles     | `roles:manage`     | Create roles and choose their permissions                                                 |
| Audit log | `audit:view`       | Sign-ins and every change made in the dashboard                                           |
| Account   | signed in          | Own details, change password, sign out                                                    |

## Roles and permissions (RBAC)

A user has exactly one role, and a role is a set of permissions:

| Permission         | Allows                                        |
| ------------------ | --------------------------------------------- |
| `emails:view`      | View every sent and received email (logs)     |
| `emails:send`      | Send test emails from the dashboard           |
| `domains:view`     | View sending/receiving domains                |
| `api_keys:manage`  | Create and revoke API keys                    |
| `webhooks:manage`  | Create, change and replay webhooks            |
| `mail:use`         | Use the mailboxes assigned to them            |
| `mailboxes:manage` | Create mailboxes and choose their members     |
| `users:view`       | View users                                    |
| `users:manage`     | Invite, disable and reset users, change roles |
| `roles:manage`     | Create and change roles and their permissions |
| `audit:view`       | View the audit log                            |

Built-in roles:

| Role        | Permissions                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `admin`     | Everything, always, including permissions added in future versions                             |
| `developer` | `emails:view`, `emails:send`, `domains:view`, `api_keys:manage`, `webhooks:manage`, `mail:use` |
| `member`    | `mail:use`                                                                                     |

Built-in roles cannot be deleted, and the `admin` role cannot be edited. Change
the other two, or add your own (e.g. `support` = `mail:use` + `emails:view`).

Rules that prevent privilege escalation, enforced on the server:

- You can only grant permissions you hold yourself, whether in a role or by
  assigning a role.
- You cannot change your own role, edit the role you have, or disable yourself.
- To change, disable, reset or sign out another user, you must hold every
  permission their role has. A developer can therefore never reset an admin.
- At least one active admin always remains.
- Changing a user's role, or disabling them, ends all of their sessions.

Every route declares the permission it needs, and there is no default allow.
Menus in the UI only hide things; the server decides.

## Sign-in, invites, password resets

- **Passwords:** PBKDF2-SHA256 with 100,000 iterations, at least 10 characters.
  Common passwords, and passwords containing the email name, are rejected.
- **Lockout:** after 10 failed sign-ins for the same email within 15 minutes,
  sign-in is blocked for that email until the window passes.
- **Sessions:** 7 days maximum, ending after 12 hours of inactivity. They are
  revoked immediately on a password change, role change or disable.
- **Invites:** an admin invites a user, and a one-time link valid for 7 days
  lets them set a password. The link is emailed when `SYSTEM_FROM` is set; it is
  always shown to the admin too.
- **Password reset:** an admin creates a link valid for 1 hour (**Users → Reset
  password**). With `SYSTEM_FROM` set, users can also use **Forgot password?**
  on the sign-in page, which sends at most one email per 10 minutes and gives
  the same answer whether or not the account exists.
- **Lost admin:** run `scripts/create-admin.mjs` again (see
  [setup.md](setup.md#3-first-admin-and-first-api-key)).

## Webmail

### Mailboxes

A mailbox is an address (`sales@example.com`) or a catch-all (`*@example.com`).
Incoming mail is filed by its **envelope recipient**:

- An exact mailbox wins over the catch-all.
- Each mailbox keeps its own folder, read and star state.
- Mail with no matching mailbox is still stored and shown under **Emails →
  Received**. It is not lost.

Members are chosen per mailbox. **can send** off means read-only. Being an admin
does not make you a member: add yourself if you need access, and the audit log
records it.

A catch-all mailbox can send as any address on its domain. When replying, the
From address defaults to the address the original message was sent to.

### Features

- Folders: Inbox, Starred, Sent, Archive, Spam, Trash. Trash remembers where a
  message came from, so **Restore** puts it back.
- Spam: a message is filed to Spam when DMARC fails, or when SPF and DKIM both
  fail. A banner warns about failed authentication.
- Conversations: grouped by `In-Reply-To` / `References`. Your replies join the
  same conversation, and so do the customer's answers.
- Search: subject, sender, recipients and preview text.
- Compose, reply, reply all, forward (the original attachments are included),
  attachments up to 10 MB, and a per-mailbox signature.
- Bulk actions: archive, trash, restore, delete forever, read/unread.
- The list refreshes every minute while the tab is visible.

### Safe HTML rendering

Message bodies open in a sandboxed iframe with their own Content Security
Policy:

- No scripts, no forms and no same-origin access.
- Links open in a new tab.
- **Remote images are blocked** until you click **Show images**, so tracking
  pixels do not fire.
- Inline (`cid:`) images are served through short-lived signed links.

### Limits

- Each user can send 300 emails per day from webmail; this protects the domain's
  sending reputation.
- Compose is plain text. The HTML part is generated from it.
- Deleting forever only removes the message from the webmail. The underlying
  email remains in the API and logs until it is deleted there with
  `DELETE /emails/receiving/:id`.
