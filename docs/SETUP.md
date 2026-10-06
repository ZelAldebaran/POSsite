# Supabase setup — Freddy's POS

Project `uyhbtubxmycofdyuajkn`, PostgreSQL 17.6. Written from the live project,
not from memory, as of migration `20260828232805`.

## What is in there now

| | |
|---|---|
| migrations applied | 35 |
| tables | 10, all with RLS enabled |
| views | 1 (`item_order_totals`, `security_invoker=on`) |
| functions | 16 |
| RLS policies | 16 |
| triggers | 2 |
| indexes | 24 |
| menu | 11 categories, 80 items |
| staff | 3 |
| sales | 0 |

## Rebuilding from nothing

Order matters. Steps 2 and 3 are the whole reason this file exists — a project
restored from `deploy-schema.sql` alone comes up looking entirely correct.

1. **Create the project.** Note the new project ref; it goes in
   `supabase-config.js` and in the CSP `connect-src` in `vercel.json`,
   `_headers` and `netlify.toml`. Four places, and the app silently cannot
   reach its own database if any one is missed.

2. **`supabase/deploy-schema.sql`** — SQL editor, paste, run. This is the whole
   `public` schema: tables, constraints, indexes, policies, functions,
   triggers, and the grants. It opens with a `REVOKE ALL` block that is
   load-bearing; the header explains why at length and it must not be removed.

3. **`supabase/post-restore.sql`** — the two things `pg_dump` cannot emit:
   realtime publication membership, and the `ensure_rls` event trigger. It
   prints what landed. If it reports `realtime publishes: NOTHING`, stop —
   the sales page will load correctly and never refresh, which is not
   something you will notice until a second terminal is silently stale all
   evening.

4. **`supabase/seed-menu.sql`** — the menu. `deploy-schema.sql` is schema
   only, so a project restored without this has no dishes at all.

   Note this is dumped from the live database, not from the seed migration
   `20260822105148`. Those two have drifted: prices have moved, dishes have
   been added, and two more are off the menu than the migration knows about.
   The migration is history; this file is what the restaurant sells. Verified
   by cold rebuild — the resulting menu hashes identically to production.

   Not idempotent for items: `items.id` is a generated uuid, so running it
   twice gives you every dish twice. Check `select count(*) from items;`
   first. Categories upsert by id and are safe to re-run.

5. **`supabase/seed-admin.sql`** — edit the email first. Create the account
   through the app, then run this to make it `super_admin`. There is
   deliberately no in-app path to the first admin.

6. **Dashboard settings** (below). None can be set from SQL.

## Dashboard settings

These live outside the schema and no migration can reach them.

- **Authentication → Providers → Email → Confirm email: OFF.** A counter
  terminal should let staff sign in the moment they sign up; approval is the
  gate, not email. This matches `enable_confirmations = false` in
  `supabase/config.toml`.
- **Authentication → Providers → Email → Leaked password protection.**
  Currently **off**, and the one advisory finding still open on this project.
  Turning it on is a single toggle and costs nothing.
- **Project → Database → Backups.** The free tier takes none. The full project
  zip is the only copy of this schema outside the live database, which is why
  it belongs somewhere durable rather than in a downloads folder.

## Things worth knowing before changing anything

**`REVOKE ALL` in `deploy-schema.sql` is not tidying.** Supabase ships
`alter default privileges in schema public grant all on tables to anon,
authenticated`. `pg_dump` records the grants it observed and cannot record a
revoke narrowing a default it never saw granted. Restore the grants without
the revokes and `anon` can `DELETE` from all ten tables — `admin_pins` and
`sales` included — while RLS still reads as enabled and every policy is
present. This was tested, not assumed.

**Realtime does not honour column grants.** It filters rows by RLS and sends
whole published rows. `items` therefore carries an explicit six-column list,
because `board.html` subscribes as `anon` and the public menu lockdown would
otherwise be bypassed. For the same reason `settings` is **not** published at
all: `settings_public_read` grants `anon` SELECT with `USING true`, so
publishing it would hand `discount_max_pct`, the VAT rate and the read-back
thresholds to anyone holding the anon key, which is public in
`supabase-config.js`. The till re-reads settings on `visibilitychange` instead.

**`ALTER PUBLICATION ... SET TABLE` replaces the entire table list.** Use
`ADD TABLE`. This is not hypothetical: narrowing the column list on `items`
with `SET TABLE` once dropped `sales` out of realtime, and nothing anywhere
reported it.

**`apply_migration` assigns its own timestamp**, not the one in your filename.
Rename the repo file to match what lands in `schema_migrations`, or
`supabase db push` treats it as pending forever.

**Three function bodies hold CRLF** — `set_void_pin`, `clear_void_pin`,
`void_pin_status` — because they were applied through the SQL editor. They are
byte-identical to the repo once line endings are normalised. `approve_staff`
and `delete_category` differ by two comment lines. Five of sixteen bodies, no
behavioural difference, and worth knowing before you go hunting for drift.

## The security model in one paragraph

The anon key is public and is meant to be. What protects the data is RLS plus
`SECURITY DEFINER` functions. `anon` can read the public menu (six columns of
`items`, three of `categories`, five of `settings`) and nothing else.
`authenticated` gets nothing useful until an admin approves the staff row —
`is_approved()` requires it, and holding an admin row is not a substitute.
Prices are never trusted from the client: `create_order()` recomputes every
figure from `items.price`, and the till sends only `{item_id, qty}`. Voids
need an admin's six-digit PIN, bcrypt-hashed in `admin_pins`, which no role can
read. `reset_sales_data()` needs an approved admin — it was briefly narrowed to
`super_admin` and opened again at the owner's request, so any admin can clear
the sales log and there are no automatic backups. Role changes remain
`super_admin` only, and the guard trigger refuses any change that would leave
the project with no super admin at all.

## Verifying a rebuild

`supabase/replay-prelude.sql` stubs what a hosted project provides — the auth
schema, the three roles, pgcrypto in `extensions`, the Supabase default
privileges — so the migrations can be replayed into a bare PostgreSQL and the
result compared against production. `tests/` in the project root does the same
for the client. Between them, a rebuild can be checked before it takes a bill.
