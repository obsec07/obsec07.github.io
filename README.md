# secblog — security-research blog (0x90.sh-style)

Forum-style blog for **CTF writeups, 0day/CVE research, infosec notes and tools**.

- **Astro** builds the public pages from markdown in `src/content/posts/`.
- **`admin/server.js`** (Express) serves them and adds accounts, comments and likes, member profiles, and an
  admin panel with a post editor. Data lives in SQLite through Node's built-in `node:sqlite`, so there is no
  database server to run.

Requires **Node ≥ 22.13**. Earlier 22.x releases only enable `node:sqlite` behind a flag.

## Run locally
```bash
npm install
npm start          # build + full app (accounts, comments, admin)  -> http://localhost:4331
npm run dev        # static preview with hot reload, no accounts     -> http://localhost:4321
```
The admin account is created on first start. If `ADMIN_PASSWORD` isn't set, a random password is printed
once in the console, so save it.

## Add a post
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
It appears on the homepage, its category page (`/ctf`), and any `#tag` pages. Set `draft: true` to hide a
work-in-progress.

You can also write posts in the browser: **/admin-panel → + New post**. The server rebuilds the site a few
seconds after each save.

**Other people's posts:** anyone can register and comment. Posting needs your approval ("Allow posting" in
the admin panel). Approved users' posts arrive as drafts that you publish.

## Configuration
All optional, set as environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4331` | Port to listen on (hosts usually set this). |
| `ADMIN_USERNAME` / `ADMIN_EMAIL` | `t0b!` / `admin@example.com` | The primary admin account. |
| `ADMIN_PASSWORD` | random, printed once | Only used when the admin account is **first created**. |
| `JWT_SECRET` | random, saved to `DATA_DIR/.secret` | Session signing key. Keep it stable or everyone is logged out. |
| `DATA_DIR` | `admin/` | Where `app.db` and `.secret` live. Point it at a persistent disk in production. |
| `TRUST_PROXY` | `1` | Number of reverse proxies in front of the app, used to find the real client IP for rate limits and logs. Use `0` if the app is exposed directly. |
| `SITE_URL` | Render's URL, else `http://localhost:4331` | Public URL used in RSS and sitemap links. |

Customize the site:
- `src/config.ts`: handle, title, socials, email, nav.
- `src/pages/whoami.astro`: your about page.
- `src/styles/global.css`: colors are CSS variables at the top (`--accent`, `--bg`, …).

## Deploy
**Render:** Dashboard → New → Blueprint → pick this repo. It reads `render.yaml`. Then set `ADMIN_PASSWORD`
under the service's Environment tab.

**GitHub Pages** (free, read-only copy of the blog). `.github/workflows/pages.yml` publishes the posts, category
and tag pages, search and RSS on every push to `main`. Pages can only serve files, so there are no accounts,
comments, likes or admin panel there. Those keep running on the Node deployment.
1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions** (one time; the deploy fails
   until this is set).
2. Push to `main`, or re-run the workflow from the Actions tab.

The address comes from the GitHub account name: `https://<account>.github.io/<repo>`, e.g.
`obsec07.github.io/secblog`. Rename the repo to `<account>.github.io` to drop the `/secblog` part, or add a
custom domain under Settings → Pages. The workflow picks up the right URL and path automatically.

**Writing posts on the Pages site: `/admin`.** Log in with your admin username and password to write,
edit and delete posts. Each save is a commit to `main`, and the site redeploys about 2 minutes later.
A static site has no server to check passwords, so the Pages build encrypts a GitHub token with your
username and password and publishes only the encrypted copy (`/admin/vault.json`). Logging in decrypts it
in your browser. One-time setup:
1. GitHub → Settings → Developer settings → **Fine-grained tokens** → *Generate new token*.
   - Repository access: **Only select repositories** → this repo.
   - Permissions: **Contents: Read and write**.
2. In this repo: Settings → Secrets and variables → Actions → **Secrets** → add:
   - `ADMIN_PASSWORD`: your admin password.
   - `ADMIN_TOKEN`: the token from step 1.
3. Optional: under **Variables**, add `ADMIN_USERNAME`. The default is `t0b!`.
4. Actions → **Deploy to GitHub Pages** → Run workflow.

> Anyone can download the encrypted token and try passwords against it offline, so the password is what
> protects it. Use a long passphrase. If the token leaks, someone can edit this repo's content (not its
> workflows): revoke the token on GitHub and set a new one.

Users, comments and the full admin panel exist only on the Node server (`/admin-panel`).

**Docker** (Fly.io, Railway, a VPS, …):
```bash
docker build -t secblog .
docker run -p 8080:8080 -e ADMIN_PASSWORD='…' -v secblog-data:/app/data secblog
```

> **Storage:** accounts, comments and admin-panel posts are written to the server's disk. Hosts with
> ephemeral disks, including Render's free plan, wipe them on every deploy or restart. Keep `DATA_DIR` on a
> persistent disk or volume. Posts written in the admin panel are saved under `src/content/posts/` on the
> server, not in git, so copy anything you want to keep into the repo.

## Tests
```bash
npm test
```
This builds the site, then runs the integration tests in `test/`. They start the server against a throwaway
copy of the project, so your real posts and database are never touched. They cover auth, sessions, rate
limiting, path handling and posting rules. CI (`.github/workflows/ci.yml`) runs them on every push.
