# Deploying

No build step. It's static files plus a hosted database, so "deploy" means
copying the folder somewhere and pointing a domain at it. Pick one host.

Every config here sets the same security headers, including a Content
Security Policy that allows exactly three outside origins:

| Origin | Why |
|---|---|
| `cdnjs.cloudflare.com` | SheetJS, for the Excel backups |
| `cdn.jsdelivr.net` | the Supabase JS client |
| `fonts.googleapis.com` / `fonts.gstatic.com` | Zilla Slab, Karla, IBM Plex Mono |

plus `https://` and `wss://` to your Supabase project — the `wss://` is what
makes realtime work, and leaving it out breaks live order updates while
everything else keeps running. `script-src` forbids inline JavaScript
entirely; the app has none.

---

## Netlify

```bash
npx netlify-cli deploy --prod
```

Or connect the Git repo — `netlify.toml` sets publish directory, headers, and
a 404 on `/supabase/*` so the SQL isn't served. Build command is empty.

## Vercel + GitHub (recommended)

Push the repo to GitHub, then in Vercel: **Add New → Project → Import** it.

| Setting | Value |
|---|---|
| Framework Preset | **Other** |
| Root Directory | `./` |
| Build Command | *leave empty* |
| Output Directory | *leave empty* |
| Install Command | *leave empty* |

Deploy. From then on every push to `main` ships automatically and every pull
request gets its own preview URL. Nothing needs configuring in the dashboard —
`vercel.json` carries the headers, and `.vercelignore` keeps `supabase/`,
`.github/` and the markdown out of what actually gets served.

Two settings in `vercel.json` are deliberate and worth not "tidying up":

- **`cleanUrls: false`.** Every link in the app points at a real filename. With
  clean URLs on, Vercel answers each one with a 308 redirect to the
  extensionless form, so every nav click pays an extra round trip and the
  prefetch hints warm a URL the browser is then redirected away from.
- **`Cache-Control: max-age=0, must-revalidate`.** The files are small and a
  304 carries no body, so this costs one round trip and guarantees a deploy is
  live the moment it finishes. Combined with the `?v=` stamps and the build
  number in the console, a stale file stops being a possible explanation.

If you are on Vercel you do not need `.github/workflows/deploy.yml` — that one
publishes to GitHub Pages. Leaving it in place is harmless but means both
hosts deploy on every push; delete it if you want a single source of truth.

One-off deploy without GitHub:

```bash
npx vercel --prod
```

## Cloudflare Pages

Connect the repo, leave the build command empty, set the output directory to
`/`. Cloudflare reads `_headers` directly.

## GitHub Pages

Push to `main`. `.github/workflows/deploy.yml` runs on its own — enable Pages
under Settings → Pages → Source: **GitHub Actions** first.

One caveat: **Pages cannot set custom headers**, so the CSP does not apply
there. The app still works and the database is still protected by RLS, but
you lose the defence-in-depth the other three hosts give you. If this is
going to run a real till, use one of the other three.

The workflow drops `supabase/`, `.github/` and the markdown from the uploaded
artifact, since Pages otherwise serves every file in the repo.

---

## Database migrations

The sixteen migrations in `supabase/migrations/` are **already applied** to
`uyhbtubxmycofdyuajkn`. You only need this section for a fresh project or a
rebuild.

```bash
npm i -g supabase
supabase login
supabase link --project-ref uyhbtubxmycofdyuajkn
supabase db push
```

They are ordered and idempotent (`create table if not exists`, `drop policy
if exists` before each `create policy`, `on conflict do nothing`), so
re-running `db push` against the live project is safe — it will simply
report nothing to apply.

A worked example of why that rule matters, from this project's own history:
`freddys_drop_stock_and_void_audit` was applied through the SQL editor rather
than `db push`, so it changed the database but never got a row in
`schema_migrations`. Its filename also carried a later timestamp than the
approval-gate migrations that came after it in real life. Both together were a
trap: the next `db push` would have re-run it, and its copy of
`create_order()` — written before approvals existed — would have quietly
overwritten the version that checks `is_approved()`, reopening the hole. The
file is now dated `20260823040000` so it sorts before the approval work, and
the missing row has been written. Filenames and `schema_migrations` match
exactly; `supabase migration list` shows no drift.

One rule if you ever rename a migration file: the timestamp prefix is the
only thing `db push` matches against the `schema_migrations` table. Change
it on a file that is already applied and push will treat it as brand new
and try to run it a second time. If the prefixes and the table ever drift
apart, `supabase migration list` shows the mismatch and `supabase migration
repair --status applied <version>` fixes the record.

After a fresh push, run `supabase/seed-admin.sql` once to grant yourself
admin. Nothing else creates the first admin, by design.

---

## Pointing at a different project

Three places, and all three must match:

1. `supabase-config.js` — `SUPABASE_URL` and `SUPABASE_ANON_KEY`
2. `supabase/config.toml` — `project_id`
3. the `connect-src` origins in `netlify.toml`, `vercel.json` and `_headers`

Miss the third and the app loads, then silently fails every request. If
things break right after a project switch, check the browser console for CSP
violations before anything else.

---

## Before the first real service

- [ ] Email auth on, "Confirm email" off
- [ ] Your account created, `seed-admin.sql` run, all six panels visible
- [ ] The four handwritten prices verified against the physical menu
      (see README)
- [ ] A test bill charged, printed, then voided — confirms the printer
      layout, that the void asks for an admin password, and that the bill
      drops back out of Inventory
- [ ] One cashier shown the void flow: they can start it, an admin types
      their own email and password to approve, and the admin's name is what
      appears on the voided bill
- [ ] One Excel backup downloaded, so staff have seen the flow before
      they need it
- [ ] Cashier account created and checked: no Menu, Staff or Settings in
      the nav

---

## If something goes wrong

**Nothing loads, console shows CSP errors.** A `connect-src` origin doesn't
match your project ref. Fix all three config files.

**Everything says "Out of stock" and every dish is struck through.** The SQL
half of an update landed and the JavaScript half did not. The old `app.js`
reads `items.stock`, that column no longer exists, so `undefined` becomes `0`
and every dish looks sold out. Open the browser console: if it does not print
`Freddy's POS — build 7`, you are running an old file, and a hard refresh
will not help — nothing is wrong with the cache.

Every page loads `app.js`, `freddys.css` and `supabase-config.js` from its own
folder, so all four sit side by side in the web root. They used to load from
an `assets/` subfolder, which made "which copy is live?" a real question every
time; the flat layout removes it. If an old `assets/` folder is still in the
repository, delete it — nothing points at it any more. Fetch `/app.js`
directly in a tab and search it for "Out of stock" to confirm what the host is
actually serving.

Every page carries `?v=N` on its script and stylesheet tags. Bump that number
and the `BUILD` constant at the top of `app.js` together whenever you change
either file, and a stale cache stops being a possible explanation at all.

**Any error toast that just says "that didn't go through".** Open the console:
the full error object is always logged there, even when the toast is generic.
From build 10 the toast shows the real message whenever the database raised
one deliberately, so a generic toast now means a genuine plumbing failure
(network, connection) rather than a hidden explanation.

**A write works in the SQL editor but returns 400 through the app.** Look for
`DELETE requires a WHERE clause` (or the UPDATE equivalent) in Logs → Postgres.
Supabase preloads `pg_safeupdate` for the API roles, so any DELETE or UPDATE
without a WHERE is refused over PostgREST. It is loaded per session at connect
time, so a dashboard or CLI session running as `postgres` never sees it — the
same function passes every test there and still fails from the browser, and
SECURITY DEFINER makes no difference because the setting belongs to the
session, not the function owner. Add `where true` to say "yes, all rows, on
purpose". This cost an afternoon once already.

**Reset says the function could not be found.** The deployed `app.js` is older
than the database. Reset used to take three arguments, the third being a
zero-the-stock flag; that column no longer exists, so the function takes two.
An old front end calls it with three and PostgREST cannot match a signature.
Deploy the current build.

**A new hire signs in and only sees "waiting for approval".** Correct. Open
Staff as an admin and press Approve on their row; they press Check again and
they are in. Nobody can approve their own account, so the very first admin on
a fresh project still comes from `supabase/seed-admin.sql`.

**A panel shows old numbers for a second, then corrects itself.** Working as
intended. Each tab keeps the last known menu, role and totals in
sessionStorage and paints from them instantly, then revalidates against
Postgres and repaints. Signing out clears it; closing the tab clears it. If
you ever need a guaranteed-cold read, open a new tab.

**Sign-in works, every panel is empty.** RLS is doing its job but the account
has no rows it's allowed to read — usually means migrations didn't apply.
Check `supabase db push` output.

**Panels missing after signing in as the owner.** `seed-admin.sql` hasn't run,
or it ran against a different email. Sign out and back in after running it;
the role is read at sign-in.

**Inventory doesn't update live on a second terminal.** Two causes, check both.
First, `wss://` missing from `connect-src` — everything else keeps working,
so this is easy to miss. Second, `items` and `sales` not in the
`supabase_realtime` publication: a channel with no publication behind it
subscribes successfully and then silently never fires. Confirm with

```sql
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
```

It should list `items` and `sales`. If it is empty, migration
`20260822174233_freddys_enable_realtime.sql` has not been applied.

**Restoring data.** Dashboard → Database → Backups. Do not restore from a
browser JSON export on a shared database — that's why the button is disabled.
