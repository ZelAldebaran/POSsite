# Freddy's Seafood Grill & Restaurant — Point of Sale

## Deploy this to Vercel

Everything is already configured. There is nothing to build and no environment
variable to set — the Supabase URL and publishable key live in
`supabase-config.js`, which is meant to be public.

**1. Push to GitHub**

```bash
cd freddys-pos
git init
git add .
git commit -m "Freddy's POS"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/freddys-pos.git
git push -u origin main
```

**2. Import on Vercel** — Add New → Project → pick the repo, then:

| Setting | Value |
|---|---|
| Framework Preset | **Other** |
| Root Directory | `./` |
| Build Command | *empty* |
| Output Directory | *empty* |
| Install Command | *empty* |

Press Deploy. Every push to `main` ships from then on, and every pull request
gets its own preview URL.

**3. Check it landed.** Open the site, then DevTools → Console. It prints
`Freddy's POS — build 14 (futuristic theme)`. If the number is lower or the
line is missing, the browser has an older file — that one line has saved a lot
of guessing on this project.

**4. Point Supabase at the new domain.** In the Supabase dashboard,
Authentication → URL Configuration, add the Vercel URL to *Site URL* and
*Redirect URLs*. Password resets go to whatever is set there.

The database needs nothing: all 16 migrations in `supabase/migrations/` are
already applied to project `uyhbtubxmycofdyuajkn`, and `supabase db push` will
report nothing to do.

Two settings in `vercel.json` are deliberate — `cleanUrls: false` (every link
points at a real filename, and clean URLs would add a 308 redirect to every
navigation) and `Cache-Control: must-revalidate` (so a deploy is live the
moment it finishes). `.vercelignore` keeps `supabase/`, the markdown and the
other hosts' configs out of what actually gets served.

There is no GitHub Pages workflow in this repo. It was removed so only one
pipeline deploys on push. `netlify.toml` and `_headers` are left in place —
they are inert unless you connect those hosts, and they keep the project
portable.

---


Counter terminal for a single restaurant: take orders, print bills, keep an
honest record of what went out. Static front end, Supabase (Postgres) behind
it. There is no stock count — a kitchen cooking to order cannot keep one
accurate, and a wrong one refuses real sales — so Inventory reports the
quantity **ordered** instead, read straight back out of the bills.

A dish has exactly two states. **On the menu means available, always**: it can
be ordered any number of times and nothing counts down. Anything added in the
Menu manager goes on available — there is no availability question on the add
form, because there is no third answer. When the kitchen runs out for the day,
an admin uses **Take off** on the dish's card and **Put back** the next
morning. `create_order()` enforces that and nothing else: an off-menu item is
refused, an on-menu one never is.

**The Menu manager is the order screen with the prices unlocked.** Both pages
are drawn by the same `buildCatBar` / `menuSections` / `itemCardFace`
functions, so the categories, their order, the cards and the wording are the
same on both. The only difference is what a card does: tap to add on the till,
Edit / Take off / Delete in the manager. Editing a dish never touches whether
it is on the menu — only those buttons do — so fixing a typo in a price cannot
quietly pull it from service.

Sitio Yakal, Cabanbanan, Pagsanjan, Laguna · Tuesday–Sunday, 10:00am–9:00pm

---

## Branding

The logo and the site icon live at the repo root like everything else.

```
Freddys.png        Full lockup. Login card and the public menu board.
site-icon.png      Grill mark alone. Sidebar, and every app icon below.
icon-16/32/48.png  Browser tab. Flame and grate only — the full stack,
                   with the waves, is unreadable at that size.
icon-180.png       iOS home screen.
icon-192/512.png   Android and PWA install, via site.webmanifest.
favicon.ico        16/32/48 in one file. Browsers request this by name
                   whether or not a page links to it.
og-freddys.jpg     1200x630 card for link previews.
```

Both source images were supplied as JPEGs with the transparency checkerboard
baked in as real pixels. They were matted by finding the regions that are
two-toned and flat — which the checker is and the artwork is not — so the fish
belly, the wave crests, the counters of the two D's and the gaps in the grate
all came out right.

`og:image` is a relative path. Most link scrapers want an absolute one, so
once the domain is settled:

```bash
sed -i 's|content="og-freddys.jpg"|content="https://YOURDOMAIN/og-freddys.jpg"|g' *.html
```

Anything that changes `freddys.css` needs the `?v=` number bumped in every
page, or tills with the old stylesheet cached will render the old layout.
Currently `v=16`.


## What's in here

```
login.html              Sign in / create an account.
index.html              New order (the till).
inventory.html          Quantity ordered, per dish.
sales.html              Every bill, filterable, reprintable.
menu.html               Menu manager — same layout as the till. admin
staff.html              Who can sign in.         admin
settings.html           Details, backups, reset. admin
account.html            Your own name + password.
board.html              PUBLIC menu for diners. No login.
                        Reachable from the sidebar as "View menu".

freddys.css             One stylesheet, shared by every page.
app.js                  One script, shared by every page. Binds only
                        what the current page actually contains.
supabase-config.js      Project URL + publishable key. Safe to be public.

supabase/
  config.toml           Links this folder to the hosted project.
  migrations/           The ten migrations, in order. Already applied.
  seed-admin.sql        One-time bootstrap for the first admin.

vercel.json             Vercel: headers, no clean-URL redirects.
.vercelignore           Keeps supabase/ and the docs out of the deploy.
netlify.toml            Netlify: headers + a 404 on /supabase/*.
_headers                Cloudflare Pages reads this directly.
.github/workflows/      GitHub Pages. Not needed if you deploy on Vercel.
```

Everything the browser loads sits in the web root, side by side. There used
to be an `assets/` subfolder; it was removed because "which copy is live?"
turned out to be a question worth never having to ask again. Each page loads
`app.js` and `freddys.css` from its own folder, stamped `?v=N`, and `app.js`
prints its build number to the console on start.

Each page is its own file, but
the CSS and JS are shared rather than copied into every file. `app.js`
reads `document.body.dataset.page` and wires only the controls that exist,
so adding a page means adding markup, not another copy of the logic.


---

## First run

Three steps, once.

**1. Turn on email/password auth.** Dashboard → Authentication → Sign In /
Providers → Email, enabled. Also switch **off** "Confirm email" so staff can
sign in the moment they sign up. Leave it on if you would rather verify
addresses; `supabase/config.toml` has this set to off to match.

**2. Create your own account.** Open the app → *Create an account* → name,
email, password. You are a cashier at this point and the admin panels are
not visible.

**3. Make yourself the main admin.** SQL Editor, run `supabase/seed-admin.sql`
with your email substituted in. Sign out, sign back in, all six panels appear.

From then on the main admin grants and removes admin from the Staff panel.
No SQL needed again.

---

## Running it locally

The app must be served over HTTP — opening `index.html` straight off disk
gives the page a `null` origin, which Supabase rejects.

```bash
npm run dev        # serves the app on :5173
```

The `offline/` localStorage build described in earlier notes is **not** in
this repo. If you still have it, drop it in as `offline/`, restore the
`offline` script in `package.json`, and add it back to the layout above.

---

## The public menu board

`board.html` is the one page a customer sees. No login, no cart, no
ordering — it reads the same 80 items the kitchen edits, so a price
changed in the Menu manager is live on the board immediately. Print a QR
code pointing at it and stick it on the tables.

Staff reach it from **View menu** in the sidebar, which navigates there in the
same tab. The board has no sidebar of its own, so it grows a **Back to the
till** link instead — and that link is drawn only when the browser already
holds a session. A diner scanning the QR code has none, so they are never
shown a route into the counter app; signing in is what reveals it, and it
grants nothing RLS would not already allow.

The link returns you to wherever you came from, if that was one of our own
pages, so glancing at the menu from Sales takes you back to Sales. Otherwise
it goes to the till. It is hidden when printing.

It does **not** load `app.js`. It talks to Supabase as `anon`, and the
database only lets that role see the menu as printed:

| anon can read | anon cannot read |
|---|---|
| item name, size, price | VAT rate |
| category names | sales, bill lines, order counts |
| address, phone, opening hours | staff, admins, counters |

That restriction is a **column-level grant**, not just a policy. Order
volumes live in the `item_order_totals` view, which `anon` has no grant on
at all — so the board cannot be used to work out how much the restaurant is
selling. Items taken off the menu are invisible to diners rather than shown
struck through, which is a staff-facing detail.

Note for future migrations: the policy and the column grant have to stay in
step, and the view stays off `anon` entirely.

---

## Roles

| | Cashier | Admin | Main admin |
|---|:--:|:--:|:--:|
| Orders, discounts, charge, print | ✓ | ✓ | ✓ |
| View inventory and sales | ✓ | ✓ | ✓ |
| Operate at all (needs approval first) | ✓ | ✓ | ✓ |
| Approve or suspend an account | | ✓ | ✓ |
| Add, edit, delete menu items | | ✓ | ✓ |
| Add or delete categories | | ✓ | ✓ |
| Start a void | ✓ | ✓ | ✓ |
| Approve a void (password) | | ✓ | ✓ |
| Backups and reset | | ✓ | ✓ |
| Grant or remove admin | | | ✓ |
| Change your own name and password | ✓ | ✓ | ✓ |

Staff create their own accounts, and then wait. A new sign-up can do nothing
at all until an admin approves it on the Staff page — no charging, no sales
log, not even the staff roster. Until then they see a "waiting for approval"
screen and nothing else.

This exists because sign-up is public. Without it, anyone who could reach the
login page was a working cashier one form submission later, with read access
to every bill the restaurant had ever rung up.

Approval is not a column the browser can write. `staff`'s UPDATE grant is
narrowed to `(name)`, so `update staff set approved = true` fails for
everybody, admins included; the only door is `approve_staff()`, which
re-checks `is_admin()` as the owner. That matters because `staff_self_update`
already lets you write your own row — without the column grant, a pending
cashier could simply approve themselves. `is_approved()` treats any admin as
approved, so an admin can never be locked out of the page they would need to
fix it, and the function refuses to touch your own row or the main admin's.

---

## Themes

This is the futuristic build. The original plum-and-rose styling is still
reachable: both icon sets ship in `app.js`, so setting

```js
const THEME = 'classic';
```

switches the nav back to emoji. The full classic look also needs the classic
`freddys.css`, which has no console layer — the two must agree, and the
console line tells you which is loaded.

---

## The look

The work surface stays paper-light on purpose. This room has fluorescent
lights, staff read it at a glance mid-service, and the bills print from the
same stylesheet — a dark canvas would trade real legibility for atmosphere.
The instrument feeling lives in the chrome instead: a deep calibrated shell
around a bright worktop, and in how things move.

The accent is the restaurant's own rose pushed to a luminous value rather than
an imported neon, so the app still looks like the place it belongs to.

**Signature: the active rail.** A luminous bar grows from nothing to full
height when a panel takes focus, and the row lights rather than filling with a
flat colour. It is the one piece of theatre here, and it earns its place by
answering "where am I" from the corner of the eye during service. Everything
else is kept quiet: hover lifts on the order tiles, a press-scale on buttons, a
single flash on the total when it changes — enough to catch a mis-tap, not
enough to nag. All of it is off under `prefers-reduced-motion`.

The nav icons are one drawn set on a 24px grid, 1.6 stroke, `currentColor`, so
they inherit the rail's glow. They replaced emoji, which rendered differently
on every terminal and were unreadable at 16px on Windows.

---

## Confirming a charge

Charging is the only action at the till that cannot be quietly undone: the
bill number is spent the moment it goes through, the sequence is not allowed
gaps, and reversing it needs an admin's password. So the Charge button opens a
read-back — the lines, the discount, the total, the tender and the change —
before anything is committed.

The confirmation reads from a snapshot taken when the button was pressed, not
from the live inputs, so a stray tap behind the modal cannot change what
actually gets charged. Short cash is caught here and the confirm button is
disabled, rather than letting the person meet the server's refusal after
committing to the total out loud. The change due is given the most weight on
the card, because it is the figure most often fumbled in a hurry.

How often it appears is an admin setting under Settings → At the till, stored
centrally so every terminal agrees: **always**, **never**, or only for bills
over a threshold. That middle option still reads back any discounted bill
whatever its size — a mistyped discount is precisely what this catches, and
the hardest thing to notice afterwards.

---

## Errors the person can act on

Every message the SQL raises is written for the person at the counter and
carries a SQLSTATE we chose, so `fail()` keys off the code and shows all of
them verbatim. It used to match the message against a keyword list, which
meant any wording nobody had thought to add was swallowed behind a generic
apology — that is what made a failing reset impossible to diagnose. A generic
toast now means genuine plumbing; the full error object always reaches the
console either way.

`PGRST202` gets its own message, because "could not find the function" always
means the same thing here: the browser is running older code than the
database.

---

## Resetting the sales log

`sales.no` is UNIQUE, which makes "restart bill numbering" quietly dangerous:
if bills survive the reset, the next sale of the same day rebuilds a number
that already exists, `create_order()` dies on the duplicate key, and the till
stops taking orders mid-service. `reset_sales_data()` therefore refuses to
restart numbering while any bill remains — checked *after* the delete, so
clearing the log and restarting the count together still works. The modal
disables the numbering box and explains why rather than letting anyone pick
the combination and meet the error later.

The reset also clears the warm cache. Without that, another tab in the same
session would carry on painting bills that no longer exist.

---

## Deploying

Vercel connected to GitHub, in short: import the repo, Framework Preset
**Other**, leave build/output/install commands empty, deploy. Every push to
`main` ships; every PR gets a preview. Full instructions plus the other three
hosts are in `DEPLOY.md`.

---

## Deleting a category

`items.cat` is `ON DELETE RESTRICT`, so Postgres will not orphan a dish — but
a bare DELETE from the browser only produces a foreign-key error nobody can
act on. `delete_category()` turns that into something a manager can resolve:
an empty category just goes, and one with dishes asks where they should move
to, then does the move and the delete in a single transaction so there is no
state where the dishes moved but the category survived.

DELETE on `categories` is revoked from the API, making the function the only
door. That is what enforces the two rules a foreign key cannot express: admin
only, and never the last category standing, since the Add item form needs
somewhere to file a dish.

Note that the Menu manager shows categories with nothing in them. It used to
skip them, which meant an empty category was invisible and therefore
impossible to tidy away — the reason this feature was needed in the first
place. Nothing here can delete a dish; that stays a deliberate act on the
item card.

---

## Why a nav click feels instant

Every panel is its own document, so a click used to mean: fetch the page,
re-run auth, re-fetch the menu, and only then draw something. Four things
changed that.

SheetJS (880 KB) was loading on seven pages and is only needed when somebody
presses Export; it is now fetched on demand. The two role lookups did not
depend on each other but ran one after the other, so they now go together —
one round trip to Sydney instead of two. Each tab keeps the last known role,
menu and totals in sessionStorage and paints from them on the first frame,
revalidating in the background. And the sidebar and topbar are named as view
transitions, so the browser holds them still and cross-fades only the panel
underneath instead of blanking the window.

The cache is presentation only. `is_admin()` in Postgres decides every
privileged action, so a tampered cache buys a fake sidebar for one frame and
is corrected the moment the server answers — including bouncing off a page
the person should not be on.

---

## How the data is protected

Hiding a button is a courtesy, not the control. Every privileged action is
re-checked inside Postgres.

**Checkout sends only `{item_id, qty}`.** `create_order()` re-reads the price
from the table, derives the discount from its *type* rather than trusting an
amount, computes VAT from `settings`, and allocates the bill number under a
row lock on `counters`. Editing the cart in devtools changes nothing about
what gets charged.

**A void needs an admin password every time**, even from an admin who is
already signed in — a terminal left open at the counter is not authority. When
the person signed in *is* an admin, the box asks for their password and
nothing else, since the app already knows the address; the email field appears
only for a cashier fetching a manager, or behind "a different admin is
approving" when someone approves on a colleague's terminal. It cannot be
dropped entirely — Supabase verifies an email and a password together, and no
account can be identified from a password alone, because only a one-way hash
of it is ever stored.

The browser never checks that password itself. A second, throwaway Supabase
client signs in with whatever was typed and calls `void_sale()` with *its*
token, so `auth.uid()` inside Postgres is the person who actually approved
it and `is_admin()` decides whether it goes through. A cashier can therefore
call the manager over: the manager types their own details, the void is
recorded under their name, and the cashier's session on that terminal is
untouched. `sales.voided_by_name` keeps a copy of the name, the same way
`cashier_name` does, so the trail survives the account being deleted.

**`sales` and `sale_lines` have SELECT policies and nothing else.** No
insert, update or delete policy exists anywhere. The only way to write a
bill is `create_order()`; to void one, `void_sale()`; to clear them,
`reset_sales_data()`. The latter two call `is_admin()` server-side, so a
cashier hitting the RPC from the browser console is rejected regardless of
what the UI showed them.

**`counters` has RLS on with zero policies** — unreachable from the API,
written only by those functions. Supabase's advisor flags this as INFO; it
is intentional and the table carries a comment saying so.

**Bill lines keep their own copy of the item name and price**, so editing or
deleting a menu item never rewrites a bill that was already printed.

The publishable key in `supabase-config.js` is safe in public. It only names
the project. Row Level Security is what protects the data.

---

## Verified against the live database

An integration test ran inside a transaction that rolled itself back.
Eleven checks, all passing:

- signup trigger creates the staff row
- `create_order` totals, VAT and bill number format `FR-YYMMDD-NNNN`
- off-menu item refused
- short cash refused
- cashier blocked from `void_sale`
- cashier blocked from `reset_sales_data`
- admin void marks the bill void and stamps the approver's name
- a voided bill drops back out of the order counts
- double void refused
- admin reset clears sales and cascades the lines

The front end has its own suite: 47 checks under jsdom covering login, role
gating, discount maths, and every branch of the reset gate.

Re-run these after applying `20260823093000_freddys_drop_stock_and_void_audit.sql`:
the stock-related cases no longer apply, and the void cases need the password
prompt in front of them.

---

## The reset

Settings → Danger zone. Three gates: choose what to clear, download the
Excel backup — the delete button stays disabled until a file actually
reaches the browser — then type RESET and confirm again. The RPC re-checks
`is_admin()` regardless of what the UI allowed.

JSON restore is deliberately disabled in the Supabase build. On shared books
the safe way back is Dashboard → Database → Backups, not one browser
overwriting everyone else's data.

---

## The menu

80 items across 11 categories, transcribed from the printed card. Five rows
are seeded inactive and render **struck through**, mirroring the pen strikes
on the physical menu: Cornsilog, Longsilog, Grilled Beef, and Watermelon
Juice (two rows — Glass and Pitcher).

**Worth checking — these came from handwriting, not print:**

- Sinigang na Maya-Maya and Sweet & Sour Maya-Maya at ₱589 (printed ₱489
  plus the pencilled +100)
- Grilled Beef Ribs ₱397 — handwritten addition
- Pork Shanghai, 6 pcs, ₱230 — printed figure overwritten by hand

Nothing needs entering before you open. Inventory fills itself as bills are
charged.

---

## Project

- Name: FREDDY'S SEAFOOD GRILL & RESTAURANT
- Ref: `uyhbtubxmycofdyuajkn`
- Region: `ap-southeast-2` (Sydney) — about 100ms further from Laguna than
  Singapore. Fine for a counter terminal, and it cannot be changed after
  creation; moving would mean a new project and a restore.
