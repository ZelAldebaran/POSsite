/* ============================================================
   Freddy's Seafood Grill & Restaurant — Supabase edition
   ------------------------------------------------------------
   Every device sees the same books. Prices are re-read inside
   Postgres at checkout, so the browser only ever sends {item_id, qty}.
   There is no stock count to keep honest — Inventory reports what has
   been ordered instead. Roles are a row in `admins`, checked by
   is_admin() server-side — the UI hiding a button is a courtesy,
   not the control.
   ============================================================ */

/* Bumped whenever this file changes, and matched by the ?v= on every
   <script> tag. If the console does not print this number after a reload,
   the browser or the host is handing back an older file — check WHERE the
   file landed before you debug anything else. */
const BUILD = 47;

/* 'futuristic' — drawn stroke icons, console chrome, motion.
   'classic'    — the original emoji icons and flat plum/rose styling.
   This line is the ONLY difference between the two builds' JavaScript. It has
   to agree with which freddys.css is deployed alongside it: the classic
   stylesheet has no console layer, so leaving this on 'futuristic' would draw
   SVG icons with no rule to size them. */
const THEME = 'futuristic';

window.FREDDYS_BUILD = BUILD;
window.FREDDYS_THEME = THEME;
console.info("Freddy's POS — build " + BUILD + " (" + THEME + " theme)");

/* ------------------------------------------------------------------
   1. STATE
   ------------------------------------------------------------------ */
let db = { categories: [], items: [], settings: {}, sales: [], staff: [], admins: [], orderTotals: {}, salesTruncated: false };
let session = null;          // { id, email, name, role }
let cart = [];
let posCat = 'all';
let mmCat = 'all';
let signupMode = false;
let channel = null;

/* ------------------------------------------------------------------
   1b. WARM CACHE
   Each panel is its own document, so every nav click re-runs auth and
   re-fetches the menu before a single pixel can appear — several round trips
   to Sydney with a blank screen while they finish. We keep the last answers
   in sessionStorage (per tab, gone when the tab closes), paint from those
   immediately, then revalidate over the network and repaint if anything
   moved.

   Presentation only. is_admin() in Postgres still decides every privileged
   action, so a tampered cache buys a fake sidebar and nothing else — and it
   is corrected the moment the real answer lands.
   ------------------------------------------------------------------ */
const warm = {
  key: k => 'freddys:' + k,
  get(k) {
    try { const v = sessionStorage.getItem(warm.key(k)); return v ? JSON.parse(v) : null; }
    catch (_) { return null; }
  },
  set(k, val) {
    try {
      const s = JSON.stringify(val);
      // A busy month of bills can outgrow the quota. Skip rather than throw.
      if (s.length > 900000) return;
      sessionStorage.setItem(warm.key(k), s);
    } catch (_) {}
  },
  clear() {
    try {
      Object.keys(sessionStorage)
        .filter(k => k.indexOf('freddys:') === 0)
        .forEach(k => sessionStorage.removeItem(k));
    } catch (_) {}
  }
};

/* ------------------------------------------------------------------
   2. HELPERS
   ------------------------------------------------------------------ */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* Pesos to centavos. Every figure the cashier reads aloud is computed in
   integers from here, because Postgres works in exact numeric and JavaScript
   does not — 0.35 * 0.1 is 0.034999999999999996 in a double. Non-finite input
   becomes 0 rather than NaN, which would otherwise propagate silently through
   an entire ticket. */
const c = n => { const v = Number(n); return Number.isFinite(v) ? Math.round(v * 100) : 0; };
const isAdmin = () => !!session && (session.role === 'admin' || session.role === 'super_admin');
const isSuperAdmin = () => !!session && session.role === 'super_admin';
const isApproved = () => !!session && session.approved === true;
const catName = id => (db.categories.find(c => c.id === id) || {}).name || id;
const itemLabel = i => i.name + (i.size ? ' — ' + i.size : '');
const num = v => Number(v || 0);
/* The restaurant is in Laguna and the books are kept in Manila time. Postgres
   stores ts as timestamptz and hands it back in UTC, and create_order() stamps
   the bill number with to_char(timezone('Asia/Manila', now()), 'YYMMDD').
   Anything here that slices a UTC string or trusts the browser clock will
   disagree with the number printed on the bill for every sale rung between
   midnight and eight in the morning — the bill says today, the sales filter
   files it under yesterday.

   So: one timezone, named once, used for every boundary and every display. */
const MANILA = 'Asia/Manila';
const MANILA_OFFSET = '+08:00';   // the Philippines has no DST and never has

/* 'YYYY-MM-DD' for the Manila day a moment falls in. formatToParts rather
   than toLocaleDateString because locale date order is not something to bet
   a date comparison on. */
const manilaDay = when => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: MANILA, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(when))
    .reduce((o, x) => (o[x.type] = x.value, o), {});
  return p.year + '-' + p.month + '-' + p.day;
};

const todayISO = () => manilaDay(new Date());

const fmtDT = iso => new Date(iso).toLocaleString('en-PH', {
  timeZone: MANILA,
  year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
});

function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => t.remove(), 3600);
}

/* Postgres raises readable messages from the functions; surface those
   rather than a generic failure, but never leak a raw SQL error. */
/* Every message our own SQL raises is written for the person at the counter,
   and each one is raised with a SQLSTATE we picked. Keying off the code shows
   all of them and needs no maintenance.

   This used to match the message text against a list of keywords, which meant
   any error whose wording nobody had thought to add — including "bill
   numbering can only restart when the sales log is empty" and PostgREST's
   "could not find the function" — was swallowed behind a generic apology.
   That is exactly the failure that made a broken reset impossible to diagnose. */
const DELIBERATE = new Set([
  'P0001',   // raise exception, no explicit code
  '22023',   // invalid_parameter_value — our validation failures
  '23503',   // foreign_key_violation — "no such item / category / bill"
  '28000',   // invalid_authorization — "sign in first"
  '28P01',   // invalid_password — "that PIN does not match an admin"
  '42501',   // insufficient_privilege — "only an admin can…"
  '53400'    // configuration_limit_exceeded — the void PIN lockout
]);

function fail(error, fallback) {
  console.error(error);
  const code = (error && error.code) || '';
  const raw = (error && (error.message || error.error_description)) || '';
  const clean = raw.replace(/^.*?ERROR:\s*/i, '').split('\n')[0];

  // PostgREST could not match what the page asked for against what the
  // database has. That means this browser is running older code than the
  // server — the single most common failure here, and worth naming outright.
  if (code === 'PGRST202' || code === 'PGRST203' || code === 'PGRST204' ||
      /could not find the (function|column|table)/i.test(raw)) {
    return toast('This page is older than the database — reload with Ctrl+Shift+R. ' +
      'If it keeps happening, the latest files have not been deployed.', 'err');
  }
  if (code === '23505') {
    // Postgres' own unique-violation text names constraints and columns, which
    // is no use at a counter. Our own raises use this code too — set_void_pin()
    // refusing a PIN another admin holds — and those messages are written for
    // the person reading them, so they go through as they are.
    return toast(/duplicate key value|violates unique constraint/i.test(raw)
      ? 'That would duplicate a record that already exists.'
      : (clean || 'That would duplicate a record that already exists.'), 'err');
  }
  // A check constraint reaching the browser means a value got past the input's
  // own limits. Postgres names the constraint, which tells the person at the
  // counter nothing, so translate the ones a client can actually trip.
  if (code === '23514') {
    if (/staff_name_len/.test(raw))                     return toast('A display name is 1 to 80 characters.', 'err');
    if (/settings_vat_check/.test(raw))                 return toast('VAT has to be between 0 and 30 percent.', 'err');
    if (/confirm_charge_over_check/.test(raw))          return toast("The read-back amount can't be negative.", 'err');
    if (/confirm_charge_check/.test(raw))               return toast('Pick one of the three read-back options.', 'err');
    if (/items_price_check|price/.test(raw))            return toast("A price can't be negative.", 'err');
    if (/qty/.test(raw))                                return toast('Quantity has to be at least 1.', 'err');
    return toast("One of those values is outside what's allowed.", 'err');
  }

  if (DELIBERATE.has(code) && clean) return toast(clean, 'err');

  toast(fallback || 'That did not go through. Try again.', 'err');
}

function openModal(html) {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) closeModal(); });
  $('#modalRoot').appendChild(wrap);
  const first = wrap.querySelector('input,select,textarea,button');
  if (first) setTimeout(() => first.focus(), 40);

  /* Keep Tab inside the dialog. Without this it walks straight out into the
     page behind — which on the void and reset dialogs means tabbing off a
     confirmation and onto the very controls it is guarding. Invisible on a
     touch till, and the whole interaction for anyone on a keyboard. */
  lastFocus = document.activeElement;
  wrap.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const stops = wrap.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
      'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
    if (!stops.length) return;
    const top = stops[0], end = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === top) { e.preventDefault(); end.focus(); }
    else if (!e.shiftKey && document.activeElement === end) { e.preventDefault(); top.focus(); }
  });
  return wrap;
}

let lastFocus = null;

function closeModal() {
  $('#modalRoot').innerHTML = '';
  // Put the caret back where it was, or focus lands on <body> and the next
  // Tab starts from the top of the page.
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* SheetJS is 880 KB and only ever runs when somebody presses Export. It used
   to load on every page, on every navigation, ahead of the till being usable.
   Now it is fetched the first time it is actually needed and reused after
   that; exportExcel() already falls back to CSV if it cannot be had.

   Served from vendor/ rather than a CDN. A till on restaurant wifi should not
   need cdnjs to be reachable to write a backup, and a third party should not
   be able to change what runs on the page that handles the takings. The
   fallback still matters — the file can fail to load for local reasons. */
let xlsxLoad = null;
function loadXLSX() {
  if (typeof XLSX !== 'undefined') return Promise.resolve(true);
  if (!xlsxLoad) {
    xlsxLoad = new Promise(resolve => {
      const el = document.createElement('script');
      el.src = 'vendor/xlsx-0.18.5.min.js';
      el.onload = () => resolve(true);
      el.onerror = () => { xlsxLoad = null; resolve(false); };
      document.head.appendChild(el);
    });
  }
  return xlsxLoad;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

/* ------------------------------------------------------------------
   3. AUTH
   ------------------------------------------------------------------ */
function setSignupMode(on) {
  signupMode = on;
  $('#nameField').classList.toggle('hidden', !on);
  $('#lgName').required = on;
  $('#loginTitle').textContent = on ? 'Create an account' : 'Sign in';
  $('#loginHint').textContent = on
    ? 'A manager approves the account before you can use it'
    : 'Counter terminal — Pagsanjan, Laguna';
  $('#lgSubmit').textContent = on ? 'Create account' : 'Sign in';
  $('#lgPass').autocomplete = on ? 'new-password' : 'current-password';
  $('#swapPrompt').textContent = on ? 'Already have an account?' : 'New member of staff?';
  $('#swapMode').textContent = on ? 'Sign in instead' : 'Create an account';
  $('#loginMsg').classList.add('hidden');
}

function loginError(msg) {
  const el = $('#loginMsg');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = $('#lgEmail').value.trim();
  const password = $('#lgPass').value;
  const btn = $('#lgSubmit');
  $('#loginMsg').classList.add('hidden');
  busy(btn, true, signupMode ? 'Creating…' : 'Signing in…');

  try {
    if (signupMode) {
      const name = $('#lgName').value.trim();
      if (!name) { loginError('Enter your full name.'); return; }
      if (password.length < 6) { loginError('Use at least 6 characters for the password.'); return; }
      const { data, error } = await sb.auth.signUp({
        email, password, options: { data: { name } }
      });
      if (error) { loginError(error.message); return; }
      if (!data.session) {
        loginError('Account created. Confirm your email, sign in, then ask a manager to approve you.');
        setSignupMode(false);
        return;
      }
      location.replace('index.html');
      return;
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        loginError(/invalid/i.test(error.message)
          ? 'That email and password do not match an account.'
          : error.message);
        return;
      }
      location.replace('index.html');
      return;
    }
  } finally {
    busy(btn, false);
  }
}

/* Role comes from the admins table, not from anything the client holds.
   The two lookups do not depend on each other, so they go together — one
   round trip to Sydney instead of two, on every single page load. */
async function resolveRole(user) {
  const [admin, staff] = await Promise.all([
    sb.from('admins').select('role').eq('id', user.id).maybeSingle(),
    sb.from('staff').select('name, approved').eq('id', user.id).maybeSingle()
  ]);
  const adminRow = admin.data, staffRow = staff.data;
  let name = (user.user_metadata && user.user_metadata.name) || '';
  if (staffRow && staffRow.name) name = staffRow.name;
  const resolved = {
    id: user.id,
    email: user.email,
    name: name || (user.email || '').split('@')[0],
    role: adminRow ? adminRow.role : 'user',
    // An admin row is NOT approval. It used to be, and is_approved() in
    // Postgres used to agree — it no longer does, so a suspended admin would
    // otherwise sail past the pending screen into a UI where every single
    // action comes back refused by the server.
    approved: !!(staffRow && staffRow.approved)
  };
  warm.set('role:' + user.id, resolved);
  return resolved;
}

/* Paint the person into the shell. Pure DOM, no awaiting — this is what runs
   off the cache to get the sidebar up on the first frame. */
function applySession(who) {
  session = who;
  $('#avatar').textContent = (session.name || 'F').charAt(0).toUpperCase();
  $('#whoName').textContent = session.name;
  const chip = $('#whoRole');
  chip.textContent = session.role === 'super_admin' ? 'Main admin' : (isAdmin() ? 'Admin' : 'Cashier');
  chip.className = 'role-chip ' + (isAdmin() ? 'role-admin' : 'role-user');
  buildNav();
}

/* Signed in, but nobody has vouched for them yet. Rather than let them wander
   a UI where every action would be refused, hold the whole app behind this.
   It is courtesy, not enforcement — is_approved() in Postgres is what actually
   stops an unapproved account charging a bill or reading the books. */
function showPendingScreen() {
  document.title = 'Waiting for approval | Freddy\'s';
  const app = $('#app');
  if (!app) return;
  app.innerHTML =
    '<div class="pending-wrap"><div class="pending-card">' +
    '<div class="est">EST &middot; 2024</div>' +
    '<div class="brand">FREDDY\'S</div>' +
    '<div class="brand-sub">Seafood Grill &amp; Restaurant</div>' +
    '<h3>Waiting for approval</h3>' +
    '<p>Your account is created, <strong>' + esc(session.name) + '</strong>, but a manager ' +
    'has to approve it before you can take orders or see the sales log.</p>' +
    '<p class="muted">Ask whoever runs the counter to open <strong>Staff</strong> and approve ' +
    esc(session.email || 'your account') + '. It takes them one tap.</p>' +
    '<div class="pending-actions">' +
    '<button class="btn btn-primary" id="pendCheck">Check again</button>' +
    '<button class="btn btn-ghost" id="pendOut">Sign out</button>' +
    '</div></div></div>';

  $('#pendOut').addEventListener('click', signOut);
  $('#pendCheck').addEventListener('click', async e => {
    busy(e.target, true, 'Checking\u2026');
    const { data } = await sb.auth.getSession();
    if (!data || !data.session) return location.replace('login.html');
    const fresh = await resolveRole(data.session.user);
    if (fresh.approved) { location.reload(); return; }
    busy(e.target, false);
    toast('Not approved yet. Give them a moment.', 'err');
  });
}

/* The next panel is a document fetch away. Pull the likely ones into the HTTP
   cache while the terminal is sitting idle, so the click costs nothing. */
function prefetchPanels() {
  const go = () => Object.keys(PAGES).forEach(key => {
    const p = PAGES[key];
    if (key === PAGE || (p.admin && !isAdmin())) return;
    const l = document.createElement('link');
    l.rel = 'prefetch'; l.href = p.href; l.as = 'document';
    document.head.appendChild(l);
  });
  if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 3000 });
  else setTimeout(go, 1200);
}

async function signOut() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  warm.clear();
  await sb.auth.signOut();
  session = null; cart = [];
  db = { categories: [], items: [], settings: {}, sales: [], staff: [], admins: [], orderTotals: {}, salesTruncated: false };
  location.replace('login.html');
}

/* ------------------------------------------------------------------
   4. DATA LOADING
   ------------------------------------------------------------------ */
async function loadCore() {
  const cached = warm.get('core');
  if (cached && !db.items.length) {
    db.categories = cached.categories || [];
    db.items = (cached.items || []).map(normItem);
    db.settings = cached.settings || { vat: 12 };
    renderAll();                       // something real on screen, this frame
  }

  const [cats, items, settings] = await Promise.all([
    sb.from('categories').select('*').order('sort'),
    sb.from('items').select('*').order('name'),
    sb.from('settings').select('*').eq('id', 1).maybeSingle()
  ]);
  if (cats.error || items.error) { fail(cats.error || items.error, "Couldn't load the menu."); return; }
  db.categories = cats.data || [];
  db.items = (items.data || []).map(normItem);

  // If rows still carry `stock`, the SQL half of the update has not been
  // applied. Say so plainly rather than behaving oddly for a week.
  if ((items.data || []).some(i => 'stock' in i)) {
    console.warn('items.stock still exists — run the 20260823040000 migration.');
    toast('The database still has stock columns. Run the latest migration.', 'err');
  }
  db.settings = settings.data || { vat: 12 };
  warm.set('core', { categories: db.categories, items: items.data || [], settings: db.settings });
  renderAll();
}

const normItem = i => ({ ...i, price: num(i.price) });

/* settings is deliberately NOT in the realtime publication, and cannot safely
   be added. settings_public_read grants anon SELECT with USING true, realtime
   filters rows by RLS but not by column grants, and a publication's column
   list is shared across every subscribing role — so publishing
   discount_max_pct so the till can see it would hand it, the VAT rate and the
   read-back thresholds to anyone holding the anon key, which is public in
   supabase-config.js. The column lockdown that keeps anon to name and address
   would not apply. Same mechanism as the items column list in 20260828012940,
   the other way round.

   So the till asks instead, when it comes back to the foreground. A terminal
   is backgrounded and woken all day; a ceiling the owner sets on their phone
   should not wait for somebody to reload the page. One small query, and it is
   the only figure on this page the server can refuse a charge over. */
async function refreshSettings() {
  const { data, error } = await sb.from('settings').select('*').eq('id', 1).maybeSingle();
  if (error || !data) return;                    // offline is not worth a toast here
  db.settings = data;
  const core = warm.get('core');
  if (core) warm.set('core', { ...core, settings: data });
  renderTicket();                                // the ceiling note may have changed
}

/* Inventory used to read items.stock. That column is gone: a kitchen
   cooking to order cannot keep the count honest, and a stale count refused
   real sales. item_order_totals rebuilds the same page from sale_lines —
   how many of each dish has actually gone out — which nobody has to
   maintain and which a void quietly takes back off again. */
async function loadOrderTotals() {
  const cached = warm.get('totals');
  if (cached && !Object.keys(db.orderTotals).length) { db.orderTotals = cached; renderInventory(); }

  const { data, error } = await sb.from('item_order_totals').select('*');
  if (error) { fail(error, "Couldn't load the order counts."); return; }
  db.orderTotals = {};
  (data || []).forEach(r => {
    db.orderTotals[r.item_id] = {
      qty: num(r.qty_ordered), voided: num(r.qty_voided),
      orders: num(r.order_count), revenue: num(r.revenue),
      last: r.last_ordered_at
    };
  });
  warm.set('totals', db.orderTotals);
}

const totalsFor = id => db.orderTotals[id] || { qty: 0, voided: 0, orders: 0, revenue: 0, last: null };

/* The page loads the newest SALES_PAGE bills so it opens quickly. That cap is
   fine until somebody picks a date range — and the date filter used to sift
   this same truncated array, so once the log passed a thousand bills, asking
   for last March returned "no bills" while March sat in the database
   untouched. Empty, not an error: the worst way to be wrong about your own
   takings, and it only shows up the day an accountant asks.

   So a date range is a query, not a filter. It goes to the server, pages
   through everything inside the range, and cannot silently miss a bill. */
async function loadSales(from, to) {
  const ranged = !!(from || to);

  if (!ranged) {
    const cached = warm.get('sales');
    if (cached && !db.sales.length) { db.sales = cached; renderSales(); }
  }

  let q = sb.from('sales').select('*, sale_lines(*)').order('ts', { ascending: false });
  // The inputs are dates; a bill at 19:40 must fall inside its own day. The
  // offset is not decoration: without it Postgres reads a bare timestamp in
  // the server's timezone, which is UTC, so "today" would start at eight in
  // the morning Manila time and swallow the first eight hours of tomorrow.
  if (from) q = q.gte('ts', from + 'T00:00:00' + MANILA_OFFSET);
  if (to)   q = q.lte('ts', to + 'T23:59:59.999' + MANILA_OFFSET);

  if (!ranged) {
    const { data, error } = await q.limit(SALES_PAGE);
    if (error) { fail(error, "Couldn't load the sales log."); return; }
    db.sales = (data || []).map(normaliseSale);
    db.salesTruncated = db.sales.length === SALES_PAGE;
    warm.set('sales', db.sales);
    return;
  }

  const all = [];
  for (let i = 0; ; i += SALES_PAGE) {
    const { data, error } = await q.range(i, i + SALES_PAGE - 1);
    if (error) { fail(error, "Couldn't load the sales log."); return; }
    const batch = data || [];
    all.push(...batch.map(normaliseSale));
    if (batch.length < SALES_PAGE) break;
  }
  db.sales = all;
  db.salesTruncated = false;   // a range is complete by construction
}

/* Called whenever a date box changes. Re-queries rather than re-filtering. */
async function applySalesFilter() {
  const from = $('#salesFrom').value, to = $('#salesTo').value;
  await loadSales(from, to);
  renderSales();
}

/* The Sales page caps at 1000 rows to stay quick. A backup must not.
   reset_sales_data() deletes every bill, and the reset gate will not unlock
   until a file has downloaded — so if that file held only the newest 1000,
   the one safeguard in front of a permanent delete would be handing over an
   incomplete archive while looking like it worked. Page through the lot. */
const SALES_PAGE = 1000;

function normaliseSale(s) {
  return {
    ...s,
    subtotal: num(s.subtotal), discount: num(s.discount), total: num(s.total),
    vat: num(s.vat), vatable: num(s.vatable), vat_rate: num(s.vat_rate),
    cash: num(s.cash), change_due: num(s.change_due),
    lines: (s.sale_lines || []).map(l => ({ ...l, price: num(l.price), line_total: num(l.line_total) }))
  };
}

async function fetchEverySale() {
  const all = [];
  for (let from = 0; ; from += SALES_PAGE) {
    const { data, error } = await sb
      .from('sales')
      .select('*, sale_lines(*)')
      .order('ts', { ascending: false })
      .range(from, from + SALES_PAGE - 1);
    if (error) throw error;
    const batch = data || [];
    all.push(...batch.map(normaliseSale));
    if (batch.length < SALES_PAGE) return all;
  }
}

async function loadStaff() {
  const [staff, admins] = await Promise.all([
    sb.from('staff').select('*').order('created_at'),
    sb.from('admins').select('*')
  ]);
  db.staff = staff.data || [];
  db.admins = admins.data || [];
}

/* Realtime keeps a second terminal honest — menu edits and bills land live.
   Inventory now moves when a bill is charged or voided rather than when an
   item row changes, so it listens on `sales` too. */
function subscribeRealtime() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('freddys')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, payload => {
      if (payload.eventType === 'DELETE') {
        db.items = db.items.filter(i => i.id !== payload.old.id);
        reconcileCart({ id: payload.old.id, gone: true });
      } else {
        const row = normItem(payload.new);
        const ix = db.items.findIndex(i => i.id === row.id);
        if (ix >= 0) db.items[ix] = row; else db.items.push(row);
        reconcileCart(row);
      }
      renderMenuGrid();
      if (PAGE === 'inv') renderInventory();
      if (PAGE === 'menu') renderMenuManager();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, async () => {
      if (PAGE === 'sales') { await loadSales(); renderSales(); }
      if (PAGE === 'inv')   { await loadOrderTotals(); renderInventory(); }
    })
    .subscribe();
}

/* ------------------------------------------------------------------
   5. NAV — one file per panel. The nav is links, not a router.
   ------------------------------------------------------------------ */
/* Emoji rendered differently on every terminal — Segoe's plate is not Apple's,
   and at 16px several were unreadable. These are one drawn set: 24px grid,
   1.6 stroke, round caps, currentColor, so they inherit the nav's colour and
   its glow. Geometric rather than pictorial — a receipt tape, stacked crates,
   a rising trace — which is what makes the row read as instrumentation
   instead of a phone home screen. */
const ICO = p =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';

/* The original set. Kept so the classic build is a real alternative rather
   than a stripped one — it looked the way it did on purpose. */
const ICONS_EMOJI = {
  order: '\u{1F9FE}', stock: '\u{1F4E6}', sales: '\u{1F4CA}', menu: '\u{1F37D}',
  staff: '\u{1F465}', settings: '\u2699', board: '\u{1F4D6}', account: '\u{1F464}'
};

const ICONS_LINE = {
  // receipt tape, torn at the foot
  order:   ICO('<path d="M6 2.6h12v18.8l-3-1.8-3 1.8-3-1.8-3 1.8V2.6Z"/><path d="M9.2 8h5.6M9.2 11.6h5.6M9.2 15.2h3.2"/>'),
  // stacked crates, seen from the corner
  stock:   ICO('<path d="M12 2.7 3.2 7.1 12 11.5l8.8-4.4L12 2.7Z"/><path d="M3.2 12.1 12 16.5l8.8-4.4"/><path d="M3.2 17.1 12 21.5l8.8-4.4"/>'),
  // a rising trace on an axis
  sales:   ICO('<path d="M3.4 3.4v17.2h17.2"/><path d="M7 16.2l3.9-4.3 3 2.6 5-6.1"/><path d="M15.3 8.4h3.6v3.6"/>'),
  // the menu grid itself
  menu:    ICO('<rect x="3.2" y="3.2" width="7.4" height="7.4" rx="1.7"/><rect x="13.4" y="3.2" width="7.4" height="7.4" rx="1.7"/><rect x="3.2" y="13.4" width="7.4" height="7.4" rx="1.7"/><rect x="13.4" y="13.4" width="7.4" height="7.4" rx="1.7"/>'),
  staff:   ICO('<circle cx="9.4" cy="8.1" r="3.4"/><path d="M3.3 20.4a6.1 6.1 0 0 1 12.2 0"/><circle cx="17.9" cy="9.6" r="2.2"/><path d="M16.6 15.5a5 5 0 0 1 4.1 4.9"/>'),
  // sliders, not a cog: these are levels you set, not machinery
  settings:ICO('<path d="M3.4 7.4h9.2M17.2 7.4h3.4M3.4 16.6h3.4M11.2 16.6h9.4"/><circle cx="15" cy="7.4" r="2.3"/><circle cx="9" cy="16.6" r="2.3"/>'),
  // the board on the wall
  board:   ICO('<rect x="2.6" y="4" width="18.8" height="13" rx="2.1"/><path d="M8.6 21h6.8M12 17v4"/><path d="M6.6 8.5h6M6.6 12.3h3.8"/>'),
  account: ICO('<circle cx="12" cy="8.3" r="3.7"/><path d="M4.6 20.3a7.4 7.4 0 0 1 14.8 0"/>')
};

const ICONS = THEME === 'classic' ? ICONS_EMOJI : ICONS_LINE;

const PAGES = {
  pos:      { href: 'index.html',     icon: ICONS.order, label: 'New order',  title: 'New order',            sub: 'Tap a dish to add it to the bill', admin: false },
  inv:      { href: 'inventory.html', icon: ICONS.stock, label: 'Inventory',  title: 'Inventory',            sub: 'How much of each dish has been ordered', admin: false },
  sales:    { href: 'sales.html',     icon: ICONS.sales, label: 'Sales',      title: 'Sales',                sub: 'Every bill rung up on any terminal', admin: false },
  menu:     { href: 'menu.html',      icon: ICONS.menu, label: 'Menu',       title: 'Menu manager',         sub: 'The order screen, with the prices unlocked', admin: true },
  staff:    { href: 'staff.html',     icon: ICONS.staff, label: 'Staff',      title: 'Staff accounts',       sub: 'Who can sign in, and what they can do', admin: true },
  settings: { href: 'settings.html',  icon: ICONS.settings,    label: 'Settings',   title: 'Settings & backups',   sub: 'Restaurant details, backups, reset', admin: true },
  // The diner-facing board. It has no sidebar of its own, so it grows a
  // "Back to the till" link instead — drawn only for a browser that is
  // already signed in, so a diner with the QR code never sees it.
  board:    { href: 'board.html',     icon: ICONS.board, label: 'View menu',  title: 'Public menu',          sub: 'What the QR code on the tables shows', admin: false, standalone: true },
  account:  { href: 'account.html',   icon: ICONS.account, label: 'Account',    title: 'Account settings',     sub: 'Your name, your password, what you can do', admin: false }
};

const PAGE = document.body.dataset.page;

function buildNav() {
  const nav = $('#nav');
  if (!nav) return;
  nav.innerHTML = '';
  Object.keys(PAGES).forEach(key => {
    const p = PAGES[key];
    if (p.admin && !isAdmin()) return;
    const a = document.createElement('a');
    a.href = p.href;
    a.className = 'nav-link' + (key === PAGE ? ' active' : '') + (p.standalone ? ' nav-standalone' : '');
    a.innerHTML = '<span class="ico" aria-hidden="true">' + p.icon + '</span><span>' + p.label + '</span>' +
      (p.admin ? '<span class="tag">admin</span>' : '') +
      (p.standalone ? '<span class="tag">public</span>' : '');
    if (key === PAGE) a.setAttribute('aria-current', 'page');
    if (p.standalone) a.title = 'The menu as diners see it';
    nav.appendChild(a);
  });
}

/* The real check is is_admin() in Postgres. This only stops a cashier
   landing on a page whose controls would all fail anyway. */
function guardPage() {
  const p = PAGES[PAGE];
  if (p && p.admin && !isAdmin()) { location.replace('index.html'); return false; }
  return true;
}

function renderTopActions(key) {
  const box = $('#topActions');
  if (!box) return;
  box.innerHTML = '';
  const add = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm ' + cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    box.appendChild(b);
  };
  if (key === 'inv' && isAdmin()) add('Export inventory to Excel', 'btn-ghost', () => exportExcel('inventory'));
  if (key === 'sales' && isAdmin()) add('Export sales to Excel', 'btn-ghost', () => exportExcel('sales'));
  if (key === 'menu') add('Export menu to Excel', 'btn-ghost', () => exportExcel('menu'));
  if (!isAdmin() && key === 'sales') {
    const note = document.createElement('span');
    note.style.cssText = 'font-size:.76rem;color:var(--muted)';
    note.textContent = 'A void needs an admin PIN';
    box.appendChild(note);
  }
}

function openDrawer() { $('#sidebar').classList.add('open'); addScrim(); }
function closeDrawer() { $('#sidebar').classList.remove('open'); const s = $('#scrim'); if (s) s.remove(); }
function addScrim() {
  if ($('#scrim')) return;
  const s = document.createElement('div');
  s.id = 'scrim';
  s.addEventListener('click', closeDrawer);
  document.body.appendChild(s);
}

/* ------------------------------------------------------------------
   6. POS
   ------------------------------------------------------------------ */
function renderAll() { renderCatBar(); renderMmCatBar(); renderMenuGrid(); renderTicket(); fillCatSelects(); }

/* The order screen and the Menu manager are the same menu, so they are drawn
   by the same two functions: same category bar, same sections in the same
   order, same cards. Only what a card *does* differs — tap to add on one,
   Edit / Take off / Delete on the other. A price changed in the manager is
   sitting in the exact spot the cashier will look for it. */
function buildCatBar(mount, current, pick) {
  const bar = $(mount);
  if (!bar) return;
  bar.innerHTML = '';
  const mk = (id, label) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('active', current === id);
    b.addEventListener('click', () => pick(id));
    bar.appendChild(b);
  };
  mk('all', 'All');
  db.categories.forEach(c => mk(c.id, c.name));
}

function renderCatBar() {
  buildCatBar('#catBar', posCat, id => { posCat = id; renderCatBar(); renderMenuGrid(); });
}
function renderMmCatBar() {
  buildCatBar('#mmCatBar', mmCat, id => { mmCat = id; renderMmCatBar(); renderMenuManager(); });
}

/* Categories in their sort order, items alphabetical within each — the order
   the kitchen prints its card in. `card` turns one item into its markup. */
/* opts.showEmpty — the manager needs to see a category with nothing in it,
   otherwise an empty one is invisible and can never be tidied away. The till
   has no use for an empty heading, so it stays off there.
   opts.headAction — extra markup for the section header, which is where the
   manager hangs its Delete button. */
function menuSections(cat, q, card, opts) {
  opts = opts || {};
  const cats = cat === 'all' ? db.categories : db.categories.filter(c => c.id === cat);
  let html = '', shown = 0;
  cats.forEach(c => {
    const items = db.items.filter(i => i.cat === c.id && (!q || itemLabel(i).toLowerCase().includes(q)));
    // While searching, an empty heading is just noise — hide it either way.
    if (!items.length && !(opts.showEmpty && !q)) return;
    shown += items.length;
    html += '<div class="menu-sect"><div class="rule-head">' + esc(c.name) +
      '<span class="head-right">' +
      '<span class="count">' + items.length + ' item' + (items.length === 1 ? '' : 's') + '</span>' +
      (opts.headAction ? opts.headAction(c, items.length) : '') +
      '</span></div>' +
      (items.length
        ? '<div class="item-grid">' + items.map(card).join('') + '</div>'
        : '<div class="empty sect-empty">Nothing in this category yet.</div>') +
      '</div>';
  });
  return { html, shown };
}

/* Name, size, price, availability — identical on both screens. */
function itemCardFace(i) {
  const out = !i.active;
  return '<span class="nm">' + esc(i.name) + '</span>' +
    (i.size ? '<span class="sz">' + esc(i.size) + '</span>' : '') +
    '<span class="pr">' + peso(i.price) + '</span>' +
    '<span class="stk ' + (out ? 'zero' : 'ready') + '">' +
    (out ? 'Off the menu' : 'Available') + '</span>';
}

function renderMenuGrid() {
  if (!$('#menuGrid')) return;
  const q = $('#posSearch').value.trim().toLowerCase();
  const grid = $('#menuGrid');

  const { html, shown } = menuSections(posCat, q, i =>
    '<button class="item' + (i.active ? '' : ' out') + '" data-id="' + i.id + '"' +
    (i.active ? '' : ' disabled aria-disabled="true"') + '>' + itemCardFace(i) + '</button>');

  grid.innerHTML = shown ? html :
    '<div class="empty">Nothing on the menu matches that. Try another word, or check the Menu manager.</div>';
  grid.querySelectorAll('.item:not(.out)').forEach(el =>
    el.addEventListener('click', () => addToCart(el.dataset.id)));
}

/* Cart lines are looked up by this, not by item id — once the same dish can
   sit on the ticket as two lines (one discounted, one not; see addToCart()
   below), item id alone no longer tells "+"/"−"/remove/discount which line
   was pressed. A monotonic counter is enough; this key never leaves the
   browser, so it doesn't need to be globally unique like a bill number does. */
let lineKeySeq = 0;
const newLineKey = () => 'ln' + (++lineKeySeq);

function addToCart(id) {
  const item = db.items.find(i => i.id === id);
  if (!item || !item.active) return;
  // Merges into an existing line for this item ONLY if that line carries no
  // discount of its own. A line's discount applies to its whole qty, so
  // silently bumping a discounted line's qty would discount a unit nobody
  // asked to discount. "2 of the same dish, 1 discounted" has to be two
  // separate lines — which also happens to be how it would print on a
  // receipt anyway.
  const line = cart.find(l => l.id === id && (!l.discType || l.discType === '0'));
  if (line) line.qty++;
  else cart.push({
    key: newLineKey(), id: item.id, name: item.name, size: item.size, price: item.price, qty: 1,
    // Per-item discount, independent of the whole-bill discount below.
    // '0' means none — create_order() defaults to this when a line omits it.
    discType: '0', discAmount: 0
  });
  cartChanged();
  renderTicket();
}

/* Labels for a line's own discount, shown on the ticket and read back before
   charging. Mirrors DISC_LABEL below but scoped to what create_order() writes
   into sale_lines.discount_label for a per-line discount. */
const LINE_DISC_LABEL = { '20': 'Senior / PWD 20%', '10': 'Staff 10%', 'custom': 'Custom' };

/* A line's own discount, in pesos. Centavo integers throughout for the same
   reason billPreview() is — see the note above it. */
function lineDiscountPeso(l) {
  const subC = c(l.price) * l.qty;
  if (l.discType === '20') return Math.round(subC * 0.20) / 100;
  if (l.discType === '10') return Math.round(subC * 0.10) / 100;
  if (l.discType === 'custom') return Math.min(subC, Math.max(0, c(l.discAmount))) / 100;
  return 0;
}

/* Whether this line's discount is over the till's custom-discount cap.
   Named discounts (20%/10%) are exempt, same as the whole-bill discount and
   same as create_order() itself — only a typed-in amount is capped. */
function lineDiscountCapNote(l) {
  if (l.discType !== 'custom') return null;
  const subC = c(l.price) * l.qty;
  const cap = db.settings && db.settings.discount_max_pct != null ? num(db.settings.discount_max_pct) : 100;
  if (cap >= 100 || subC <= 0) return null;
  const maxC = Math.round(subC * cap / 100);
  const discC = Math.min(subC, Math.max(0, c(l.discAmount)));
  return discC > maxC ? { cap, max: maxC / 100 } : null;
}

function changeQty(key, delta) {
  const line = cart.find(l => l.key === key);
  if (!line) return;
  const next = line.qty + delta;
  if (next <= 0) cart = cart.filter(l => l.key !== key);
  else line.qty = next;
  cartChanged();
  renderTicket();
}

/* Shown to the cashier only. Postgres recomputes all of this at checkout.
   That makes agreement between the two a correctness question, not a cosmetic
   one: the confirmation modal reads back these numbers and the receipt prints
   the server's.

   Which is why this counts in centavos. Postgres works in exact numeric and
   rounds half away from zero; JavaScript works in binary floating point, where
   0.35 * 0.1 is 0.034999999999999996 and rounds to 0.03 while Postgres gives
   0.04. Across every subtotal from ₱0.01 to ₱5,000.00 at both named discount
   rates, the old float version disagreed with the server on 818 of a million
   combinations — always by one centavo, always reading back more than it
   charged. None are reachable while every item is priced in whole pesos, as
   all 80 currently are. Pricing one dish at ₱32.15 would arm it. Integer
   arithmetic removes the question rather than relying on the menu. */
/* create_order() picks one of two discount modes for the whole bill, and the
   choice is not made by the caller — it is made by looking at the lines
   themselves. If ANY line carries its own discount, the bill-level
   p_discount_type is ignored entirely and the sale is labelled 'Per item'
   with the sum of the line discounts. Only when no line has one does the
   whole-bill selector apply. This function has to make the identical choice,
   or the preview and the confirmation would show one thing and the server
   would charge another. */
function billPreview() {
  const anyLineDisc = cart.some(l => l.discType && l.discType !== '0');

  if (anyLineDisc) {
    let subC = 0, discC = 0, over = null;
    cart.forEach(l => {
      const lineSubC = c(l.price) * l.qty;
      subC += lineSubC;
      discC += Math.round(lineDiscountPeso(l) * 100);
      if (!over) {
        const note = lineDiscountCapNote(l);
        if (note) over = { ...note, name: l.name };
      }
    });
    return { sub: subC / 100, disc: discC / 100, total: Math.max(0, subC - discC) / 100, over, anyLineDisc };
  }

  const subC = cart.reduce((s, l) => s + c(l.price) * l.qty, 0);
  const type = $('#discType').value;

  /* Math.max(0, ...) mirrors create_order()'s greatest(coalesce(x,0),0), and
     it is not cosmetic. The input says min="0", but a number input only
     enforces that through form validation and there is no form here — the
     same trap the VAT field is clamped against further down. Typing -50 used
     to give a preview of ₱250.00 on a ₱200.00 bill and read that back in the
     confirmation, while the server clamped to zero and charged ₱200.00. The
     cashier collects what the screen said; the books record what the server
     did, and the drawer is over by fifty pesos with nothing to explain it. */
  let discC = type === 'custom'
    ? Math.min(subC, Math.max(0, c($('#discCustom').value)))
    : Math.round(subC * Number(type) / 100);

  /* The ceiling is enforced in create_order() and that is what counts. This
     is only so the cashier finds out while the customer is still deciding,
     rather than at the moment they press Charge. Named discounts are exempt,
     the same as on the server. */
  let over = null;
  if (type === 'custom') {
    const cap = db.settings && db.settings.discount_max_pct != null
      ? num(db.settings.discount_max_pct) : 100;
    if (cap < 100 && subC > 0) {
      const maxC = Math.round(subC * cap / 100);
      if (discC > maxC) over = { cap, max: maxC / 100 };
    }
  }
  return { sub: subC / 100, disc: discC / 100, total: Math.max(0, subC - discC) / 100, over, anyLineDisc: false };
}

/* Editing the cart makes the in-flight reference meaningless: whatever the
   previous attempt may have written was a different bill. Retrying only
   dedupes an unchanged charge. */
function cartChanged() {
  chargeRef = null;
}

/* The menu can change while a bill is open — an admin edits a price on the
   Menu page, or another terminal takes a dish off. The cart holds a snapshot
   taken when the dish was tapped, so without this it keeps the old price
   while create_order() recomputes from items.price. The cashier reads back
   ₱320, the customer pays ₱320, the books record ₱350, and the drawer is
   short with nothing on the receipt to explain it. A dish deactivated or
   deleted is worse: the bill looks fine and the whole charge is refused.

   So the ticket follows the menu, and says so. Silently repricing a bill
   somebody is reading aloud would be its own kind of wrong. */
function reconcileCart(row) {
  const lines = cart.filter(l => l.id === row.id);
  if (!lines.length) return;

  if (row.gone || row.active === false) {
    cart = cart.filter(l => l.id !== row.id);
    cartChanged(); renderTicket();
    toast(lines[0].name + ' came off the menu and has been removed from this bill.', 'err');
    return;
  }

  const newPrice = num(row.price);
  const renamed = row.name !== lines[0].name || (row.size || '') !== (lines[0].size || '');
  if (newPrice === lines[0].price && !renamed) return;

  const was = lines[0].price;
  // Every line for this item moves together — a discounted line and a plain
  // one for the same dish are still the same dish, and a stale price on
  // just one of them would make the two disagree with each other as well
  // as with the menu.
  lines.forEach(l => { l.price = newPrice; l.name = row.name; l.size = row.size; });
  cartChanged(); renderTicket();
  if (newPrice !== was) {
    toast(row.name + ' is now ' + peso(newPrice) + ' (was ' + peso(was) + '). The bill has been updated.', 'err');
  }
}

/* Cash received only means anything on a cash sale — create_order() ignores
   p_cash for GCash and Card. Clearing rather than only hiding, so a value
   left in the box cannot come back into view a click later. */
function syncPayMode() {
  const field = $('#payCash');
  if (!field) return;
  const isCash = $('#payMode').value === 'Cash';
  field.classList.toggle('hidden', !isCash);
  if (!isCash) field.value = '';
  renderTicket();
}

function renderTicket() {
  if (!$('#ticketLines')) return;
  const box = $('#ticketLines');
  if (!cart.length) {
    box.innerHTML = '<div class="empty">No items yet.<br>Tap a dish on the left to start the bill.</div>';
  } else {
    box.innerHTML = cart.map(l => {
      const ld = lineDiscountPeso(l);
      const lineTotal = l.price * l.qty - ld;
      const hasDisc = l.discType && l.discType !== '0';
      return '<div class="line"><div><div class="nm">' + esc(l.name) + '</div>' +
      (l.size ? '<div class="sz">' + esc(l.size) + '</div>' : '') +
      '<div class="qty"><button data-m="' + l.key + '" aria-label="Remove one">−</button>' +
      '<span class="n">' + l.qty + '</span>' +
      '<button data-p="' + l.key + '" aria-label="Add one">+</button>' +
      '<span class="unit">× ' + peso(l.price) + '</span>' +
      '<button class="rm" data-x="' + l.key + '" title="Remove" ' +
      'aria-label="Remove ' + esc(l.name) + '">\u00D7</button></div>' +
      '<button class="linkish" data-disc="' + l.key + '" style="margin-top:5px;' +
      (hasDisc ? 'color:var(--ok)' : '') + '">' +
      (hasDisc
        ? esc(LINE_DISC_LABEL[l.discType] || '') + ' \u2212' + peso(ld) + ' · edit'
        : '+ Discount this item') +
      '</button></div>' +
      '<div class="amt">' + peso(lineTotal) + '</div></div>';
    }).join('');
    box.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => changeQty(b.dataset.m, -1)));
    box.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => changeQty(b.dataset.p, 1)));
    box.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', () => {
      cart = cart.filter(l => l.key !== b.dataset.x); cartChanged(); renderTicket();
    }));
    box.querySelectorAll('[data-disc]').forEach(b => b.addEventListener('click', () => lineDiscountModal(b.dataset.disc)));
  }

  const t = billPreview();
  $('#tSub').textContent = peso(t.sub);
  $('#tDisc').textContent = '−' + peso(t.disc);

  const totalEl = $('#tTotal');
  const next = peso(t.total);
  if (totalEl.textContent && totalEl.textContent !== next) {
    totalEl.classList.remove('tick');
    void totalEl.offsetWidth;          // restart the animation on a repeat tap
    totalEl.classList.add('tick');
  }
  totalEl.textContent = next;
  $('#ticketMeta').textContent = session ? session.name : '—';

  /* Change is a cash idea. create_order() only honours p_cash when the mode
     is Cash — for GCash and Card it stores cash = total and change_due = 0
     regardless of what was typed. This used to read the field whatever the
     mode was, so switching a ₱450 bill to GCash with ₱500 still in the box
     left "Change ₱50.00" on screen while the receipt showed none and the
     books recorded none. That is change handed over that nobody owed.

     Negative is clamped for the same reason as the discount: min="0" on a
     number input is not enforced without a form, and the server reads a
     negative p_cash as "not provided", meaning exact payment. */
  const isCash = $('#payMode').value === 'Cash';
  const cashC = isCash ? Math.max(0, c($('#payCash').value)) : 0;
  const totalC = Math.round(t.total * 100);
  const note = $('#changeNote');
  if (!cart.length || !isCash || !cashC) { note.textContent = ''; note.className = 'change-note'; }
  else if (cashC >= totalC) { note.textContent = 'Change ' + peso((cashC - totalC) / 100); note.className = 'change-note ok'; }
  else { note.textContent = 'Short by ' + peso((totalC - cashC) / 100); note.className = 'change-note short'; }

  // Over the ceiling: say so here and hold the button, rather than letting the
  // cashier press Charge and take a refusal from the server in front of the
  // customer. The server check is still the one that decides.
  const dn = $('#discNote');
  if (dn) {
    dn.textContent = t.over
      ? 'Over the ' + t.over.cap + '% limit' + (t.over.name ? ' on ' + t.over.name : '') +
        ' — the most you can take off ' + (t.over.name ? 'that item' : 'the bill') +
        ' is ' + peso(t.over.max) + '.'
      : t.anyLineDisc
        ? 'Per-item discounts are applied below. The whole-bill discount is unavailable while any item has its own.'
        : '';
    dn.className = t.over ? 'change-note short' : 'change-note';
  }

  // create_order() ignores the whole-bill discount entirely once any line
  // carries its own — matching that here rather than letting a cashier set
  // both and watch the bill-level one silently do nothing at charge time.
  const dt = $('#discType');
  if (dt) {
    dt.disabled = t.anyLineDisc;
    dt.title = t.anyLineDisc ? 'Clear each item\u2019s own discount to use a whole-bill discount instead.' : '';
  }

  $('#chargeBtn').disabled = !cart.length || !!t.over;
}

/* Set, change or clear one item's own discount. Kept separate from the
   whole-bill discount modal below — this edits a single cart line and does
   not touch #discType/#discCustom, though applying one here does clear
   those (see the handler), matching create_order()'s all-or-nothing rule:
   any line discount makes the server ignore the bill-level one outright. */
function lineDiscountModal(key) {
  const line = cart.find(l => l.key === key);
  if (!line) return;
  const cur = line.discType || '0';
  const lineSub = line.price * line.qty;

  const w = openModal(
    '<div class="modal-head"><h3>Discount \u2014 ' + esc(line.name) + '</h3>' +
    '<p>Applies to this item only (' + peso(lineSub) + ' before discount). Setting one clears the ' +
    'whole-bill discount, since a bill can\u2019t carry both at once.</p></div>' +
    '<div class="modal-body">' +
    '<div class="field"><label for="ldType">Discount</label><select id="ldType">' +
    '<option value="0"' + (cur === '0' ? ' selected' : '') + '>No discount</option>' +
    '<option value="20"' + (cur === '20' ? ' selected' : '') + '>Senior / PWD \u2014 20%</option>' +
    '<option value="10"' + (cur === '10' ? ' selected' : '') + '>Staff \u2014 10%</option>' +
    '<option value="custom"' + (cur === 'custom' ? ' selected' : '') + '>Custom amount\u2026</option>' +
    '</select></div>' +
    '<div class="field' + (cur === 'custom' ? '' : ' hidden') + '" id="ldCustomField">' +
    '<label for="ldCustom">Amount (\u20B1)</label>' +
    '<input id="ldCustom" type="number" min="0" step="0.01" class="money" value="' +
    (line.discAmount || '') + '"></div>' +
    '<div class="change-note" id="ldNote" role="status" aria-live="polite"></div></div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" data-close>Cancel</button>' +
    '<button class="btn btn-primary" data-ok>Apply</button></div>');

  const typeSel = w.querySelector('#ldType');
  const customField = w.querySelector('#ldCustomField');
  const customInput = w.querySelector('#ldCustom');
  const note = w.querySelector('#ldNote');
  const cap = db.settings && db.settings.discount_max_pct != null ? num(db.settings.discount_max_pct) : 100;
  const lineSubC = c(line.price) * line.qty;

  function refresh() {
    customField.classList.toggle('hidden', typeSel.value !== 'custom');
    if (typeSel.value === 'custom' && cap < 100 && lineSubC > 0) {
      const maxC = Math.round(lineSubC * cap / 100);
      const discC = Math.min(lineSubC, Math.max(0, c(customInput.value)));
      if (discC > maxC) {
        note.textContent = 'Over the ' + cap + '% limit \u2014 the most you can take off this item is ' + peso(maxC / 100) + '.';
        note.className = 'change-note short';
        return;
      }
    }
    note.textContent = ''; note.className = 'change-note';
  }
  typeSel.addEventListener('change', refresh);
  customInput.addEventListener('input', refresh);
  refresh();

  w.querySelector('[data-close]').addEventListener('click', closeModal);
  w.querySelector('[data-ok]').addEventListener('click', () => {
    const type = typeSel.value;
    const amt = Math.max(0, Number(customInput.value) || 0);
    if (type === 'custom' && cap < 100 && lineSubC > 0) {
      const maxC = Math.round(lineSubC * cap / 100);
      const discC = Math.min(lineSubC, c(amt));
      if (discC > maxC) return toast('That is over the ' + cap + '% limit for this item.', 'err');
    }
    line.discType = type;
    line.discAmount = type === 'custom' ? amt : 0;

    // The whole-bill discount and any item's own discount can't both apply
    // at charge time — create_order() would simply ignore the bill-level
    // one, which is worse than never letting the two coexist on screen.
    if (type !== '0' && $('#discType') && $('#discType').value !== '0') {
      $('#discType').value = '0';
      $('#discCustom').classList.add('hidden');
      $('#discCustom').value = '';
      toast('Whole-bill discount cleared \u2014 this item keeps its own instead.', '');
    }

    cartChanged();
    closeModal();
    renderTicket();
  });
}

const DISC_LABEL = { '20': 'Senior / PWD 20%', '10': 'Staff 10%', 'custom': 'Custom' };

/* What the cashier is about to commit to, frozen at the moment they press
   Charge. The confirmation is read from this rather than from the live inputs,
   so a stray tap behind the modal cannot change what actually gets charged. */
function chargeSnapshot() {
  const t = billPreview();
  // create_order() ignores p_discount_type/p_discount_amount the moment any
  // line carries its own — sending them anyway is harmless, but the snapshot
  // reflects what will actually be charged, same as it does for everything
  // else here.
  const type = t.anyLineDisc ? '0' : $('#discType').value;
  return {
    lines: cart.map(l => ({
      id: l.id, name: l.name, size: l.size, price: l.price, qty: l.qty,
      discType: l.discType || '0', discAmount: Number(l.discAmount) || 0
    })),
    discType: type,
    discLabel: t.anyLineDisc ? 'Per item' : (DISC_LABEL[type] || ''),
    discAmount: Number($('#discCustom').value) || 0,
    mode: $('#payMode').value,
    cash: Number($('#payCash').value) || 0,
    sub: t.sub, disc: t.disc, total: t.total, anyLineDisc: t.anyLineDisc
  };
}

/* Charging is the one thing at this till that cannot be quietly undone: the
   bill number is spent the moment it goes through, the sequence must not have
   gaps, and reversing it needs an admin's password. So it gets a look before
   it happens — and the read-back doubles as the cash check, since the change
   due is the number most likely to be got wrong in a hurry. */
/* Whether this bill gets a read-back. Set centrally so every terminal behaves
   the same way. 'over' still confirms any discounted bill whatever its size —
   a mistyped discount is precisely the mistake the read-back is here to catch,
   and it is the one that is hardest to spot afterwards. */
function needsConfirm(s) {
  const st = db.settings || {};
  const mode = st.confirm_charge || 'always';
  if (mode === 'never') return false;
  if (mode === 'over') return s.disc > 0 || s.total >= num(st.confirm_charge_over);
  return true;
}

function charge() {
  if (!cart.length) return;
  const s = chargeSnapshot();
  if (!needsConfirm(s)) return doCharge(s);
  const count = s.lines.reduce((a, l) => a + l.qty, 0);
  const isCash = s.mode === 'Cash';
  const short = isCash && s.cash > 0 && s.cash < s.total;
  const noCash = isCash && !s.cash;

  const row = (lbl, val, cls) =>
    '<div class="cf-row' + (cls ? ' ' + cls : '') + '"><span>' + lbl + '</span><span>' + val + '</span></div>';

  const w = openModal(
    '<div class="modal-head"><h3>Charge ' + peso(s.total) + '?</h3>' +
    '<p>' + count + ' item' + (count === 1 ? '' : 's') + ', rung up by ' + esc(session.name) + '. ' +
    'The bill number is taken the moment you confirm, and only an admin can void it afterwards.</p></div>' +
    '<div class="modal-body">' +
    '<div class="cf-lines">' + s.lines.map(l => {
      const ld = l.discType !== '0' ? lineDiscountPeso(l) : 0;
      return '<div class="cf-line"><span class="q">' + l.qty + '\u00d7</span>' +
      '<span class="n">' + esc(l.name) +
      (l.size ? ' <em>' + esc(l.size) + '</em>' : '') +
      (ld ? ' <em>' + esc(LINE_DISC_LABEL[l.discType] || '') + ' \u2212' + peso(ld) + '</em>' : '') + '</span>' +
      '<span class="a">' + peso(l.price * l.qty - ld) + '</span></div>';
    }).join('') +
    '</div>' +
    '<div class="cf-tot">' +
    row('Subtotal', peso(s.sub)) +
    (s.disc > 0 ? row(esc(s.discLabel || 'Discount'), '\u2212' + peso(s.disc), 'disc') : '') +
    row('Total', peso(s.total), 'grand') +
    row('Paying by', esc(s.mode)) +
    (isCash && s.cash ? row('Cash received', peso(s.cash)) : '') +
    (isCash && s.cash >= s.total && s.cash
      ? row('Change', peso(s.cash - s.total), 'change') : '') +
    '</div>' +
    (short
      ? '<div class="warn-box">Cash received is ' + peso(s.total - s.cash) +
        ' short of the total. Fix the amount, or switch the payment method.</div>'
      : noCash
        ? '<div class="warn-box">No cash amount entered, so no change will be worked out for you. ' +
          'That is fine for exact money — go back and type it in if you want the change calculated.</div>'
        : '') +
    '</div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" data-close>Go back</button>' +
    '<button class="btn btn-primary" data-ok' + (short ? ' disabled' : '') + '>Charge ' + peso(s.total) + '</button></div>');

  w.querySelector('[data-close]').addEventListener('click', closeModal);
  const go = w.querySelector('[data-ok]');
  if (!short) {
    setTimeout(() => go.focus(), 60);
    go.addEventListener('click', () => { closeModal(); doCharge(s); });
  }
}

/* The reference for the charge currently in flight. Generated once and kept
   across retries, so a second attempt after a dropped connection returns the
   bill the first attempt already wrote instead of charging the meal twice.
   Cleared on success, and on any refusal the database actually answered —
   those wrote nothing, so the next attempt is genuinely new. Also cleared
   whenever the cart changes, since a different cart is a different bill. */
let chargeRef = null;

function newChargeRef() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Older WebViews on cheap Android tills do not have randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function doCharge(s) {
  const btn = $('#chargeBtn');
  if (!chargeRef) chargeRef = newChargeRef();
  busy(btn, true, 'Charging…');
  try {
    const { data, error } = await sb.rpc('create_order', {
      p_lines: s.lines.map(l => ({
        item_id: l.id, qty: l.qty,
        discount_type: l.discType, discount_amount: l.discAmount
      })),
      p_discount_type: s.discType,
      p_discount_amount: s.discAmount,
      p_mode: s.mode,
      p_cash: s.cash,
      p_client_ref: chargeRef
    });
    if (error) {
      // "Nothing was charged" is only true when the database answered. If the
      // request never made it back — dropped wifi, a timeout, the tab going to
      // sleep mid-request — the bill may well have committed, taken a number
      // and incremented the counter. Telling a cashier nothing happened is how
      // the same meal gets charged twice, and the second one looks legitimate.
      // A PostgREST or Postgres refusal carries a code; a dead connection does
      // not.
      const answered = !!(error.code || error.status);
      if (!answered) {
        // Keep chargeRef. Pressing Charge again sends the same reference, and
        // if the first attempt did commit the database hands that bill back
        // rather than writing a second one.
        return toast('The connection dropped before the till heard back. Press Charge ' +
          'again — if the bill already went through, the same one comes back rather ' +
          'than a second copy.', 'err');
      }
      chargeRef = null;   // the database answered and refused; nothing was written
      fail(error, "The bill didn't go through. Nothing was charged.");
      return;
    }

    const sale = Array.isArray(data) ? data[0] : data;
    const { data: full } = await sb.from('sales').select('*, sale_lines(*)').eq('id', sale.id).single();

    // The re-read is for the stored line rows, which carry the prices the
    // database actually charged. If it fails the sale still happened, so fall
    // back to the cart rather than printing a bill with no dishes on it — the
    // totals below come from `sale` either way, so a stale cart cannot change
    // what the receipt says was owed.
    const storedLines = (full && full.sale_lines) || [];
    const printable = {
      ...(full || sale),
      lines: storedLines.length
        ? storedLines.map(l => ({ ...l, price: num(l.price), line_total: num(l.line_total) }))
        : s.lines.map(l => {
            const ld = l.discType !== '0' ? lineDiscountPeso(l) : 0;
            return {
              name: l.name, size: l.size, price: num(l.price), qty: l.qty,
              line_total: num(l.price) * l.qty - ld,
              discount_label: ld ? (LINE_DISC_LABEL[l.discType] || '') : ''
            };
          })
    };

    printBill(printable);
    chargeRef = null;
    cart = [];
    $('#payCash').value = '';
    $('#discType').value = '0';
    $('#discCustom').classList.add('hidden');
    $('#discCustom').value = '';
    toast('Bill ' + printable.no + ' charged — ' + peso(num(printable.total)), 'ok');
  } finally {
    busy(btn, false);
    renderTicket();
  }
}

/* ------------------------------------------------------------------
   7. PRINTED BILL
   ------------------------------------------------------------------ */
function billHTML(s) {
  const st = db.settings || {};
  const rows = (s.lines || []).map(l =>
    '<tr><td>' + esc(l.qty + '× ' + l.name + (l.size ? ' (' + l.size + ')' : '') +
      (l.discount_label ? ' \u2014 ' + l.discount_label : '')) + '</td>' +
    '<td class="r">' + peso(l.line_total) + '</td></tr>').join('');
  const rate = num(s.vat_rate);
  /* The business name comes from Settings. It used to be two hardcoded lines
     here, which meant the Shop name field on the Settings page saved happily
     and changed nothing — and the document it failed to change is the one
     whose own footer calls it the official bill. They happen to agree today,
     so the mismatch would only have surfaced the day somebody edited it.
     Falls back to the original wording if the setting is ever emptied. */
  const shopName = (st.name || '').trim();
  return '<div class="bill">' +
    '<div class="ctr">' +
    (shopName
      ? '<div class="bname">' + esc(shopName) + '</div>'
      : '<div class="bname">FREDDY\'S</div><div>SEAFOOD GRILL &amp; RESTAURANT</div>') +
    '<div>' + esc(st.addr || '') + '</div>' +
    '<div>Tel ' + esc(st.phone || '') + '</div></div>' +
    '<div class="sep"></div>' +
    '<table><tr><td>Bill no.</td><td class="r">' + esc(s.no) + '</td></tr>' +
    '<tr><td>Date</td><td class="r">' + fmtDT(s.ts) + '</td></tr>' +
    '<tr><td>Cashier</td><td class="r">' + esc(s.cashier_name) + '</td></tr></table>' +
    '<div class="sep"></div><table>' + rows + '</table><div class="sep"></div>' +
    '<table><tr><td>Subtotal</td><td class="r">' + peso(s.subtotal) + '</td></tr>' +
    (num(s.discount) ? '<tr><td>Discount' + (s.discount_label ? ' (' + esc(s.discount_label) + ')' : '') +
      '</td><td class="r">−' + peso(s.discount) + '</td></tr>' : '') +
    '<tr><td class="big">TOTAL</td><td class="r big">' + peso(s.total) + '</td></tr>' +
    '<tr><td>' + esc(s.mode) + '</td><td class="r">' + peso(s.cash) + '</td></tr>' +
    (num(s.change_due) ? '<tr><td>Change</td><td class="r">' + peso(s.change_due) + '</td></tr>' : '') +
    '</table><div class="sep"></div>' +
    (rate ? '<table><tr><td>VAT-able sale</td><td class="r">' + peso(s.vatable) + '</td></tr>' +
      '<tr><td>VAT (' + rate + '% incl.)</td><td class="r">' + peso(s.vat) + '</td></tr></table><div class="sep"></div>' : '') +
    '<div class="ctr">' + esc(st.hours || '') + '<br>' + esc(st.footer || '') + '</div>' +
    (s.status === 'void'
      ? '<div class="sep"></div><div class="ctr big">*** VOIDED ***</div>' +
        (s.voided_by_name ? '<div class="ctr">Voided by ' + esc(s.voided_by_name) +
          (s.voided_at ? '<br>' + fmtDT(s.voided_at) : '') + '</div>' : '')
      : '') +
    '</div>';
}

function printBill(sale) {
  const area = $('#printArea');
  if (!area) return;
  area.innerHTML = billHTML(sale);
  setTimeout(() => window.print(), 60);

  /* Emptied once the dialog closes. Left in place, the last customer's bill
     stays in the DOM, and the next Ctrl+P from anywhere in the app prints
     that stale bill instead of the page. onafterprint does not fire on every
     browser, so the timeout is the backstop. */
  const clear = () => { area.innerHTML = ''; };
  window.addEventListener('afterprint', clear, { once: true });
  setTimeout(clear, 8000);
}

function previewBill(sale) {
  const w = openModal(
    '<div class="modal-head"><h3>Bill ' + esc(sale.no) + '</h3>' +
    '<p>' + fmtDT(sale.ts) + ' · ' + esc(sale.cashier_name) + '</p></div>' +
    '<div class="modal-body" style="background:#fff">' + billHTML(sale) + '</div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" data-close>Close</button>' +
    '<button class="btn btn-primary" data-print>Print this bill</button></div>');
  w.querySelector('[data-close]').addEventListener('click', closeModal);
  w.querySelector('[data-print]').addEventListener('click', () => { closeModal(); printBill(sale); });
}

/* ------------------------------------------------------------------
   8. INVENTORY
   ------------------------------------------------------------------ */
function fillCatSelects() {
  // c.id is escaped for the same reason c.name is. It is a text primary key
  // the client slugifies to [a-z0-9-] on the way in, but the client is not
  // the gate: categories_write only checks is_admin(), there is no format
  // constraint on the column, and authenticated holds INSERT. A category id
  // written straight through PostgREST can carry a quote, and this string
  // lands inside an attribute.
  const opts = '<option value="all">All categories</option>' +
    db.categories.map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('');
  const el = $('#invCat');
  if (!el) return;
  const keep = el.value;
  el.innerHTML = opts;
  if (keep) el.value = keep;
}

/* `words` marks a card whose value is a name rather than a figure — the
   monospace display size is built for ₱12,480.00, not for
   "Sinigang na Maya-Maya — Family size". */
function stat(lbl, val, foot, cls, words) {
  return '<div class="stat ' + (cls || '') + '"><div class="lbl">' + esc(lbl) + '</div>' +
    '<div class="val' + (words ? ' words' : '') + '">' + esc(val) + '</div>' +
    '<div class="foot">' + esc(foot) + '</div></div>';
}

function renderInventory() {
  if (!$('#invBody')) return;
  const q = $('#invSearch').value.trim().toLowerCase();
  const cat = $('#invCat').value;
  const lvl = $('#invFilter').value;

  const rows = db.items.filter(i => {
    const t = totalsFor(i.id);
    if (cat !== 'all' && i.cat !== cat) return false;
    if (q && !itemLabel(i).toLowerCase().includes(q)) return false;
    if (lvl === 'available' && !i.active) return false;
    if (lvl === 'ordered' && t.qty <= 0) return false;
    if (lvl === 'never' && t.qty > 0) return false;
    if (lvl === 'off' && i.active) return false;
    return true;
  }).sort((a, b) => totalsFor(b.id).qty - totalsFor(a.id).qty);

  const all = db.items;
  const dishes = all.reduce((n, i) => n + totalsFor(i.id).qty, 0);
  const revenue = all.reduce((n, i) => n + totalsFor(i.id).revenue, 0);
  const never = all.filter(i => i.active && totalsFor(i.id).qty <= 0).length;
  const best = all.slice().sort((a, b) => totalsFor(b.id).qty - totalsFor(a.id).qty)[0];
  const bestQty = best ? totalsFor(best.id).qty : 0;

  $('#invStats').innerHTML = [
    stat('Items on file', all.length, all.filter(i => i.active).length + ' currently on the menu', 'pine'),
    stat('Dishes ordered', dishes, 'across every bill still standing', ''),
    stat('Best seller', bestQty ? itemLabel(best) : '\u2014', bestQty ? bestQty + ' ordered' : 'nothing ordered yet', bestQty ? 'pine' : '', true),
    stat('Never ordered', never, 'on the menu, no takers yet', never ? 'warn' : '')
  ].join('');

  $('#invBody').innerHTML = rows.length ? rows.map(i => {
    const t = totalsFor(i.id);
    const share = dishes ? Math.round((t.qty / dishes) * 100) : 0;
    // Anything on the menu is orderable, always. There is no count to run out
    // of, so the only two states a dish can be in are on and off.
    const badge = i.active
      ? '<span class="pill pill-ok">Available</span>'
      : '<span class="pill pill-out">Off the menu</span>';
    return '<tr' + (i.active ? '' : ' class="inactive"') + '>' +
      '<td data-label="Item"><strong>' + esc(i.name) + '</strong>' +
      (i.size ? '<br><span style="font-size:.74rem;color:var(--muted)">' + esc(i.size) + '</span>' : '') + '</td>' +
      '<td data-label="Category">' + esc(catName(i.cat)) + '</td>' +
      '<td class="num" data-label="Price">' + peso(i.price) + '</td>' +
      '<td class="num" data-label="Qty ordered"><strong>' + t.qty + '</strong>' +
      (t.qty > 0 && share > 0 ? '<br><span style="font-size:.72rem;color:var(--muted)">' + share + '% of orders</span>' : '') +
      (t.voided ? '<br><span style="font-size:.72rem;color:var(--muted)">' + t.voided + ' voided</span>' : '') + '</td>' +
      '<td class="num" data-label="Bills">' + t.orders + '</td>' +
      '<td class="num" data-label="Sales">' + peso(t.revenue) + '</td>' +
      '<td data-label="Last ordered">' + (t.last
        ? '<span style="font-size:.78rem">' + fmtDT(t.last) + '</span>'
        : '<span style="color:var(--muted);font-size:.78rem">—</span>') + '</td>' +
      '<td data-label="Status">' + badge + '</td></tr>';
  }).join('') : '<tr><td colspan="8"><div class="empty">No items match those filters.</div></td></tr>';
}

/* ------------------------------------------------------------------
   9. SALES
   ------------------------------------------------------------------ */
function renderSales() {
  if (!$('#salesBody')) return;
  const cSel = $('#salesCashier');
  const names = Array.from(new Set(db.sales.map(s => s.cashier_name).filter(Boolean)));
  const keep = cSel.value;
  cSel.innerHTML = '<option value="all">All cashiers</option>' +
    names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
  if (keep) cSel.value = keep;

  const from = $('#salesFrom').value, to = $('#salesTo').value, who = cSel.value;
  const rows = db.sales.filter(s => {
    // manilaDay, not a slice of the UTC string: the two disagree for every
    // bill rung before eight in the morning, and the bill number follows
    // Manila.
    const d = manilaDay(s.ts);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (who && who !== 'all' && s.cashier_name !== who) return false;
    return true;
  });

  const paid = rows.filter(s => s.status === 'paid');
  $('#salesStats').innerHTML = [
    stat('Bills', paid.length, (rows.length - paid.length) + ' voided', 'pine'),
    stat('Sales', peso(paid.reduce((a, s) => a + s.total, 0)), 'after discounts', ''),
    stat('Discounts given', peso(paid.reduce((a, s) => a + s.discount, 0)), 'senior, PWD, staff', ''),
    stat('Dishes sold', paid.reduce((a, s) => a + s.lines.reduce((x, l) => x + l.qty, 0), 0), 'across the filtered period', '')
  ].join('');

  /* An unfiltered view stops at SALES_PAGE. Silence there reads as "that is
     all the bills", so say which it is — otherwise the only clue is a total
     that feels low. */
  const cap = $('#salesCap');
  if (cap) {
    const capped = db.salesTruncated && !from && !to;
    cap.hidden = !capped;
    if (capped) cap.textContent =
      'Showing the most recent ' + rows.length + ' bills. Older ones are still on ' +
      'record — pick a date range to see them.';
  }

  $('#salesBody').innerHTML = rows.length ? rows.map(s =>
    '<tr><td data-label="Bill no."><span class="mono">' + esc(s.no) + '</span>' +
    (s.status === 'void' ? ' <span class="pill pill-void">Void</span>' +
      (s.voided_by_name ? '<br><span style="font-size:.72rem;color:var(--muted)">voided by ' +
        esc(s.voided_by_name) + '</span>' : '') : '') + '</td>' +
    '<td data-label="Date &amp; time">' + fmtDT(s.ts) + '</td>' +
    '<td data-label="Cashier">' + esc(s.cashier_name) + '</td>' +
    '<td class="num" data-label="Items">' + s.lines.reduce((a, l) => a + l.qty, 0) + '</td>' +
    '<td class="num" data-label="Total">' + peso(s.total) + '</td>' +
    '<td data-label="Payment">' + esc(s.mode) + '</td>' +
    '<td class="num" data-label="Actions"><div class="row-actions">' +
    '<button class="btn btn-ghost btn-sm" data-view="' + s.id + '">Bill</button>' +
    (s.status === 'paid'
      ? '<button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-void="' + s.id + '">Void</button>' : '') +
    '</div></td></tr>').join('')
    : '<tr><td colspan="7"><div class="empty">No bills in that range yet.</div></td></tr>';

  $$('#salesBody [data-view]').forEach(b => b.addEventListener('click', () =>
    previewBill(db.sales.find(s => s.id === b.dataset.view))));
  $$('#salesBody [data-void]').forEach(b => b.addEventListener('click', () => voidSale(b.dataset.void)));
}

/* A void is the one action that makes money disappear from the books, so it
   asks for an admin PIN every single time — from a cashier, and from an admin
   standing at their own till. A terminal left open at the counter is not
   authority, and a PIN an owner gets to skip is a PIN nobody takes seriously.

   Six digits, set by each admin for themselves under Account. The PIN is
   never checked here: it goes to void_sale_with_pin(), which bcrypt-matches
   it against every admin's hash and records the one it belongs to as the
   approver. The signed-in operator is recorded alongside, so the bill keeps
   both answers — who allowed it, and whose terminal it happened on.

   Note what is no longer here: the second Supabase client, the throwaway
   sign-in, the email box. A cashier's session is untouched because nothing
   ever signs anybody in. */
function voidSale(id) {
  const s = db.sales.find(x => x.id === id);
  if (!s) return;
  const dishes = s.lines.reduce((a, l) => a + l.qty, 0);

  const w = openModal(
    '<div class="modal-head"><h3>Void bill ' + esc(s.no) + '?</h3>' +
    '<p>' + peso(s.total) + ' comes out of the sales figures, and the ' + dishes +
    (dishes === 1 ? ' dish on it stops' : ' dishes on it stop') + ' counting in Inventory.</p></div>' +
    '<div class="modal-body">' +
    '<div class="warn-box">The bill stays in the list marked <strong>Void</strong> so the numbering never has a gap — that\'s what an auditor will look for. ' +
    'Their next question is who approved it, so the admin whose PIN is entered below is the name kept with the bill.</div>' +
    '<div class="field"><label for="vdPin">Admin PIN</label>' +
    '<input id="vdPin" type="password" inputmode="numeric" autocomplete="off" ' +
    'maxlength="6" placeholder="Six digits" ' +
    'style="font-family:\'IBM Plex Mono\',monospace;letter-spacing:.4em;text-align:center;font-size:1.1rem"></div>' +
    '<p style="font-size:.78rem;color:var(--muted);line-height:1.6;margin-top:-2px">' +
    (isAdmin()
      ? 'Yours, or another admin\'s if they are approving this one. Whoever\'s PIN it is gets the name on the bill.'
      : 'Ask an admin to type theirs. It does not sign you out of this terminal.') +
    '</p></div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" data-close>Keep it</button>' +
    '<button class="btn btn-danger" data-ok>Approve and void</button></div>');

  w.querySelector('[data-close]').addEventListener('click', closeModal);
  const pin = w.querySelector('#vdPin');
  const go = w.querySelector('[data-ok]');

  // Digits only, so a stray letter never reaches the RPC and burns one of the
  // five attempts before the lockout.
  pin.addEventListener('input', () => { pin.value = pin.value.replace(/\D/g, '').slice(0, 6); });
  pin.addEventListener('keydown', e => { if (e.key === 'Enter') go.click(); });
  setTimeout(() => pin.focus(), 60);

  go.addEventListener('click', async e => {
    const code = pin.value.trim();
    if (!/^\d{6}$/.test(code)) return toast('Enter the six-digit admin PIN.', 'err');

    busy(e.target, true, 'Voiding…');
    const { data, error } = await sb.rpc('void_sale_with_pin', { p_sale_id: id, p_pin: code });
    busy(e.target, false);

    // Structural problems still raise: not signed in, no such bill, already
    // void, locked out. Those arrive as `error`.
    if (error) {
      pin.value = ''; pin.focus();
      return fail(error, "Couldn't void that bill.");
    }

    // A rejected PIN is a verdict, not an exception. It has to be, or the
    // failed-attempt row the lockout counts would roll back with the raise —
    // which is exactly how the throttle came to be doing nothing at all.
    if (!data || data.ok !== true) {
      pin.value = ''; pin.focus();
      const left = data && data.attempts_left;
      const warn = typeof left === 'number' && left > 0 && left <= 2
        ? ' ' + left + (left === 1 ? ' try left' : ' tries left') + ' before this till locks for fifteen minutes.'
        : '';
      return toast(((data && data.message) || "That PIN wasn't accepted.") + warn, 'err');
    }

    const voided = data.sale || {};

    closeModal();
    await Promise.all([loadSales(), PAGE === 'inv' ? loadOrderTotals() : Promise.resolve()]);
    renderSales();
    if (PAGE === 'inv') renderInventory();
    toast('Bill ' + s.no + ' voided by ' + ((voided && voided.voided_by_name) || 'an admin') + '.', 'ok');
  });
}

/* ------------------------------------------------------------------
   10. MENU MANAGER
   ------------------------------------------------------------------ */
function renderMenuManager() {
  if (!$('#mmGrid')) return;
  const q = $('#mmSearch').value.trim().toLowerCase();

  const { html, shown } = menuSections(mmCat, q, i =>
    '<div class="item mm-item' + (i.active ? '' : ' out') + '">' + itemCardFace(i) +
    '<div class="item-actions">' +
    '<button class="btn btn-ghost btn-sm" data-edit="' + i.id + '">Edit</button>' +
    '<button class="btn btn-ghost btn-sm" data-tog="' + i.id + '">' +
    (i.active ? 'Take off' : 'Put back') + '</button>' +
    '<button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-del="' + i.id + '">Delete</button>' +
    '</div></div>',
    {
      showEmpty: true,
      headAction: c => db.categories.length > 1
        ? '<button class="cat-del" data-delcat="' + esc(c.id) + '" ' +
          'title="Delete the ' + esc(c.name) + ' category">Delete category</button>'
        : ''
    });

  // An empty category renders a section but contributes no items, so `shown`
  // stays 0 — fall back to the real markup rather than the empty state.
  $('#mmGrid').innerHTML = (shown || html) ? html :
    '<div class="empty">No items match. Add one with <strong>+ Add item</strong>.</div>';

  $$('#mmGrid [data-edit]').forEach(b => b.addEventListener('click', () => itemForm(b.dataset.edit)));
  $$('#mmGrid [data-tog]').forEach(b => b.addEventListener('click', async () => {
    const i = db.items.find(x => x.id === b.dataset.tog);
    busy(b, true, '\u2026');
    const { error } = await sb.from('items').update({ active: !i.active }).eq('id', i.id);
    busy(b, false);
    if (error) return fail(error, "Couldn't change that item.");
    i.active = !i.active;
    renderMenuManager(); renderMenuGrid();
    toast(itemLabel(i) + (i.active
      ? ' is back on the menu and can be ordered again.'
      : ' is off the menu until you put it back.'), 'ok');
  }));
  $$('#mmGrid [data-del]').forEach(b => b.addEventListener('click', () => deleteItem(b.dataset.del)));
  $$('#mmGrid [data-delcat]').forEach(b => b.addEventListener('click', () => deleteCategory(b.dataset.delcat)));
}

function itemForm(id) {
  const i = id ? db.items.find(x => x.id === id) : null;
  const catOpts = db.categories.map(c =>
    '<option value="' + esc(c.id) + '"' + (i && i.cat === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
  const w = openModal(
    '<div class="modal-head"><h3>' + (i ? 'Edit item' : 'Add item') + '</h3>' +
    '<p>' + (i
      ? 'Changes appear on every terminal straight away.'
      : 'It goes onto the menu available, and appears on every terminal straight away.') +
    '</p></div>' +
    '<div class="modal-body">' +
    '<div class="field"><label for="fName">Name</label><input id="fName" value="' + esc(i ? i.name : '') + '" required></div>' +
    '<div class="grid2">' +
    '<div class="field"><label for="fSize">Size or serving <span style="text-transform:none;letter-spacing:0;color:var(--muted);font-weight:400">(optional)</span></label>' +
    '<input id="fSize" placeholder="e.g. Family size, 1–2 pax" value="' + esc(i ? i.size : '') + '"></div>' +
    '<div class="field"><label for="fCat">Category</label><select id="fCat">' + catOpts + '</select></div></div>' +
    '<div class="field"><label for="fPrice">Price (₱)</label><input id="fPrice" type="number" min="0" step="0.01" class="money" value="' + (i ? i.price : '') + '" required></div>' +
    '<p style="font-size:.78rem;color:var(--muted);line-height:1.6">' +
    (i && !i.active
      ? 'This one is currently <strong>off the menu</strong>. Use <strong>Put back</strong> on its card to make it orderable again.'
      : 'Anything on the menu can be ordered any number of times — there is no count to run down. ' +
        'If the kitchen runs out for the day, use <strong>Take off</strong> on its card and put it back tomorrow.') +
    '</p></div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" data-close>Cancel</button>' +
    '<button class="btn btn-primary" data-save>' + (i ? 'Save changes' : 'Add to menu') + '</button></div>');

  w.querySelector('[data-close]').addEventListener('click', closeModal);
  w.querySelector('[data-save]').addEventListener('click', async e => {
    const name = w.querySelector('#fName').value.trim();
    const price = Number(w.querySelector('#fPrice').value);
    if (!name) return toast('Give the item a name.', 'err');
    if (!(price >= 0)) return toast('Enter a price.', 'err');
    const payload = {
      name,
      size: w.querySelector('#fSize').value.trim(),
      cat: w.querySelector('#fCat').value,
      price: Math.round(price * 100) / 100
    };
    busy(e.target, true, 'Saving…');
    const { error } = i
      ? await sb.from('items').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', i.id)
      : await sb.from('items').insert({ ...payload, active: true });
    busy(e.target, false);
    if (error) {
      return fail(error, /duplicate|unique/i.test(error.message || '')
        ? 'There is already an item with that name and size.' : "Couldn't save that item.");
    }
    closeModal();
    await loadCore(); renderMmCatBar(); renderMenuManager();
    toast(i ? 'Saved ' + name + '.' : name + ' added to the menu and ready to order.', 'ok');
  });
}

function deleteItem(id) {
  const i = db.items.find(x => x.id === id);
  const w = openModal(
    '<div class="modal-head"><h3>Delete ' + esc(itemLabel(i)) + '?</h3>' +
    '<p>This removes it from the menu entirely.</p></div>' +
    '<div class="modal-body"><div class="warn-box">Past bills keep their own copy of the name and price, so your sales totals stay correct — the line just stops pointing at a menu item.<br><br>' +
    '<strong>Inventory forgets it, though.</strong> The order counts are read back through the menu item, so deleting this one takes ' +
    esc(String(totalsFor(id).qty)) + ' ordered off that page for good.<br><br>' +
    'If you only want it off the menu for a while, use <strong>Take off</strong> instead — that keeps the whole order history and just crosses it out on the order screen.</div></div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" data-close>Cancel</button>' +
    '<button class="btn btn-danger" data-ok>Delete it</button></div>');
  w.querySelector('[data-close]').addEventListener('click', closeModal);
  w.querySelector('[data-ok]').addEventListener('click', async e => {
    busy(e.target, true, 'Deleting…');
    const { error } = await sb.from('items').delete().eq('id', id);
    busy(e.target, false);
    if (error) return fail(error, "Couldn't delete that item.");
    cart = cart.filter(l => l.id !== id);
    cartChanged();
    closeModal();
    await loadCore(); renderMenuManager();
    toast('Deleted.', 'ok');
  });
}

/* Deleting a heading is not the same as deleting food. If the category still
   has dishes, the only offer is to re-file them somewhere else — the server
   does the move and the delete in one transaction, so there is no state where
   the dishes have moved but the category survived. Nothing here can remove a
   dish; that stays a deliberate, one-at-a-time act on the item card. */
function deleteCategory(id) {
  const c = db.categories.find(x => x.id === id);
  if (!c) return;
  const items = db.items.filter(i => i.cat === id);
  const others = db.categories.filter(x => x.id !== id);

  if (!others.length) {
    return toast('This is the last category — the menu needs at least one.', 'err');
  }

  const moveUI = items.length
    ? '<div class="warn-box"><strong>' + esc(c.name) + ' still has ' + items.length +
      ' dish' + (items.length === 1 ? '' : 'es') + ' in it.</strong> They have to go somewhere. ' +
      'Pick a heading and they will be re-filed as the category is removed — one step, so they ' +
      'cannot be left stranded.<br><br>Past bills keep their own copy of the name and price, so ' +
      'nothing already printed is affected.</div>' +
      '<div class="field"><label for="dcMove">Move the ' + items.length + ' dish' +
      (items.length === 1 ? '' : 'es') + ' to</label><select id="dcMove">' +
      others.map(o => '<option value="' + esc(o.id) + '">' + esc(o.name) + '</option>').join('') +
      '</select></div>' +
      '<p style="font-size:.78rem;color:var(--muted);line-height:1.6">' +
      'Want them gone instead of moved? Delete the dishes individually first, then come back here.</p>'
    : '<div class="warn-box">Nothing is filed under ' + esc(c.name) + ', so this only removes the ' +
      'heading itself. No dish is touched.</div>';

  const w = openModal(
    '<div class="modal-head"><h3>Delete the ' + esc(c.name) + ' category?</h3>' +
    '<p>It disappears from the order screen and this page on every terminal.</p></div>' +
    '<div class="modal-body">' + moveUI + '</div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" data-close>Keep it</button>' +
    '<button class="btn btn-danger" data-ok>' +
    (items.length ? 'Move and delete' : 'Delete category') + '</button></div>');

  w.querySelector('[data-close]').addEventListener('click', closeModal);
  w.querySelector('[data-ok]').addEventListener('click', async e => {
    const moveSel = w.querySelector('#dcMove');
    busy(e.target, true, items.length ? 'Moving\u2026' : 'Deleting\u2026');
    const { data, error } = await sb.rpc('delete_category', {
      p_id: id, p_move_to: moveSel ? moveSel.value : null
    });
    busy(e.target, false);
    if (error) return fail(error, "Couldn't delete that category.");

    closeModal();
    if (mmCat === id) mmCat = 'all';       // the filter was pointing at it
    if (posCat === id) posCat = 'all';
    await loadCore();
    renderMmCatBar(); renderMenuManager();
    const moved = (data && data.moved) || 0;
    toast(moved
      ? esc(c.name) + ' deleted — ' + moved + ' dish' + (moved === 1 ? '' : 'es') +
        ' moved to ' + ((data && data.moved_to) || 'another category') + '.'
      : esc(c.name) + ' deleted.', 'ok');
  });
}

function addCategory() {
  const w = openModal(
    '<div class="modal-head"><h3>Add category</h3><p>A new section on the order screen and the menu manager.</p></div>' +
    '<div class="modal-body"><div class="field"><label for="cName">Category name</label>' +
    '<input id="cName" placeholder="e.g. Pulutan, Extras"></div></div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" data-close>Cancel</button>' +
    '<button class="btn btn-primary" data-ok>Add category</button></div>');
  w.querySelector('[data-close]').addEventListener('click', closeModal);
  w.querySelector('[data-ok]').addEventListener('click', async e => {
    const name = w.querySelector('#cName').value.trim();
    if (!name) return toast('Give the category a name.', 'err');
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('c' + Date.now());
    busy(e.target, true, 'Adding…');
    const { error } = await sb.from('categories').insert({
      id, name, sort: (db.categories.length ? Math.max(...db.categories.map(c => c.sort || 0)) : 0) + 1
    });
    busy(e.target, false);
    if (error) {
      return fail(error, /duplicate|unique|primary/i.test(error.message || '')
        ? "There's already a category with that name." : "Couldn't add that category.");
    }
    closeModal();
    await loadCore(); renderMmCatBar(); renderMenuManager();
    toast(name + ' added.', 'ok');
  });
}

/* ------------------------------------------------------------------
   11. STAFF
   ------------------------------------------------------------------ */
const PERMS = [
  ['Operate at all — needs admin approval first', true, true],
  ['Take orders and charge bills', true, true],
  ['Print or reprint a bill', true, true],
  ['See what has been ordered', true, true],
  ['View the sales log', true, true],
  ['Start a void on a bill', true, true],
  ['Approve a void — admin PIN, every time', false, true],
  ['Add, edit or delete menu items', false, true],
  ['Add or delete categories', false, true],
  ['Download backups', false, true],
  ['Reset the sales log', false, true],
  ['Approve or suspend a staff account', false, true],
  ['Grant or remove admin (main admin only)', false, true]
];

function renderStaff() {
  if (!$('#permBody')) return;
  $('#permBody').innerHTML = PERMS.map(p =>
    '<tr><td data-label="Action">' + esc(p[0]) + '</td>' +
    '<td data-label="Cashier" style="text-align:center;color:' + (p[1] ? 'var(--ok)' : 'var(--muted)') + '">' + (p[1] ? '✓' : '—') + '</td>' +
    '<td data-label="Admin" style="text-align:center;color:var(--ok)">✓</td></tr>').join('');

  $('#staffBody').innerHTML = db.staff.length ? db.staff.map(u => {
    const adminRow = db.admins.find(a => a.id === u.id);
    const role = adminRow ? adminRow.role : 'user';
    const me = u.id === session.id;
    // Holding an admin row is no longer a stand-in for being approved. It used
    // to be, which is how a suspended admin could show as approved on this
    // page while is_approved() waved them through underneath.
    const approved = !!u.approved;
    const label = role === 'super_admin' ? 'Main admin' : role === 'admin' ? 'Admin' : 'Cashier';
    // A main admin can now be stepped down by another main admin. The database
    // refuses the one that would leave none, so the last one keeps no button
    // rather than being told no after the fact.
    //
    // `approved` gates promotion only. Taking admin away from somebody you
    // have just suspended is the obvious next move, and requiring approval for
    // that meant re-approving them first — handing back the access you were
    // trying to remove in order to remove it.
    const otherSupers = db.admins.filter(a => a.role === 'super_admin' && a.id !== u.id).length;
    const canChangeRole = isSuperAdmin() && !me &&
      (role === 'user'        ? approved
       : role === 'super_admin' ? otherSupers > 0
       : true);
    // Approving is any admin's job; the server refuses your own row and the
    // main admin's, so those two never get a button.
    const canApprove = isAdmin() && !me && role !== 'super_admin';
    return '<tr' + (approved ? '' : ' class="inactive"') + '>' +
      '<td data-label="Name"><strong>' + esc(u.name) + '</strong>' +
      (me ? ' <span class="pill pill-ok">You</span>' : '') +
      (approved ? '' : ' <span class="pill pill-low">Waiting</span>') +
      (approved && u.approved_by_name
        ? '<br><span style="font-size:.72rem;color:var(--muted)">approved by ' + esc(u.approved_by_name) + '</span>'
        : '') + '</td>' +
      '<td data-label="Username"><span class="mono">' + esc(u.id).slice(0, 8) + '\u2026</span></td>' +
      '<td data-label="Role"><span class="role-chip ' + (role !== 'user' ? 'role-admin' : '') + '"' +
      (role === 'user' ? ' style="background:var(--cream);color:var(--plum)"' : '') + '>' + label + '</span></td>' +
      '<td data-label="Added">' + new Date(u.created_at).toLocaleDateString('en-PH', { timeZone: MANILA, year: 'numeric', month: 'short', day: '2-digit' }) + '</td>' +
      '<td class="num" data-label="Actions"><div class="row-actions">' +
      (canApprove
        ? '<button class="btn ' + (approved ? 'btn-ghost' : 'btn-primary') + ' btn-sm"' +
          (approved ? ' style="color:var(--danger)"' : '') +
          ' data-appr="' + u.id + '" data-to="' + (approved ? '0' : '1') + '">' +
          (approved ? 'Suspend' : 'Approve') + '</button>'
        : '') +
      (canChangeRole
        ? '<button class="btn btn-ghost btn-sm" data-role="' + u.id + '" data-to="' +
          (role === 'super_admin' ? 'admin' : role === 'admin' ? 'user' : 'admin') + '">' +
          (role === 'super_admin' ? 'Step down to admin'
            : role === 'admin' ? 'Remove admin' : 'Make admin') + '</button>'
        : '') +
      (!canApprove && !canChangeRole ? '<span style="color:var(--muted);font-size:.76rem">\u2014</span>' : '') +
      '</div></td></tr>';
  }).join('') : '<tr><td colspan="5"><div class="empty">No staff accounts yet.</div></td></tr>';

  // An unapproved admin is waiting like anybody else now, so it no longer
  // makes sense to exclude them from the count.
  const waiting = db.staff.filter(u => !u.approved).length;
  const note = $('#staffNote');
  if (note) {
    note.className = waiting ? 'warn-box' : '';
    note.innerHTML = waiting
      ? '<strong>' + waiting + ' account' + (waiting === 1 ? '' : 's') + ' waiting for approval.</strong> ' +
        'Until you approve them they cannot charge a bill or open the sales log.'
      : '';
  }

  $$('#staffBody [data-appr]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.appr, to = b.dataset.to === '1';
    const who = db.staff.find(u => u.id === id) || {};
    if (!to && !window.confirm('Suspend ' + (who.name || 'this account') +
      '?\n\nThey stay signed in but cannot charge a bill or read the sales log until you approve them again.')) return;
    busy(b, true, '\u2026');
    const { error } = await sb.rpc('approve_staff', { p_staff_id: id, p_approved: to });
    busy(b, false);
    if (error) return fail(error, "Couldn't change that approval.");
    await loadStaff(); renderStaff();
    toast(to ? (who.name || 'That account') + ' can now operate the till.'
             : (who.name || 'That account') + ' is suspended.', 'ok');
  }));

  $$('#staffBody [data-role]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.role, to = b.dataset.to;
    const who = db.staff.find(u => u.id === id) || {};
    // What to send depends on where the row is now, not only on where it is
    // going: 'admin' means insert for a cashier and update for a main admin
    // stepping down, and an insert on an existing row collides on the key.
    const now = (db.admins.find(a => a.id === id) || {}).role || 'user';

    if (now === 'super_admin' && !window.confirm(
      'Step ' + (who.name || 'this account') + ' down to admin?' +
      '\n\nThey keep admin access but can no longer change anybody\'s role.')) return;

    busy(b, true, '\u2026');
    const { error } =
      now === 'super_admin' ? await sb.from('admins').update({ role: 'admin' }).eq('id', id)
      : to === 'admin'      ? await sb.from('admins').insert({ id, role: 'admin' })
                            : await sb.from('admins').delete().eq('id', id);
    busy(b, false);
    if (error) return fail(error, 'Only the main admin can change roles.');
    await loadStaff(); renderStaff();
    toast(now === 'super_admin' ? (who.name || 'That account') + ' is now an admin.'
      : to === 'admin' ? 'Admin access granted.' : 'Admin access removed.', 'ok');
  }));
}

/* ------------------------------------------------------------------
   12. SETTINGS + BACKUP
   ------------------------------------------------------------------ */
function fillSettings() {
  if (!$('#stName')) return;
  const s = db.settings || {};
  $('#stName').value = s.name || ''; $('#stAddr').value = s.addr || '';
  $('#stPhone').value = s.phone || ''; $('#stHours').value = s.hours || '';
  $('#stVat').value = num(s.vat); $('#stFooter').value = s.footer || '';
  if ($('#stConfirm')) {
    $('#stConfirm').value = s.confirm_charge || 'always';
    $('#stConfirmOver').value = num(s.confirm_charge_over || 0);
    toggleConfirmOver();
  }
  // Absent on an older cached settings row, and 100 is the no-limit default,
  // so a missing value must read as 100 rather than as 0 — which would be a
  // till that silently refuses every custom discount.
  if ($('#stDiscMax')) {
    $('#stDiscMax').value = s.discount_max_pct === undefined || s.discount_max_pct === null
      ? 100 : num(s.discount_max_pct);
  }
}

function toggleConfirmOver() {
  const over = $('#stConfirm').value === 'over';
  $('#stConfirmOverField').classList.toggle('hidden', !over);
  $('#stConfirmWhy').textContent =
    $('#stConfirm').value === 'always'
      ? 'Every bill is read back before it is committed. The safe choice, and the default.'
      : over
        ? 'Small, undiscounted bills go straight through. Anything with a discount on it is still read back, whatever the amount.'
        : 'Bills are charged the moment the button is pressed. Only pick this if a mis-tap is cheaper than the delay — remember the bill number is spent either way, and undoing one needs an admin.';
}

async function saveSettings(e) {
  const payload = {
    name: $('#stName').value.trim(),
    addr: $('#stAddr').value.trim(),
    phone: $('#stPhone').value.trim(),
    hours: $('#stHours').value.trim(),
    // settings.vat is checked 0..30 in the database. The input says max="30"
    // but a number input only enforces that through form validation, and
    // there is no form here — so clamp, or a typed 50 comes back as a
    // constraint violation nobody can act on.
    vat: Math.min(30, Math.max(0, Number($('#stVat').value) || 0)),
    footer: $('#stFooter').value.trim()
  };
  if ($('#stConfirm')) {
    payload.confirm_charge = $('#stConfirm').value;
    payload.confirm_charge_over = Math.max(0, Number($('#stConfirmOver').value) || 0);
  }
  if ($('#stDiscMax')) {
    // Same reasoning as vat above: the database checks 0..100 and there is no
    // form to enforce the input's max, so clamp here rather than hand back a
    // constraint violation. A blank field means no limit, not zero.
    const raw = $('#stDiscMax').value.trim();
    payload.discount_max_pct = raw === '' ? 100
      : Math.min(100, Math.max(0, Number(raw) || 0));
  }
  busy(e.target, true, 'Saving…');
  const { error } = await sb.from('settings').update(payload).eq('id', 1);
  busy(e.target, false);
  if (error) return fail(error, "Couldn't save those details.");
  db.settings = { ...db.settings, ...payload };
  // Otherwise the next load paints the old shop name and VAT from the cache
  // for a frame before the fetch corrects it.
  const core = warm.get('core');
  if (core) warm.set('core', { ...core, settings: db.settings });
  toast('Settings saved.', 'ok');
}

function stamp() {
  // Manila, so a file exported at one in the morning is not named for
  // yesterday while the bills inside it are dated today.
  // hourCycle 'h23' rather than hour12:false — the latter is allowed to
  // resolve to the h24 cycle, which writes midnight as 24:00 and would put
  // tomorrow's hour on today's filename. This codebase already works around
  // old Android WebViews elsewhere; same caution.
  const t = new Intl.DateTimeFormat('en-GB', {
    timeZone: MANILA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return manilaDay(new Date()).replace(/-/g, '') + '-' + t.hour + t.minute;
}

async function buildSheets(which) {
  const sheets = {};
  if (which === 'all' || which === 'sales') {
    // Deliberately not db.sales: that is the capped display list.
    const bills = await fetchEverySale();
    sheets['Sales'] = bills.map(s => ({
      'Bill no.': s.no, 'Date & time': fmtDT(s.ts), 'Cashier': s.cashier_name,
      'Items': s.lines.reduce((a, l) => a + l.qty, 0),
      'Subtotal': s.subtotal, 'Discount': s.discount, 'Discount type': s.discount_label || '',
      'Total': s.total, 'VAT-able': s.vatable, 'VAT': s.vat,
      'Payment': s.mode, 'Cash': s.cash, 'Change': s.change_due, 'Status': s.status,
      'Voided by': s.voided_by_name || '',
      'Voided at': s.voided_at ? fmtDT(s.voided_at) : ''
    }));
    sheets['Bill lines'] = bills.flatMap(s => s.lines.map(l => ({
      'Bill no.': s.no, 'Date & time': fmtDT(s.ts), 'Status': s.status,
      'Item': l.name, 'Size': l.size || '', 'Qty': l.qty, 'Unit price': l.price, 'Line total': l.line_total
    })));
  }
  if (which === 'all' || which === 'menu' || which === 'inventory') {
    if (!Object.keys(db.orderTotals).length) await loadOrderTotals();
    sheets[which === 'inventory' ? 'Inventory' : 'Menu'] = db.items.map(i => {
      const t = totalsFor(i.id);
      return {
        'Item': i.name, 'Size': i.size || '', 'Category': catName(i.cat),
        'Price': i.price, 'On menu': i.active ? 'Yes' : 'No',
        'Qty ordered': t.qty, 'Qty on voided bills': t.voided,
        'Bills': t.orders, 'Sales value': t.revenue,
        'Last ordered': t.last ? fmtDT(t.last) : ''
      };
    });
  }
  if (which === 'all') {
    if (!db.staff.length) await loadStaff();
    sheets['Staff'] = db.staff.map(u => {
      const a = db.admins.find(x => x.id === u.id);
      return {
        'Name': u.name,
        'Role': a ? (a.role === 'super_admin' ? 'Main admin' : 'Admin') : 'Cashier',
        'Added': new Date(u.created_at).toLocaleDateString('en-PH', { timeZone: MANILA })
      };
    });
  }
  return sheets;
}

/* Returns true only if a file actually reached the user. The reset flow
   depends on this — no download, no delete. */
async function exportExcel(which) {
  const [sheets] = await Promise.all([buildSheets(which || 'all'), loadXLSX()]);
  const name = "Freddys-" + (which || 'backup') + '-' + stamp();
  try {
    if (typeof XLSX === 'undefined') throw new Error('SheetJS did not load');
    const wb = XLSX.utils.book_new();
    Object.keys(sheets).forEach(k => {
      const rows = sheets[k].length ? sheets[k] : [{ 'No records': '' }];
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = Object.keys(rows[0]).map(h => ({
        wch: Math.min(34, Math.max(11, h.length + 2,
          ...rows.slice(0, 200).map(r => String(r[h] == null ? '' : r[h]).length + 2)))
      }));
      XLSX.utils.book_append_sheet(wb, ws, k.slice(0, 31));
    });
    XLSX.writeFile(wb, name + '.xlsx');
    toast('Saved ' + name + '.xlsx', 'ok');
    return true;
  } catch (e) {
    try {
      const csv = Object.keys(sheets).map(k => {
        const rows = sheets[k];
        if (!rows.length) return '### ' + k + '\n(no records)\n';
        const heads = Object.keys(rows[0]);
        /* Quoting is how CSV marks a field boundary. It is not how Excel
           decides whether something is a formula: Excel strips the quotes
           first, so "=1+1" evaluates exactly as =1+1 does.

           That matters because not every value here is ours. staff.name comes
           from raw_user_meta_data at signup, login.html is public, and an
           unapproved account still appears in the staff export — so anybody
           who can reach the sign-in page chooses a string that ends up in this
           file. A leading apostrophe is Excel's own "treat as text" marker and
           is consumed on import, so the cell reads as written.

           Only the CSV path needs this. The xlsx writer sets a string cell
           type and Excel never reinterprets those. */
        const q = v => {
          let s = String(v == null ? '' : v);
          // A plain negative number is data, not a formula. Prefixing -500.00
          // would import it as text and quietly break every sum downstream,
          // so the numeric case is excluded before the check.
          if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(?:\.\d+)?$/.test(s)) s = "'" + s;
          return '"' + s.replace(/"/g, '""') + '"';
        };
        return '### ' + k + '\n' + heads.map(q).join(',') + '\n' +
          rows.map(r => heads.map(h => q(r[h])).join(',')).join('\n') + '\n';
      }).join('\n');
      download(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), name + '.csv');
      toast('Excel library unavailable — saved a CSV backup instead.', 'ok');
      return true;
    } catch (e2) {
      toast("Couldn't write the backup file. Nothing was changed.", 'err');
      return false;
    }
  }
}

async function exportJSON() {
  if (!db.sales.length) await loadSales();
  if (!db.staff.length) await loadStaff();
  download(new Blob([JSON.stringify({
    exported_at: new Date().toISOString(),
    settings: db.settings, categories: db.categories, items: db.items,
    sales: db.sales, staff: db.staff, admins: db.admins
  }, null, 2)], { type: 'application/json' }), 'Freddys-full-backup-' + stamp() + '.json');
  toast('JSON backup saved.', 'ok');
}

/* ------------------------------------------------------------------
   13. RESET — backup first, then two separate confirmations.
   reset_sales_data() re-checks is_admin() server-side regardless.
   ------------------------------------------------------------------ */
async function resetFlow() {
  if (!db.sales.length) await loadSales();
  const paid = db.sales.filter(s => s.status === 'paid');
  const gross = paid.reduce((a, s) => a + s.total, 0);
  let backedUp = false;

  const w = openModal(
    '<div class="modal-head"><h3>Reset the sales log</h3>' +
    '<p>Three steps, in order. Nothing is deleted until the last one.</p></div>' +
    '<div class="modal-body">' +
    '<div class="step" id="step1"><div class="step-n">1</div><div class="step-b">' +
    '<h4>Choose what to clear</h4>' +
    '<p>You currently have <strong>' + db.sales.length + ' bills</strong> on record totalling <strong>' + peso(gross) + '</strong>.</p>' +
    '<div class="checks">' +
    '<label><input type="checkbox" id="ckSales" checked><span>Clear the sales log — every bill and its lines</span></label>' +
    '<label><input type="checkbox" id="ckBill" checked><span>Start bill numbering again at 0001</span></label>' +
    '</div>' +
    '<p id="ckWhy" style="font-size:.78rem;color:var(--muted);line-height:1.6;margin-top:9px">' +
    'Clearing the sales log also clears Inventory, since the order counts are read back out of the bills.</p>' +
    '</div></div>' +
    '<div class="step" id="step2"><div class="step-n">2</div><div class="step-b">' +
    '<h4>Download the Excel backup</h4>' +
    '<p>Required. The workbook holds your sales, bill lines, menu and order counts — it is the only way back after this.</p>' +
    '<button class="btn btn-primary btn-sm" id="doBackup">Download Excel backup</button>' +
    '<div id="backupNote" style="font-size:.78rem;color:var(--ok);margin-top:8px;font-weight:600"></div></div></div>' +
    '<div class="step" id="step3"><div class="step-n">3</div><div class="step-b">' +
    '<h4>Type RESET to confirm</h4><p>This is deliberately awkward. It should be.</p>' +
    '<input id="ckPhrase" placeholder="RESET" autocapitalize="characters" spellcheck="false" ' +
    'style="width:100%;padding:9px 12px;border:1.5px solid var(--line);border-radius:6px;font-family:\'IBM Plex Mono\',monospace;letter-spacing:.16em;background:#fff" disabled>' +
    '</div></div></div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" data-close>Cancel</button>' +
    '<button class="btn btn-danger" id="doReset" disabled>Delete permanently</button></div>');

  const phrase = w.querySelector('#ckPhrase');
  const doReset = w.querySelector('#doReset');
  const checks = ['#ckSales', '#ckBill'].map(s => w.querySelector(s));

  const why = w.querySelector('#ckWhy');

  /* db.sales is capped at SALES_PAGE for the table, so past that it would
     understate how many bills are in the way. Ask the server for the real
     figure — head:true fetches the count without the rows. */
  let billCount = db.sales.length;
  sb.from('sales').select('id', { count: 'exact', head: true }).then(res => {
    if (typeof res.count === 'number') { billCount = res.count; refresh(); }
  });

  /* Bill numbers are unique. Restarting the counter while bills survive means
     the next sale of the same day rebuilds a number that already exists, and
     create_order() dies on the duplicate — the till stops taking orders. The
     server refuses that combination outright; this keeps the UI from letting
     anyone pick it in the first place. */
  function refresh() {
    const clearing = checks[0].checked;
    const blocked = !clearing && billCount > 0;

    checks[1].disabled = blocked;
    if (blocked) checks[1].checked = false;
    checks[1].closest('label').style.opacity = blocked ? '.5' : '';

    why.innerHTML = blocked
      ? 'Numbering can only restart from an empty log. Bill numbers are unique, so with ' +
        billCount + ' bills still on record the next sale would collide with one of them.'
      : 'Clearing the sales log also clears Inventory, since the order counts are read back out of the bills.';

    const anything = checks.some(c => c.checked);
    phrase.disabled = !(backedUp && anything);
    doReset.disabled = !(backedUp && anything && phrase.value.trim().toUpperCase() === 'RESET');
  }
  checks.forEach(c => c.addEventListener('change', refresh));
  refresh();
  phrase.addEventListener('input', refresh);
  w.querySelector('[data-close]').addEventListener('click', closeModal);

  w.querySelector('#doBackup').addEventListener('click', async e => {
    busy(e.target, true, 'Building…');
    const done = await exportExcel('all');
    busy(e.target, false);
    if (!done) return;
    backedUp = true;
    w.querySelector('#step2').classList.add('done');
    w.querySelector('#backupNote').textContent = '✓ Backup saved. Check your Downloads folder before you carry on.';
    refresh(); phrase.focus();
  });

  doReset.addEventListener('click', async () => {
    const opts = { sales: checks[0].checked, bill: checks[1].checked };
    const parts = [];
    // billCount, not db.sales.length. The table only holds the newest
    // SALES_PAGE bills, so on a busy month this last-chance prompt would say
    // "1000 bills" while five thousand were about to go. The number is the
    // entire point of the sentence.
    if (opts.sales) parts.push(billCount + ' bills');
    if (opts.bill) parts.push('the bill numbering');
    if (!window.confirm('Last check.\n\nAbout to permanently delete: ' + parts.join(', ') +
      '.\n\nYour Excel backup is the only copy. Continue?')) return;

    busy(doReset, true, 'Deleting…');
    const { error } = await sb.rpc('reset_sales_data', {
      p_clear_sales: opts.sales, p_reset_bill: opts.bill
    });
    busy(doReset, false);
    if (error) return fail(error, "The reset didn't go through. Nothing was deleted.");
    closeModal();
    cart = [];
    db.sales = []; db.orderTotals = {};
    // Drop the warm cache too, or another tab in this session would keep
    // painting bills that no longer exist.
    warm.clear();
    await Promise.all([loadCore(), loadSales(), loadOrderTotals()]);
    renderSales(); renderInventory();
    toast('Reset done. ' + parts.join(', ') + ' cleared.', 'ok');
  });
}

/* ------------------------------------------------------------------
   14. ACCOUNT — your own name and password
   ------------------------------------------------------------------ */
function fillAccount() {
  if (!$('#acEmail')) return;
  $('#acEmail').value = session.email || '';
  $('#acName').value = session.name || '';
  const rows = PERMS.map(perm => {
    const allowed = isAdmin() ? true : perm[1];
    return '<tr><td data-label="Action">' + esc(perm[0]) + '</td>' +
      '<td style="text-align:right;color:' + (allowed ? 'var(--ok)' : 'var(--muted)') + ';font-weight:700">' +
      (allowed ? 'Yes' : 'No') + '</td></tr>';
  }).join('');
  $('#acPerms').innerHTML = rows;
  if (isAdmin()) refreshVoidPin();
}

/* The PIN itself never comes back from the server — only whether one exists.
   void_pin_status() returns booleans and timestamps and nothing else, which
   is what lets this card be honest about the state without ever holding the
   secret it describes. */
async function refreshVoidPin() {
  const card = $('#acPinCard');
  if (!card) return;
  card.hidden = false;

  const { data, error } = await sb.rpc('void_pin_status');
  const state = $('#acPinState');
  if (error) { state.textContent = "Couldn't check whether you have a PIN set."; return; }

  const mine = (data || []).find(r => r.admin_id === session.id);
  const has = !!(mine && mine.has_pin);
  $('#acPinCurField').hidden = !has;
  $('#acClearPin').hidden = !has;
  $('#acSavePin').textContent = has ? 'Change PIN' : 'Set PIN';

  const others = (data || []).filter(r => r.admin_id !== session.id);
  const without = others.filter(r => !r.has_pin).length;
  state.textContent = (has
    ? 'Set ' + (mine.set_at ? fmtDT(mine.set_at) : 'already') + '.'
    : 'You have no void PIN yet, so you cannot approve a void.') +
    (others.length
      ? ' ' + (others.length - without) + ' of ' + others.length + ' other admin' +
        (others.length === 1 ? ' has' : 's have') + ' one.'
      : '');
}

async function saveVoidPin(e) {
  const has = !$('#acPinCurField').hidden;
  const cur = $('#acPinCur').value.trim();
  const a = $('#acPinNew').value.trim(), b = $('#acPinNew2').value.trim();

  if (has && !/^\d{6}$/.test(cur)) return toast('Enter your current six-digit PIN.', 'err');
  if (!/^\d{6}$/.test(a)) return toast('A void PIN is exactly six digits.', 'err');
  if (a !== b) return toast("The two PINs don't match.", 'err');

  busy(e.target, true, 'Saving…');
  // Everything else — runs, repeated digits, a PIN another admin already
  // uses — is refused by set_void_pin(), not here. The browser is not the
  // place to decide what counts as guessable.
  const { error } = await sb.rpc('set_void_pin', { p_pin: a, p_current: has ? cur : null });
  busy(e.target, false);
  if (error) return fail(error, "Couldn't save that PIN.");

  $('#acPinCur').value = ''; $('#acPinNew').value = ''; $('#acPinNew2').value = '';
  await refreshVoidPin();
  toast('Void PIN saved. Voids approved with it will carry your name.', 'ok');
}

function clearVoidPin() {
  const w = openModal(
    '<div class="modal-head"><h3>Remove your void PIN?</h3>' +
    '<p>You will not be able to approve a void until you set a new one.</p></div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" data-close>Keep it</button>' +
    '<button class="btn btn-danger" data-ok>Remove it</button></div>');
  w.querySelector('[data-close]').addEventListener('click', closeModal);
  w.querySelector('[data-ok]').addEventListener('click', async e => {
    busy(e.target, true, 'Removing…');
    const { error } = await sb.rpc('clear_void_pin', { p_admin: null });
    busy(e.target, false);
    if (error) return fail(error, "Couldn't remove that PIN.");
    closeModal();
    await refreshVoidPin();
    toast('Void PIN removed.', 'ok');
  });
}

async function saveAccountName(e) {
  const name = $('#acName').value.trim();
  if (!name) return toast('Your name cannot be blank.', 'err');
  // staff_name_len enforces this server-side; checking here just saves the
  // round trip and gives the length back in the message.
  if (name.length > 80) return toast('That name is ' + name.length + ' characters. The limit is 80.', 'err');
  busy(e.target, true, 'Saving…');
  // staff_self_update lets you rename yourself and nobody else.
  const { error } = await sb.from('staff').update({ name }).eq('id', session.id);
  if (!error) await sb.auth.updateUser({ data: { name } });
  busy(e.target, false);
  if (error) return fail(error, "Couldn't save that name.");
  session.name = name;
  $('#whoName').textContent = name;
  $('#avatar').textContent = name.charAt(0).toUpperCase();
  toast('Name updated. New bills will print it.', 'ok');
}

async function changeOwnPassword(e) {
  const cur = $('#acCurrent').value;
  const a = $('#acNew').value, b = $('#acNew2').value;
  if (!cur) return toast('Enter your current password.', 'err');
  if (a.length < 6) return toast('Use at least 6 characters.', 'err');
  if (a !== b) return toast("The two new passwords don't match.", 'err');
  if (a === cur) return toast('That is already your password.', 'err');

  busy(e.target, true, 'Checking…');
  // Verify the current password before changing it, so a terminal left
  // signed in cannot be used to lock the owner out of their own account.
  const { error: authErr } = await sb.auth.signInWithPassword({ email: session.email, password: cur });
  if (authErr) {
    busy(e.target, false);
    return toast('That is not your current password.', 'err');
  }
  const { error } = await sb.auth.updateUser({ password: a });
  busy(e.target, false);
  if (error) return fail(error, "Couldn't change the password.");
  $('#acCurrent').value = ''; $('#acNew').value = ''; $('#acNew2').value = '';
  toast('Password changed. Use it next time you sign in.', 'ok');
}

/* ------------------------------------------------------------------
   15. WIRE UP — every page shares this file, so bind only what exists.
   ------------------------------------------------------------------ */
const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

function wireCommon() {
  on('#logoutBtn', 'click', signOut);
  on('#menuToggle', 'click', openDrawer);
}

function wirePOS() {
  on('#posSearch', 'input', renderMenuGrid);
  on('#discType', 'change', () => {
    $('#discCustom').classList.toggle('hidden', $('#discType').value !== 'custom');
    // Same all-or-nothing rule as create_order(), enforced from this side
    // too: picking a whole-bill discount while an item still has its own
    // would otherwise leave a stale per-item discount sitting unseen.
    if ($('#discType').value !== '0' && cart.some(l => l.discType && l.discType !== '0')) {
      cart.forEach(l => { l.discType = '0'; l.discAmount = 0; });
      cartChanged();
      toast('Per-item discounts cleared \u2014 using the whole-bill discount instead.', '');
    }
    renderTicket();
  });
  on('#discCustom', 'input', renderTicket);
  on('#payCash', 'input', renderTicket);
  /* Payment mode had no handler at all — it was only read at charge time. So
     the cash box stayed on screen, and populated, after switching to GCash or
     Card, where the server ignores it entirely. Clearing rather than just
     hiding: a hidden field with ₱500 still in it is the same trap one click
     later, when the customer changes their mind back. */
  on('#payMode', 'change', syncPayMode);
  // Browsers restore a <select>'s value across a soft reload, so the page can
  // come up on GCash without the change event ever firing. Sync once.
  syncPayMode();
  /* Picked up when the terminal is woken rather than on a timer: a till sits
     idle between covers, and polling a row that changes twice a year is
     waste. `visibilitychange` fires on tab switch, app switch and screen
     wake, which is every occasion the settings could have moved underneath. */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshSettings();
  });
  on('#chargeBtn', 'click', charge);
  on('#clearBill', 'click', () => {
    if (!cart.length) return;
    cart = []; $('#payCash').value = ''; renderTicket(); toast('Bill cleared.');
  });
}

function wireInventory() {
  ['#invSearch', '#invCat', '#invFilter'].forEach(sel => on(sel, 'input', renderInventory));
}

function wireSales() {
  on('#salesFrom', 'change', applySalesFilter);
  on('#salesTo', 'change', applySalesFilter);
  // Cashier is a property of the rows already loaded, so it needs no round trip.
  on('#salesCashier', 'change', renderSales);
  on('#salesToday', 'click', () => {
    $('#salesFrom').value = todayISO(); $('#salesTo').value = todayISO(); applySalesFilter();
  });
  on('#salesAll', 'click', () => {
    $('#salesFrom').value = ''; $('#salesTo').value = ''; $('#salesCashier').value = 'all'; applySalesFilter();
  });
}

function wireMenuManager() {
  on('#mmSearch', 'input', renderMenuManager);
  on('#addItemBtn', 'click', () => itemForm(null));
  on('#addCatBtn', 'click', addCategory);
}

function wireSettings() {
  on('#saveSettings', 'click', saveSettings);
  on('#stConfirm', 'change', toggleConfirmOver);
  on('#saveTill', 'click', saveSettings);
  on('#dlExcel', 'click', () => exportExcel('all'));
  on('#dlJson', 'click', exportJSON);
  on('#resetBtn', 'click', resetFlow);
  // JSON restore is deliberately absent on a shared database: the safe path
  // back is a Postgres restore, not one browser overwriting everyone.
  const rb = $('#restoreBtn');
  if (rb) {
    rb.textContent = 'Restoring? Use a Supabase backup';
    rb.disabled = true;
    rb.title = 'Restore from Supabase \u2192 Database \u2192 Backups, so one terminal cannot overwrite the shared books.';
  }
}

function wireAccount() {
  on('#acSaveName', 'click', saveAccountName);
  on('#acSavePass', 'click', changeOwnPassword);
  on('#acSavePin', 'click', saveVoidPin);
  on('#acClearPin', 'click', clearVoidPin);
  ['#acPinCur', '#acPinNew', '#acPinNew2'].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, '').slice(0, 6); });
  });
}

/* Cold start only: the warm cache paints real content, so skeletons appear
   just on the first visit of a session, where the alternative is a blank. */
function showSkeleton() {
  const bars = n => '<div class="skel">' +
    Array.from({ length: n }, (_, ix) =>
      '<div class="skel-line' + (ix % 3 === 2 ? ' short' : '') + '"></div>').join('') + '</div>';
  const grid = $('#menuGrid') || $('#mmGrid');
  if (grid && !grid.innerHTML.trim()) {
    grid.innerHTML = '<div class="item-grid">' +
      Array.from({ length: 8 }, () => bars(3)).join('') + '</div>';
  }
  ['#invBody', '#salesBody'].forEach(sel => {
    const body = $(sel);
    if (body && !body.innerHTML.trim()) {
      body.innerHTML = '<tr><td colspan="8" style="padding:0;border:none">' + bars(9) + '</td></tr>';
    }
  });
}

async function bootPage() {
  showSkeleton();
  switch (PAGE) {
    case 'pos':
      await loadCore(); wirePOS(); subscribeRealtime(); break;
    case 'inv':
      await Promise.all([loadCore(), loadOrderTotals()]);
      wireInventory(); renderInventory(); subscribeRealtime(); break;
    case 'sales':
      await Promise.all([loadCore(), loadSales()]); wireSales(); renderSales(); subscribeRealtime(); break;
    case 'menu':
      await loadCore(); wireMenuManager(); renderMmCatBar(); renderMenuManager(); subscribeRealtime(); break;
    case 'staff':
      await loadStaff(); renderStaff(); break;
    case 'settings':
      await loadCore(); fillSettings(); wireSettings(); break;
    case 'account':
      fillAccount(); wireAccount(); break;
  }
  renderTopActions(PAGE);
}

async function init() {
  if (PAGE === 'login') {
    on('#loginForm', 'submit', handleLoginSubmit);
    on('#swapMode', 'click', () => setSignupMode(!signupMode));
    const { data } = await sb.auth.getSession();
    if (data && data.session) { location.replace('index.html'); return; }
    $('#lgEmail').focus();
    return;
  }

  const { data } = await sb.auth.getSession();
  if (!data || !data.session) { location.replace('login.html'); return; }
  const user = data.session.user;

  wireCommon();

  /* If this tab already knows who you are, put the sidebar and the panel up
     now and check with the server in the background. Otherwise there is
     nothing honest to draw yet, so wait for the answer. */
  /* Approval is checked against the server before anything loads. The warm
     cache is fine for painting a sidebar early, but it is not good enough to
     decide whether someone may operate the till. */
  const known = warm.get('role:' + user.id);
  if (known && known.id === user.id && known.approved) {
    applySession(known);
    if (!guardPage()) return;
    bootPage();
    revalidateRole(user);
  } else {
    const fresh = await resolveRole(user);
    session = fresh;
    if (!fresh.approved) { showPendingScreen(); return; }
    applySession(fresh);
    if (!guardPage()) return;
    await bootPage();
  }

  prefetchPanels();

  sb.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') location.replace('login.html');
  });
}

/* The cached role was a guess at what the server would say. Find out, and if
   it guessed wrong, correct the sidebar and bounce off the page if it is one
   this person should not be on. */
async function revalidateRole(user) {
  const fresh = await resolveRole(user);
  if (!session) return;
  if (!fresh.approved) { session = fresh; showPendingScreen(); return; }
  if (fresh.role === session.role && fresh.name === session.name) return;
  applySession(fresh);
  if (!guardPage()) return;
  renderTopActions(PAGE);
  if (PAGE === 'inv') renderInventory();
  if (PAGE === 'sales') renderSales();
  if (PAGE === 'account') fillAccount();
}

/* Bind if the document is still parsing; run immediately if this file
   somehow evaluates after DOMContentLoaded has already fired (a cached or
   deferred script), which would otherwise leave the page dead. */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
