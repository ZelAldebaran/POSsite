# READ BEFORE PUSHING THIS ANYWHERE

**This bundle is built on an out-of-date snapshot of your repo. Do not push it
over your live repository without reconciling it first.**

The brand work, the Vercel config and the tooling in here are current and
correct. The application code and the migrations are not.

## What is out of date

I checked project `uyhbtubxmycofdyuajkn` directly. Production has **16**
recorded migrations. This bundle has **9**. Missing:

| Version | Name |
|---|---|
| 20260823040000 | `freddys_drop_stock_and_void_audit` |
| 20260823043634 | `freddys_staff_approval_gate` |
| 20260823043657 | `freddys_create_order_requires_approval` |
| 20260823050013 | `freddys_delete_category` |
| 20260823075505 | `freddys_reset_guard_bill_numbering` |
| 20260823082302 | `freddys_reset_safeupdate_where_clause` |
| 20260823083646 | `freddys_charge_confirmation_setting` |

The frontend matches that older state. Concretely:

- `assets/app.js` writes `items.stock`. The live `items` table has no `stock`
  column — it is `id, cat, name, size, price, active, created_at, updated_at`.
  This is the pre-stock-removal build.
- `inventory.html` is the old stock page. Stock was replaced by order-quantity
  reporting through the `item_order_totals` view, which nothing in this
  bundle's `app.js` references.
- The void-bill admin gate, the staff approval gate, category deletion and the
  charge-confirmation setting are all live in the database but absent here.

Running `supabase db push` from this state is unpredictable. Do not.

## What is current and safe to take

Everything in the overlay bundle, which is the same set of files:

```
assets/brand/          the logo, the mark, every icon size, the OG card
favicon.ico
site.webmanifest
vercel.json            headers, caching, build settings pinned
.gitignore             renamed from _gitignore, which ignored nothing
.vercelignore
.github/workflows/ci.yml
scripts/apply_brand.py
scripts/check_assets.py
LICENSE
SECURITY.md
```

## The safe path

Use the **overlay** bundle against your real repo instead of this one. It
contains only the files above, plus `scripts/apply_brand.py`, which applies the
page edits to whatever your current pages look like rather than replacing them.

This bundle is here so you can see the finished result end to end — how the
patched pages come out, and how the brand CSS sits in `freddys.css`. Treat it
as a reference build, not a deployable one.

## To get a genuinely complete project

Send me your current repo as a zip and I will redo this properly in one pass:
the brand work applied to the real pages, and `supabase/migrations/`
reconciled against the 16 migrations actually recorded in production.
