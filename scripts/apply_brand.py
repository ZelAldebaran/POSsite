#!/usr/bin/env python3
"""Apply the Freddy's brand marks to the pages in this repo.

Written to run against the *current* repo rather than a fixed snapshot: every
edit is matched by shape instead of by exact text, and every edit checks first
whether it has already been made. Running it twice changes nothing.

    python3 scripts/apply_brand.py           # apply
    python3 scripts/apply_brand.py --check   # report only, change nothing
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = "--check" in sys.argv

HEAD = """<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="icon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="icon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="icon-180.png">
<link rel="manifest" href="site.webmanifest">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Freddy's Seafood Grill &amp; Restaurant">
<meta property="og:title" content="{title}">
<meta property="og:image" content="og-freddys.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="og-freddys.jpg">
"""

# The wordmark image was retired from the login band and the board header --
# both use the typographic lockup instead -- so this script no longer injects
# it. The grill mark in the sidebar is the one brand image left.
LOGO_IMG = None

MARK_IMG = ('<img class="side-mark" src="site-icon.png" alt=""\n'
            '           width="557" height="866" decoding="async">')

CSS_BLOCK = """
/* =================== BRAND MARKS =================== */
/* The wordmark lockup already carries "Seafood Grill & Restaurant" and the
   town line, so wherever it appears the text version is retired rather than
   doubled up. */
/* On the pine sidebar the navy wordmark would vanish, so the sidebar keeps its
   typographic brand and gains the grill mark, which holds up on a dark field. */
.side-brand{display:flex;align-items:center;gap:11px}
.side-brand-text{min-width:0}
.side-mark{width:34px;height:auto;flex-shrink:0;
  filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
"""

# The three text lockups, matched loosely so wording tweaks don't break them.
BAND = re.compile(
    r'(?P<open><(?P<tag>div|header)\s+class="(?P<cls>login-band|board-head)"[^>]*>)'
    r'(?P<body>\s*<div class="est">.*?</div>\s*)'
    r'(?P<close></(?P=tag)>)', re.S)

SIDE = re.compile(
    r'(?P<open><div\s+class="side-brand"[^>]*>)'
    r'(?P<body>\s*<div class="est">.*?</div>\s*)'
    r'(?P<close></div>)', re.S)

done, skipped, missing = [], [], []


def load(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


def save(p, s):
    if not CHECK:
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(s)


def add_head(src, page):
    if "apple-touch-icon" in src:
        return src, False
    m = re.search(r"<title>(.*?)</title>\s*\n", src, re.S)
    if not m:
        missing.append(f"{page}: no <title> to anchor the head block to")
        return src, False
    title = m.group(1).split("|")[0].strip()
    if page == "board.html":
        title = "Freddy's Seafood Grill &amp; Restaurant"
    return src[:m.end()] + HEAD.format(title=title) + src[m.end():], True


def swap_band(src):
    # Nothing to swap in any more. The login band and the board header keep
    # the typographic lockup that is already in the markup.
    return src, False


def swap_side(src):
    if "side-mark" in src:
        return src, False

    def rep(m):
        body = m.group("body").strip()
        return (f'{m.group("open")}\n      {MARK_IMG}\n'
                f'      <div class="side-brand-text">\n        {body}\n      </div>\n'
                f'    {m.group("close")}')

    new, n = SIDE.subn(rep, src)
    return new, bool(n)


def do_pages():
    for page in sorted(f for f in os.listdir(ROOT) if f.endswith(".html")):
        p = os.path.join(ROOT, page)
        src = load(p)
        changes = []
        for label, fn in (("head", add_head), ("logo", swap_band), ("mark", swap_side)):
            if fn is add_head:
                src, hit = fn(src, page)
            else:
                src, hit = fn(src)
            if hit:
                changes.append(label)
        if changes:
            save(p, src)
            done.append(f"{page}: {', '.join(changes)}")
        else:
            skipped.append(page)


def do_css():
    p = os.path.join(ROOT, "freddys.css")
    if not os.path.exists(p):
        missing.append("freddys.css not found")
        return
    src = load(p)
    if ".side-mark" in src:
        skipped.append("freddys.css")
        return
    anchor = "/* =================== APP SHELL"
    if anchor in src:
        src = src.replace(anchor, CSS_BLOCK + "\n" + anchor, 1)
    else:
        src = src.rstrip() + "\n" + CSS_BLOCK
    save(p, src)
    done.append("freddys.css: brand styles")


def check_assets():
    need = ["favicon.ico", "site.webmanifest",
            "site-icon.png",
            "og-freddys.jpg"] + \
           [f"icon-{n}.png" for n in (16, 32, 48, 180, 192, 512)]
    for f in need:
        if not os.path.exists(os.path.join(ROOT, f)):
            missing.append(f"asset not copied in: {f}")


if __name__ == "__main__":
    check_assets()
    do_pages()
    do_css()

    print(("WOULD CHANGE" if CHECK else "CHANGED") + f" ({len(done)}):")
    for d in done or ["  (nothing — already applied)"]:
        print("  " + d if d.startswith(" ") is False else d)
    if skipped:
        print(f"\nalready done ({len(skipped)}): {', '.join(skipped)}")
    if missing:
        print(f"\nPROBLEMS ({len(missing)}):")
        for m in missing:
            print("  -", m)
        sys.exit(1)
    print("\nok")
