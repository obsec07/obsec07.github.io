# secblog — static security-research blog (0x90.sh-style)

Dark, terminal-themed blog for **CTF writeups, 0day/CVE research, infosec notes and tools**.
Static (Astro) → **free forever on GitHub Pages**. No backend, no database, nothing to pay for.

> The reference site (0x90.sh) runs XenForo, a paid PHP forum that can't be hosted for free.
> This is the free equivalent with the same look + the same sections and does the one thing that
> matters: publish writeups.

## Run locally
```bash
npm install
npm run dev        # http://localhost:4321
```

## Add a post / walkthrough
Create a markdown file in `src/content/posts/`:
```md
---
title: "HTB Blazorized — auth bypass"
date: 2026-08-08
category: ctf          # 0day | ctf | infosec | tools
description: "one-liner shown on the list"
tags: [htb, web, jwt]
---
Your writeup in markdown. Code blocks are syntax-highlighted.
```
Save → it appears on the homepage, its category page (`/ctf`), and any `#tag` pages. Set
`draft: true` to hide a work-in-progress.

## Make it yours
- `src/config.ts` — handle, title, socials, email, nav.
- `src/pages/whoami.astro` — your about page.
- `src/styles/global.css` — colors are CSS variables at the top (`--accent`, `--bg`, …).

## Deploy free to GitHub Pages
1. In `astro.config.mjs` set:
   - `site: 'https://<user>.github.io'` and `base: '/<repo>'` for a project repo,
     **or** `base: '/'` for a `<user>.github.io` repo / custom domain.
2. Push to a GitHub repo's `main` branch.
3. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. The included workflow (`.github/workflows/deploy.yml`) builds + publishes on every push.

That's it — future posts go live automatically when you `git push`.
