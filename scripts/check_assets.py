#!/usr/bin/env python3
"""Pre-deploy checks for Freddy's POS.

Vercel builds nothing, so nothing fails loudly. A mistyped asset path, a
malformed vercel.json or a cache-buster left behind on a build bump all ship
silently and only show up as a stale page on the counter terminal.

Run from the repo root:  python3 scripts/check_assets.py
Exit status is 0 when everything passes, 1 otherwise.
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = sorted(ROOT.glob("*.html"))

problems = []
notes = []


def fail(msg):
    problems.append(msg)


def note(msg):
    notes.append(msg)


# ---------------------------------------------------------------- assets
# Every href/src in the pages and the manifest has to resolve to a real file.
# Query strings are cache-busters, not part of the path.
REF = re.compile(r'(?:href|src)="([^"]+)"')

targets = list(PAGES)
manifest_path = ROOT / "site.webmanifest"
if manifest_path.exists():
    targets.append(manifest_path)

referenced = set()
for page in targets:
    text = page.read_text(encoding="utf-8")
    for raw in REF.findall(text):
        if raw.startswith(("http://", "https://", "#", "mailto:", "data:")):
            continue
        clean = raw.split("?")[0].lstrip("/")
        if not clean:
            continue
        referenced.add(clean)
        if not (ROOT / clean).exists():
            fail(f"{page.name} points at {raw}, which is not in the repo")

# The manifest lists icons under "icons", not as href/src.
if manifest_path.exists():
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"site.webmanifest is not valid JSON: {exc}")
    else:
        for icon in manifest.get("icons", []):
            src = icon.get("src", "").split("?")[0].lstrip("/")
            if src:
                referenced.add(src)
                if not (ROOT / src).exists():
                    fail(f"site.webmanifest lists icon {src}, which is not in the repo")

# ------------------------------------------------------------ build number
# app.js carries the build number and the pages cache-bust against it. If they
# disagree, the browser keeps yesterday's JavaScript and the console lies about
# which build is running.
app_js = ROOT / "app.js"
build = None
if app_js.exists():
    match = re.search(r"^const BUILD\s*=\s*(\d+)", app_js.read_text(encoding="utf-8"), re.M)
    if match:
        build = match.group(1)
    else:
        fail("app.js has no `const BUILD = <n>` line")

if build:
    for page in PAGES:
        for raw in REF.findall(page.read_text(encoding="utf-8")):
            if "?v=" not in raw:
                continue
            stamped = raw.split("?v=")[1].split("&")[0]
            if stamped != build:
                fail(f"{page.name}: {raw} is stamped v={stamped}, but app.js is build {build}")
    note(f"build {build}")

# ----------------------------------------------------------------- configs
vercel_path = ROOT / "vercel.json"
if not vercel_path.exists():
    fail("vercel.json is missing")
else:
    try:
        vercel = json.loads(vercel_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"vercel.json is not valid JSON: {exc}")
    else:
        # cleanUrls rewrites /page.html to /page, which breaks every relative
        # link in this app. It has bitten this project once already.
        if vercel.get("cleanUrls"):
            fail("vercel.json sets cleanUrls: true, which breaks the page links")

        headers = vercel.get("headers", [])
        first = headers[0].get("headers", []) if headers else []
        keys = {h.get("key") for h in first}
        for required in (
            "Content-Security-Policy",
            "X-Frame-Options",
            "X-Content-Type-Options",
            "Referrer-Policy",
            "Strict-Transport-Security",
        ):
            if required not in keys:
                fail(f"vercel.json is missing the {required} header")

        # The three header files must agree, or moving host quietly changes
        # the security posture.
        csp = next((h["value"] for h in first if h.get("key") == "Content-Security-Policy"), None)
        for other in ("_headers", "netlify.toml"):
            path = ROOT / other
            if not path.exists():
                continue
            text = path.read_text(encoding="utf-8")
            match = re.search(r"Content-Security-Policy[:=]\s*\"?([^\"\n]+)", text)
            if match and csp and match.group(1).strip() != csp.strip():
                fail(f"{other} has a different Content-Security-Policy from vercel.json")

# ------------------------------------------------------------------ secrets
# The publishable key belongs in the repo. A service_role key never does.
for path in sorted(ROOT.rglob("*")):
    if path.is_dir() or ".git" in path.parts:
        continue
    if path.suffix.lower() in (".png", ".jpg", ".jpeg", ".ico", ".zip"):
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        continue
    if "service_role" in text and path.name not in ("check_assets.py",):
        if "sb_secret" in text or re.search(r"service_role[\"']?\s*[:=]\s*[\"']ey", text):
            fail(f"{path.relative_to(ROOT)} looks like it contains a service_role key")

# -------------------------------------------------------------- migrations
mig_dir = ROOT / "supabase" / "migrations"
if mig_dir.exists():
    versions = []
    for path in sorted(mig_dir.glob("*.sql")):
        match = re.match(r"^(\d{14})_", path.name)
        if not match:
            fail(f"supabase/migrations/{path.name} does not start with a 14-digit version")
        else:
            versions.append(match.group(1))
    if len(versions) != len(set(versions)):
        fail("two migrations share a version number")
    note(f"{len(versions)} migrations")

# ---------------------------------------------------------------- report
for line in notes:
    print(f"  {line}")

if problems:
    print()
    for line in problems:
        print(f"  FAIL  {line}")
    print(f"\n{len(problems)} problem(s).")
    sys.exit(1)

print(f"  {len(referenced)} referenced assets, all present")
print("\nAll checks passed.")
