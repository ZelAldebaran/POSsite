# Security

## What is intentionally public

This repository is public and contains no credentials. Two things look like
secrets and are not:

- **`supabase-config.js`** holds the project URL and a key beginning
  `sb_publishable_`. This key is designed to be public — it is already sent to
  every browser that loads the site. It identifies the project; it does not
  grant access.
- **`supabase/migrations/`** contains the schema, the RLS policies and the
  bodies of the `SECURITY DEFINER` functions. Access control does not depend
  on these being secret.

There is no `service_role` key anywhere in this repository, and there must
never be one. That key bypasses RLS entirely. It belongs in the Supabase
dashboard and nowhere else.

## What actually protects the data

Row Level Security is enabled on every table. The browser talks to Postgres
directly, so the grants and policies *are* the access control layer:

- `anon` (a diner with no account) holds column-scoped `SELECT` on three
  tables only — `categories`, `items`, `settings` — and only the columns the
  printed menu needs. It has no access of any kind to `sales`, `sale_lines`,
  `staff`, `admins` or `counters`.
- `authenticated` cannot write `sales` or `sale_lines` at all. Bills are
  written only by `create_order()` and `void_sale()`, both `SECURITY DEFINER`.
- New sign-ups cannot take an order until an admin approves them; the gate is
  inside `create_order()`, not in the page, so it cannot be clicked past.
- Cashiers never receive admin email addresses in any query.

Widening a column grant and widening a policy are two separate mistakes that
each re-expose data on their own. Check both together.

## Reporting a problem

Open a private security advisory through GitHub, or contact the restaurant
directly. Please do not open a public issue for anything exploitable.
