---
title: "From Zero to Admin: How I Escalated Privileges"
date: 2026-03-06
category: 0day
description: "An unauthenticated admin panel, a role field with no server-side validation, and a full administrative takeover — a beginner bug-hunting walkthrough."
tags: [privilege-escalation, access-control, admin-panel, web, writeup]
---

A walkthrough of how an unauthenticated admin panel, a creative hypothesis, and a role field with no validation led to full administrative takeover.

> Target anonymised as `example.com`. This finding turned out to be a duplicate, but the full chain — from unauthenticated access through to privilege escalation — was worth documenting.

## Introduction

Not every critical vulnerability requires a sophisticated exploit chain. Sometimes all it takes is curiosity, methodical thinking, and a browser.

During a security assessment of `example.com`, I found an unauthenticated admin dashboard. On the surface it looked limited — a mostly empty UI with little visible impact. Instead of marking it low severity and moving on, I kept digging. That decision led to a full administrative takeover through privilege escalation, using nothing more than the application's own user-management features against itself.

## Phase 1 — The open door: unauthenticated admin access

Navigating directly to the admin dashboard redirected me to the login page:

```
GET https://example.com/admin/dashboard   →   302 https://example.com/login
```

Standard behaviour — nothing unusual yet. I registered a normal user account and logged in. After authentication, something stood out in the navigation: an **Admin Dashboard** link. I clicked it, and the page loaded.

But it was underwhelming — a mostly bare UI, no sensitive data on screen, no obvious "critical finding" staring back. This is the point where many assessments move on. I didn't.

## Phase 2 — Finding the real surface: user management

Rather than dismissing the panel as low impact, I explored further. Buried in the interface was a **User Management** section. I tested what it actually allowed:

- **Create a user** — confirmed. Arbitrary accounts could be provisioned through the panel. No secondary authorisation, no email verification, instant provisioning.
- **Delete a user** — confirmed. Existing accounts could be removed directly. No confirmation prompt, no audit challenge.

That changed the severity picture. The admin panel wasn't a cosmetic UI leak — it was a fully functional user-management interface reachable without proper authorisation checks.

Then a question formed: if I can create users and assign attributes freely, what happens if I create an account and set its role to `admin`?

## The hypothesis that changed everything

The logic was simple:

1. I can create users.
2. I can set roles.
3. Nothing appears to stop me assigning the `admin` role to an account I control.

So what happens if I do exactly that?

## Steps taken

**Step 1 — Create a controlled account with an admin role.** Using the user-management panel, I created a new account and set the role field directly:

```
Email:  attacker@example.com
Name:   TestAccount
Role:   admin
```

The role field accepted the value without restriction — no warning, no rejection, no additional authorisation prompt.

**Step 2 — Log in through the normal login page.** I went to `https://example.com/login` and authenticated with the credentials I had just created.

**Step 3 — Full admin session confirmed.** It worked. I was now a fully authenticated administrator, granted through the application's own auth system. The session carried privileges well beyond the original unauthenticated view — deeper configuration access, broader user controls, and administrative capabilities not visible to anonymous sessions.

What started as a "mostly empty UI" had become a complete administrative takeover.

## Root cause

Two independent failures chained together:

- **Broken access control on the admin panel** — the user-management endpoints trusted the presence of a session rather than checking the caller's privilege level, so a normal account could reach them.
- **A client-trusted role field** — the account-creation flow wrote the `role` value straight from the request with no server-side allow-list, so a caller could grant itself `admin`.

## Key takeaways

The most important lesson here isn't technical — it's mindset. When the dashboard first loaded as a bare, unimpressive UI, the easy call was to log a low-severity note and move on. The critical finding only emerged by asking: *"What can I actually do here, and what happens if I push it further?"*

- **Never judge impact by first appearance.** An empty UI can still expose dangerous functionality underneath.
- **Follow the logic, not just the UI.** If you can create users and set attributes, reason through every combination that allows.
- **Enforce authorisation on every endpoint**, not just the ones with a visible link.
- **Role and permission values must never be trusted from the client.** Validate them against a server-side allow-list, every time.
- **Patch and clean-up are separate steps.** Fixing the code does not undo data-level impact that may already exist — audit for accounts created during the exposure window.

After submitting the report I learned the issue had already been found by another researcher. It was a duplicate, but discovering and documenting the full chain — from unauthenticated access to privilege escalation — was an invaluable learning experience as a beginner bug hunter. I hope it's still a useful reference. Until the next one — happy hunting. 🐛
