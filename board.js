/* Freddy's — public menu board.
   This lives in its own file rather than inline because the Content-Security-
   Policy is script-src 'self' with no 'unsafe-inline'. On GitHub Pages the
   _headers file was never applied so inline scripts ran anyway; Vercel applies
   vercel.json for real, and the board silently stopped at "Loading the menu".
   Keeping the policy strict and the script external is the right way round:
   'unsafe-inline' would have re-opened the hole for every page at once. */
/* Standalone on purpose: this page never signs anyone in, never writes,
   and does not load the terminal's app.js. It reads the same three tables
   the kitchen edits, restricted by column grants so the diner gets nothing
   but the menu as printed. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = n => '\u20B1' + Number(n || 0).toLocaleString('en-PH',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const $id = id => document.getElementById(id);
  let drawnOnce = false;

  async function draw() {
    const [cats, items, st] = await Promise.all([
      sb.from('categories').select('id,name,sort').order('sort'),
      sb.from('items').select('id,cat,name,size,price,active').eq('active', true).order('name'),
      sb.from('settings').select('name,addr,phone,hours').eq('id', 1).maybeSingle()
    ]);
    if (cats.error || items.error) throw (cats.error || items.error);

    const s = st.data || {};
    $id('boardMeta').innerHTML =
      '<strong>' + esc(s.addr || '') + '</strong><br>' + esc(s.hours || '');

    const rows = items.data || [];
    let html = '<div class="board-cols">';
    (cats.data || []).forEach(c => {
      const list = rows.filter(i => i.cat === c.id);
      if (!list.length) return;
      html += '<section class="board-sect"><div class="rule-head">' + esc(c.name) + '</div>';
      list.forEach(i => {
        html += '<div class="board-row"><span class="nm">' + esc(i.name) + '</span>' +
          (i.size ? '<span class="sz">' + esc(i.size) + '</span>' : '') +
          '<span class="dots"></span><span class="pr">' + peso(i.price) + '</span></div>';
      });
      html += '</section>';
    });
    html += '</div>';

    $id('boardBody').innerHTML = rows.length ? html :
      '<div class="board-loading">The menu is being updated. Please ask your server.</div>';

    $id('boardNote').textContent =
      'Prices are VAT-inclusive and shown per serving. ' + rows.length + ' items available today.';

    // The fallback is escaped like everything else, so it carries a bare "&".
    // Writing "&amp;" here would come out on screen as "&amp;".
    $id('boardFoot').innerHTML =
      esc(s.name || "Freddy's Seafood Grill & Restaurant") + '<br>' +
      (s.phone ? 'Call <a href="tel:' + esc(String(s.phone).replace(/\s/g, '')) + '">' + esc(s.phone) + '</a><br>' : '') +
      'Find us on Facebook &mdash; Freddy\'s Seafood Grill and Restaurant';

    drawnOnce = true;
  }

  async function refresh() {
    try {
      await draw();
    } catch (e) {
      console.error(e);
      // A failed refresh must not wipe a board that is already up. Diners
      // reading last minute's prices is better than an error where the menu
      // used to be, and the next poll will very likely succeed.
      if (!drawnOnce) {
        $id('boardBody').innerHTML =
          '<div class="board-loading">The menu could not be loaded right now.<br>' +
          'Please ask your server for a printed card.</div>';
      }
    }
  }

  refresh();

  /* This screen hangs on a wall and is not reloaded for weeks. Drawn once and
     left alone, it keeps showing a dish the kitchen took off an hour ago, or
     an old price — and a board disagreeing with the till is an argument at
     the counter, not a cosmetic problem.

     Realtime is already on for items, so a price edit reaches the wall in
     about a second. The interval is the backstop: realtime needs an open
     socket, and a board on café wifi will lose one overnight without anyone
     noticing. Settings changes have no realtime channel here, so the poll is
     also what carries a new address or opening hours. */
  try {
    sb.channel('board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, refresh)
      .subscribe();
  } catch (_) { /* no realtime: the interval below still holds the board current */ }

  setInterval(refresh, 5 * 60 * 1000);

  // A tab woken from sleep may have missed hours of changes.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
})();

/* ---------------------------------------------------------------- */
/* "Back to the till" for staff who reached this page from the sidebar.
   It is drawn only when this browser already holds a session, so a diner
   scanning the QR code is never shown a way into the counter app. Signing in
   is what reveals it; nothing here grants access that RLS would not.

   Where it goes back to: wherever they came from, if that was one of our own
   pages, so leaving Sales to glance at the menu returns to Sales. Otherwise
   the till, which is the sensible default. */
(async function () {
  try {
    const { data } = await sb.auth.getSession();
    if (!data || !data.session) return;

    let back = 'index.html';
    if (document.referrer) {
      try {
        const ref = new URL(document.referrer, location.href);
        if (ref.origin === location.origin && !ref.pathname.endsWith('/board.html')) back = ref.href;
      } catch (_) {}
    }

    const a = document.createElement('a');
    a.className = 'board-back';
    a.href = back;
    a.textContent = '\u2190 Back to the till';
    document.body.appendChild(a);
  } catch (_) { /* signed out, or auth unreachable: show nothing */ }
})();
