# Freddy's POS — full project, Build 45

Packaged 28 August 2026 against Supabase project `uyhbtubxmycofdyuajkn`.

## Layout

```
/                        the deploy tree — this is exactly what Vercel serves
vendor/                  supabase-js and SheetJS, served from our own origin
tests/                   headless jsdom harness — npm install && npm test
supabase/migrations/     all 34 migrations, in order
supabase/deploy-schema.sql   final-state schema for a fresh project
supabase/post-restore.sql    realtime + RLS guard, which pg_dump cannot emit
supabase/seed-menu.sql       the live menu, 11 categories and 80 dishes
supabase/SETUP.md            current setup and the order to rebuild in
supabase/replay-prelude.sql  the Supabase environment stub, for verification
supabase/config.toml     links the folder to the hosted project
supabase/seed-admin.sql  grants the first super_admin
.github/workflows/ci.yml asset and config checks
docs/                    README, DEPLOY, SECURITY, SNAPSHOT-WARNING
tools/                   apply_brand.py, check_assets.py
```

The root of this zip is the deploy tree. `freddys-deploy.zip` is the same
files with everything above stripped out — import that one to GitHub if the
repo should stay deploy-only, which is how it is set up today.

## What changed in Build 34–35

Three fixes from the code review, all applied to production already:

1. **Suspension applies to admins.** `is_approved()` and `is_admin()` now both
   require an approved staff row. Previously an admin row alone satisfied
   them, so suspending an admin changed the flag, said "suspended", and
   restricted nothing.
2. **A main admin can be stepped down.** New `admins_guard_last_super`
   trigger refuses any demotion or deletion leaving zero super admins, and
   the Staff page now offers the button when a second one exists.
3. **Dates are Manila, not UTC.** The sales range query sends `+08:00`, the
   table filters on `manilaDay()`, and `fmtDT`/`todayISO`/the export stamp are
   pinned to `Asia/Manila`. Bill numbers were already Manila, so the two
   disagreed for anything rung before 08:00.

Database side is migrations `20260827171748` and `20260827173508`. The second
came out of a review of the first: the guard raised SQLSTATE 23514, which
`fail()` in app.js routes into its check-constraint branch and rewrites as
"One of those values is outside what's allowed." The reason somebody actually
needed — that another main admin has to be promoted first — was the part being
discarded. It now raises 22023, which is in the `DELIBERATE` set and is what
`reset_sales_data()` already uses for the same shape of refusal. Client side is `BUILD = 34` with
matching `?v=34` on every script and stylesheet tag.

## Verification

All 34 migrations were replayed from empty into PostgreSQL 16 and the result
compared against production across ten dimensions:

| dimension | matches production |
|---|---|
| columns, constraints, indexes | yes |
| policies, triggers, RLS flags | yes |
| table grants, column grants, function grants | yes |
| function bodies | five of sixteen differ — see below |

`deploy-schema.sql` was then dumped from that replay and restored into a
third clean database; ten of the eleven digests came back identical. The
eleventh, the realtime publication, is absent by design — `pg_dump` does not
emit membership for a publication it did not create, so on a rebuild
20260822174233 and 20260828012940 must be applied separately or the sales page
will load correctly and quietly never refresh.

The function-body differences are cosmetic and fully accounted for:

- `clear_void_pin`, `set_void_pin`, `void_pin_status` — byte-identical once
  line endings are normalised. Production stores CRLF because those three were
  applied through the Supabase SQL editor.
- `approve_staff`, `delete_category` — two comment lines, known and
  long-standing.

## Things to know

**`20260824121500_freddys_void_pin.sql` is a reconstruction.** Its row in
`schema_migrations` was recorded with an empty `statements` array, so the
original text is gone. This file was rebuilt from the live catalogues and
verified by replay. It deliberately omits `void_sale_with_pin`, because the
version it originally created carried the `min(uuid)` fault that the very next
migration replaces.

**The `REVOKE ALL` block in `deploy-schema.sql` is load-bearing.** `pg_dump`
records grants it observed and cannot record revokes narrowing a default it
never saw granted. Restoring the grants without it was tested: `anon` ends up
able to `DELETE` from all eleven tables, `admin_pins` and `sales` included,
while RLS still reads as enabled and every policy is present.

**The event trigger is not in `deploy-schema.sql`.** Creating one needs
superuser, which a hosted project does not grant. Apply
`20260827031440_freddys_rls_auto_enable.sql` separately if you want the guard.

**`docs/` predates this build.** Those four files were last revised around
Build 14 and describe the old suspension and date behaviour. Treat them as
history until they are rewritten.

## Build 35 — from the full review

- **CSV export could carry spreadsheet formulas.** Quoting is a delimiter
  mechanism; Excel strips quotes before deciding what is a formula. `staff.name`
  comes from signup metadata and `login.html` is public, so the input was
  attacker-chosen. Values starting `= + - @` tab or CR now get Excel's
  treat-as-text apostrophe, with plain negative numbers excluded so `-500.00`
  still imports as a number.
- **`staff.name` was unbounded.** Now 1–80 characters, enforced by the
  `staff_name_len` constraint, truncated in `handle_new_user`, capped in both
  name inputs, with a readable message in `fail()`.
- **Realtime published more of `items` than anon may read.** The publication
  now names only the six granted columns.
- **`categories.id` was unescaped in two `<option value>` attributes.** It is a
  text primary key with no format constraint, and `authenticated` holds INSERT.
- **The reset confirmation understated the damage.** It read `db.sales.length`,
  capped at `SALES_PAGE`, so it could say "1000 bills" while thousands went.
  Now uses the server count.
- **`@supabase/supabase-js` pinned to 2.112.4** on all nine pages, which is what
  `@2` resolved to at packaging time.

## Build 36 — the last unread files

- **The signature nav treatment never rendered.** A "styled like the old
  buttons" block at the end of `freddys.css` re-declared `.nav a.nav-link
  :hover`, `.active` and `.active .tag` at equal specificity, so being later
  in the file it won — replacing the lit gradient with a flat rose fill and
  letting hover overwrite the active row. That block is layout only now.
- **Dead restore markup in `settings.html`.** A hidden `<input type="file"
  id="restoreFile">` nothing listens to, beside a button whose disabled state
  was applied by JS. With scripts blocked it rendered an enabled "Restore from
  JSON…" next to a file picker. The safe state is in the markup now.
- **Five foreign keys had no covering index.** `sale_lines.item_id` is the one
  that mattered: deleting a menu item is a button pressed during service and
  it scanned every bill line ever written.
- **Three RLS policies re-evaluated `auth.uid()` per row.** Wrapped in a scalar
  subquery so the planner hoists it. Access semantics re-tested unchanged.

## Build 37 — reviewing the previous round's own changes

- **`ALTER PUBLICATION ... SET TABLE` dropped `sales` from realtime.** SET TABLE
  replaces the publication's whole table list rather than editing one entry, so
  narrowing the column list on `items` in 20260828012940 silently took `sales`
  out with it. Every terminal stopped receiving bill events — the sales page
  still loaded and simply never updated itself again, with no error anywhere.
  20260828033601 puts it back; 20260828012940 is corrected in place to
  drop-then-add so a clean replay cannot reproduce it.
- **The publication is now an eleventh digest dimension.** The ten dimensions
  used until now would not have caught this, which is why it went unnoticed
  through a full verification round.
- **The nav base block still clobbered two properties.** The previous fix
  removed its `:hover` and `.active` rules but left `border-radius` and
  `transition`, which still beat the signature block's 9px and eased timing.

## Build 38 — closing out the outstanding list

- **Both CDNs are gone.** `supabase-js` 2.112.4 and SheetJS 0.18.5 are vendored
  into `vendor/` and served same-origin, so `script-src` is now `'self'` in all
  three host configs. This is a better answer than SRI: there is no third-party
  origin left to hash, nothing to re-pin on a CDN change, and the till no longer
  needs jsDelivr or cdnjs reachable to sign in or write a backup. It also takes
  SheetJS's unpatched parsing CVE off the table as a supply-chain concern — the
  file is fixed and inspectable, and nothing in the app parses workbooks.
  Cost: 1.1 MB in the repo, and library updates are now manual.
- **`reset_sales_data` requires super_admin.** It deletes every bill and there
  are no automatic backups; admin is a role handed out in two clicks. The
  button is disabled for non-super-admins rather than failing at the last step.
- **Custom discounts have a ceiling.** `settings.discount_max_pct`, enforced in
  `create_order()`, with a Settings control and a live warning on the ticket
  that holds the Charge button. Defaults to 100 — unchanged behaviour — because
  the right number is a decision about your promotions, not one to impose
  blind. Named senior/PWD and staff discounts are exempt.
- **`_headers` drifts closed.** The dead `/supabase/*` rule is gone and the
  manifest `Content-Type` matches `vercel.json`. All eight headers are now
  identical across both hosts.

## Build 39 — reviewing Build 38's own changes

- **`.vercelignore` now blocks what `netlify.toml` always did.** netlify.toml
  404s `/supabase/*`, `/*.sql` and `/*.md`, with a comment saying plainly that
  it is insurance for a repo updated by browser upload. `vercel.json` had no
  equivalent, and Vercel is the live host — it serves whatever is in the repo.
  Upload the full zip to the repo by mistake and `deploy-schema.sql` would have
  been readable at a guessable URL: every table, policy, grant and function
  body. Excluding at upload is stronger than a 404, so the exclusions went in
  `.vercelignore` rather than `vercel.json`.
- **`vendor/` is cached immutably** in all three host configs, ahead of the
  generic `/*.js` rule so it wins on first match. Without it the 1.1 MB of
  library revalidated on every page load.
- **Dropped `?v=` from the vendor URLs.** The version is already in the
  filename, so the query string would have re-downloaded 1.1 MB on every build
  bump and defeated the immutable caching.

Checked and found sound: `board.html`'s inline block is `application/ld+json`,
never executed, so `script-src 'self'` does not touch it. `applySession()` runs
before `bootPage()`, so `isSuperAdmin()` is populated when the reset button is
gated. `#chargeBtn` is the only path into a charge, so disabling it on an
over-ceiling discount genuinely blocks it — and the server refuses regardless.

## Build 40 — the Shop name field did nothing

`settings.name` was written by the Settings form and read back on save, and
consumed nowhere else in the application. The business name was hardcoded in
eight places, the receipt among them. So the Shop name field saved
successfully, reported success, and changed nothing — including the one
document whose own footer calls it the official bill.

The two happened to agree, so this would only have surfaced the day somebody
edited it. The receipt now prints `settings.name`, falling back to the original
two-line wording if it is ever blank. The sidebar and board wordmarks stay
hardcoded on purpose — those are a logo, not a business identification.

Every other settings column was checked the same way and all of them were
already wired: addr, phone, hours and footer reach the receipt, vat reaches
both the receipt and `create_order`, and the two confirm_charge fields drive
`needsConfirm()`.

## Build 41 — the preview and the charge could disagree by a centavo

`billPreview()` computed in binary floating point while `create_order()` uses
exact numeric. Postgres rounds half away from zero; JavaScript gives
0.35 * 0.1 = 0.034999999999999996, which rounds down. Across every subtotal
from PHP 0.01 to PHP 5,000.00 at both named discount rates, the two disagreed
on 818 of a million combinations — always by one centavo, always reading back
more than was charged. The confirmation modal shows the client's number and
the receipt prints the server's, so this was a real mismatch, not a display
nicety.

Not reachable today: all 80 menu items are priced in whole pesos, so subtotals
never land on a half-centavo boundary. Pricing one dish at PHP 32.15 would arm
it. `billPreview()` now counts in integer centavos throughout, which agrees
with Postgres on all million combinations rather than on 999,182 of them.

## Build 42 — a negative custom discount inflated the bill

Typing -50 into the custom discount showed a total of PHP 250.00 on a
PHP 200.00 subtotal. The confirmation modal reads back the client's figure, so
that is what the cashier says aloud and collects. create_order() clamps a
negative to zero, so the recorded bill is PHP 200.00 — and if the cashier
enters 250 as cash received, the server stores change_due = 50.00. The receipt
then prints "Change PHP 50.00" that nobody handed over. Customer short fifty
pesos, drawer over fifty pesos, and the receipt documents the gap.

The input carries min="0", but a number input only enforces that through form
validation and there is no form here — the identical trap the VAT field is
already clamped against a few hundred lines away. billPreview() now applies
Math.max(0, ...), mirroring the server's greatest(coalesce(x,0),0), and both
sides were re-tested across fourteen edge inputs including negatives,
exponents, blanks and half-centavo boundaries. All fourteen agree.

The change note is computed in centavos for the same reason: comparing floats
with >= is how a bill that is exactly covered reports itself short by PHP 0.00.

## Build 43 — the screen promised change on non-cash sales

`#payMode` had no change handler at all; it was only read at charge time. So
the cash box stayed visible and populated after switching to GCash or Card, and
the change note kept computing from it. Type PHP 500 against a PHP 450 bill,
switch to GCash, and the screen still read "Change PHP 50.00" — while
create_order() ignores p_cash for non-cash modes, storing cash = total and
change_due = 0. The receipt shows no change line and the books record none.
Change handed over that nobody owed.

The mode now drives the field: hidden and cleared for GCash and Card, synced
once at wire time because browsers restore a select's value across a soft
reload without firing change. Negative cash is clamped to zero, matching the
server's reading of a non-positive p_cash as "not provided, so exact payment".
Screen and server were then compared across eight mode/cash combinations and
agree on every one.

This completes the paired-rule audit. Discounts, change and the cash-short
boundary are all differentially tested against the server; VAT needed no work,
as the client only ever prints the stored `vatable` and `vat` and never
recomputes them.

## Build 43 addendum 2 — every fix in this session now has a test

`tests/fixes.js` is a regression suite covering the specific faults fixed in
August 2026, several of which had been verified only by reading, by isolated
arithmetic, or by SQL replay and had never executed inside the application:

  * the Manila date boundary — `manilaDay()` places a 17:30Z bill on the next
    Manila day, the range query carries `+08:00`, and an 01:30 Manila bill
    survives the filter for its own Manila date
  * the CSV formula-injection guard — a staff member named
    `=HYPERLINK("http://evil","click")` comes out of the real fallback path
    with the leading apostrophe, while ordinary names are untouched
  * the custom discount ceiling — at the limit Charge stays live, one centavo
    over it goes dead and the note names both the percentage and the peso
    amount, and coming back under re-enables it
  * the pending screen — an unapproved account gets it and the till is not
    rendered behind it
  * the Staff page — a suspended admin reads as waiting rather than approved

All fourteen assertions pass. `npm test` runs all three suites and was checked
from inside the packaged zip, not just the working copy.

## Build 43 addendum — the client has now actually run

Everything up to here was verified by reading, by `node --check`, and by
replaying migrations into a scratch PostgreSQL. None of it executed the till.
`tests/` closes that: it boots the real `index.html` and `app.js` in jsdom
against a stubbed Supabase and drives a sale end to end.

Results on this build: all nine pages boot clean, with every enabled
non-destructive control clicked and every field fired — no runtime errors. One
complete sale runs from empty cart through the confirmation modal to a printed
receipt. The recent fixes verify in a real DOM rather than on paper: GCash
clears and hides the cash box and shows no change note, a negative custom
discount leaves the total equal to the subtotal, and the receipt prints the
configured shop name. It also confirms the client sends only `{item_id, qty}`
and no prices.

No application defects were found by any of this — which is worth stating
plainly, because it is the first evidence in this project that the client runs
at all. Two faults did turn up in the harness itself, both instructive: `eval`
never puts a top-level `const` into global scope, so `sb` was invisible until
the scripts were injected as real `<script>` elements; and jsdom re-serialises
`innerHTML` on read, so an assertion written against either the raw or the
escaped form of a string fails on the mixture.

It does not replace a browser. Auth, RLS and every SECURITY DEFINER function
are stubbed, so it says nothing about whether the server would accept a call,
and jsdom has no renderer so layout and print output are untested.

## Build 44 — a live menu edit did not reach an open bill

The realtime handler for `items` updated `db.items` and re-rendered the menu
grid, but never touched `cart`. Cart lines hold a price snapshot taken when the
dish was tapped, so an admin raising Grilled Bangus from PHP 320 to PHP 350 on
the Menu page left an open bill still showing PHP 320 — while `create_order()`
recomputes from `items.price` and would charge PHP 350. The cashier reads back
PHP 320, the customer pays PHP 320, the books record PHP 350, and the drawer is
short with nothing on the receipt to explain it.

A dish deactivated or deleted mid-bill was worse: the ticket looked entirely
normal and `create_order()` refused the whole charge with "X is off the menu",
which is not something the cashier can act on with the dish sitting there on
screen.

`reconcileCart()` now follows the menu — repricing or removing the affected
line, invalidating the in-flight charge reference, and saying what happened.
Silently repricing a bill somebody is reading aloud would be its own kind of
wrong, so both cases raise a toast naming the dish and the old and new price.

The double-tap guard was tested at the same time and already held: three rapid
taps on Charge produced exactly one `create_order` call.

`tests/races.js` covers all of it.

## Build 45 — a policy change never reached an open terminal

`settings` is not in the realtime publication and `loadCore()` only runs at
boot, so `db.settings` on a terminal that has been open all day is whatever it
was at sign-in. The figure that matters is `discount_max_pct`: set a 15%
ceiling from the Settings page, and a till still holding the old value shows no
warning, leaves Charge live, and hands the cashier a refusal from the server
for a rule the screen never mentioned — the same unactionable refusal as a dish
taken off the menu.

The obvious fix is wrong. `settings_public_read` grants anon SELECT with
USING true, realtime filters rows by RLS but not by column grants, and a
publication's column list is shared across every subscribing role. Adding
`settings` to the publication so the till could see `discount_max_pct` would
also hand it, the VAT rate and the read-back thresholds to anyone holding the
anon key, which is public in `supabase-config.js`. That is the items column-list
mechanism from 20260828012940 running the other way.

So the till asks instead, on `visibilitychange` — tab switch, app switch, screen
wake. One small query, on the only figure on that page the server can refuse a
charge over, and no exposure.

## Build 45 addendum — the retry logic now has evidence

`tests/errors.js`. The `client_ref` mechanism is the most safety-critical code
in the till and had never been exercised. Fourteen assertions, all passing:

  * a dropped connection keeps the bill on screen and says the outcome is
    unknown — it does NOT say "nothing was charged", because that is the
    sentence that gets the same meal charged twice
  * the retry after a drop carries the SAME client_ref, so a bill that did
    commit comes back rather than being written again
  * an answered refusal (a real SQLSTATE) keeps the bill, shows the reason the
    database gave, and the next attempt uses a FRESH reference — reusing it
    would return the refused attempt forever
  * editing the cart retires the reference, so a retry cannot return the
    earlier, smaller bill
  * a rejected void PIN is reported with attempts remaining, and the bill stays
    paid — no `.pill-void` badge, Void still offered

No application defect was found. That is the result: the idempotency logic
behaves as its comments claim, under test rather than on inspection.

## Final schema set

`deploy-schema.sql` regenerated and re-headed. It is now anchored to migration
`20260828052933` rather than to a client build number, because the two move
independently — Builds 39 to 45 changed no SQL, and a file headed "as of Build
38" beside a Build 45 zip reads as stale when it is describing a different
thing.

Two companion files close the gap that header has been warning about:

  * **`post-restore.sql`** carries what `pg_dump` cannot emit — realtime
    publication membership and the `ensure_rls` event trigger. It uses ADD
    TABLE rather than SET TABLE, and prints what actually landed so a silent
    miss is visible. Without it a restored project loads correct data and
    never refreshes, with no error anywhere.
  * **`seed-menu.sql`** is the live menu, dumped from the database rather than
    taken from the seed migration. Those had drifted — the migration produces
    a different menu with two fewer dishes off-menu and several stale prices.

Verified by cold rebuild into an empty PostgreSQL: schema, then post-restore,
then seed. All eleven schema dimensions match production, and the resulting
menu hashes identically to it (`3c34640e`).

`SETUP.md` documents the live project as it stands — counts, rebuild order,
the dashboard settings no migration can reach, and the traps worth knowing
before changing anything.

## Still open

- **Leaked-password protection is disabled in Supabase Auth.** Dashboard only —
  Authentication → Providers → Email. Not reachable through the MCP tools.
- **`docs/` predates all of this.** Those four files still describe Build 14
  behaviour.
- **No database backups.** The free tier takes none, and this zip remains the
  only copy of the schema outside the live project.
- **SheetJS 0.18.5** is still the version, now self-hosted. Its parsing CVE
  stays unreachable while nothing imports workbooks — worth remembering if an
  import is ever added.

## Updating a vendored library

Both files came from the npm tarball, not a CDN, and are the exact bundles
jsDelivr would have served (`jsdelivr` field: `dist/umd/supabase.js` and
`dist/xlsx.full.min.js`). To move to a newer supabase-js:

    curl -sL https://registry.npmjs.org/@supabase/supabase-js/-/supabase-js-<ver>.tgz \
      | tar xzO package/dist/umd/supabase.js > vendor/supabase-js-<ver>.js

then update the nine `<script src>` tags. Check the bundle still defines the
`supabase` global before shipping — that is the one thing that would break
every page at once.
