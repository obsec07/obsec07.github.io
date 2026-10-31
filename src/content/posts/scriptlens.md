---
title: ScriptLens - JavaScript endpoint, secret and DOM XSS finder
date: '2026-10-31'
category: tools
description: 'Point it at a domain: it pulls every script the site loads, lists the API endpoints with ready curl templates, flags leaked keys, and (with --dynamic) confirms DOM XSS in a real browser.'
tags:
  - tool
  - javascript
  - recon
  - xss
draft: false
---

**Find the API endpoints, leaked keys and DOM XSS hiding in a site's JavaScript, from one command.**

Check it out on GitHub: [github.com/obsec07/scriptlens](https://github.com/obsec07/scriptlens)

Modern web apps ship their whole API surface to your browser: every route, request body and header lives somewhere in a minified bundle. ScriptLens downloads a page, follows every script it loads (including the CDN-hosted bundles and their source maps), parses the JavaScript and TypeScript properly instead of grepping it, and gives you a clean list of requests with the method, URL, body fields and a curl template for each.

## What it finds

- **Endpoints**: `fetch`, Axios (including instances and base URLs), jQuery AJAX, XHR, `new Request`, beacons, WebSockets and EventSource, with headers, query parameters and JSON or form bodies when they can be recovered.
- **GraphQL**: queries and mutations, with their variables, from request bodies and `gql` templates.
- **Leaked credentials**: GitHub and Stripe token formats, private keys, and hardcoded secrets with a real secret shape. Error messages and labels are not reported as keys.
- **DOM XSS clues**: URL, referrer and `postMessage` data flowing into `innerHTML`, `eval`, redirects or request URLs.

## Dynamic mode

With `--dynamic`, every page you give it is also opened in headless Chromium:

- The requests the page really makes are recorded. **POST, PUT, PATCH and DELETE are captured and blocked, never sent.**
- Scripts that only load at runtime (lazy webpack chunks, computed imports) are analyzed too.
- A harmless marker goes into the URL. `[XSS]` is printed only when that marker reaches an HTML sink unescaped **and** becomes a real element in the page, so a hit is an observed flow, not a guess.

## Install and run

```bash
git clone https://github.com/obsec07/scriptlens.git && cd scriptlens
python3 -m venv .venv && source .venv/bin/activate
python -m pip install '.[dynamic]' && python -m playwright install chromium

scriptlens -u example.com
scriptlens -u subdomains.txt
scriptlens -u https://app.example.com/ --dynamic
```

```text
[XSS] query parameter 'q' reaches innerHTML unescaped; injected element present in the page  main.js:6
[POST] https://app.example.com/api/cart  body: sku, qty  (seen at runtime, blocked)
[GET] https://app.example.com/api/session  (seen at runtime)
Done: 5 scripts, 3 endpoints (3 seen at runtime), 1 review item, 1 confirmed XSS, 0 incomplete.
```

Everything is also saved as JSON (endpoints, curl templates, findings with file and line, and diagnostics) in `scriptlens-results/`.

## Built to stay quiet

Analytics, ads and public library CDNs are skipped, so their code doesn't show up as the target's endpoints. Secrets are redacted in the report, cookies are never reused, private addresses are blocked, and the endpoints it extracts are never called. Static clues are review hints, not vulnerability claims. Use it only on targets you are authorized to test.

[Check it out on GitHub!](https://github.com/obsec07/scriptlens)
