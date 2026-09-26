# secblog — security-research blog 

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

**GitHub Pages** (free). `.github/workflows/pages.yml` publishes the posts, category and tag pages, search
and RSS on every push to `main`. Pages can only serve files, so there are no accounts there. You write posts
from `/admin` (below), and guest replies, likes and visitor stats come from a small free Cloudflare server
(see [Comments, likes & visitor stats](#comments-likes--visitor-stats)).
1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions** (one time; the deploy fails
   until this is set).
2. Push to `main`, or re-run the workflow from the Actions tab.

The address comes from the GitHub account name: `https://<account>.github.io/<repo>`, e.g.
`obsec07.github.io/secblog`. Rename the repo to `<account>.github.io` to drop the `/secblog` part, or add a
custom domain under Settings → Pages. The workflow picks up the right URL and path automatically.

**Writing posts on the Pages site: `/admin`.** Click the log-in icon in the header, or open `/admin`, and
paste a GitHub token. You can then write, edit and delete posts. Each save is a commit to `main`, and the
site redeploys about 2 minutes later. While you're signed in, the header shows your avatar (→ `/admin`) and
a log-out button.
1. GitHub → Settings → Developer settings → **Fine-grained tokens** → *Generate new token*.
   - Repository access: **Only select repositories** → this repo. The default, *Public repositories
     (read-only)*, can't save anything.
   - Permissions → Repository permissions → **Contents: Read and write**.
2. Paste it into the **Access token** field on `/admin`. Tick *Keep me signed in* to stay logged in on that
   device. The token stays in your browser and is only sent to GitHub, and to your own comments server
   (which asks GitHub whether the token may write to this repo, and keeps only a hash of it).

`/admin` checks the token before letting you in. If GitHub won't let it save, the page says what to
change on the token. Never paste the token anywhere else.

`/admin` has five tabs:
- **Posts**: write, edit and delete posts.
- **Profile**: your username (logo, posts, hover card, `/members/<name>/`), photo (cropped to 320×320),
  title, about text, member-since date, contact email, and links. The links cover GitHub, Medium,
  Instagram, LinkedIn, YouTube, HackerOne, Bugcrowd, TryHackMe, Hack The Box and a website; empty
  ones are hidden.
- **Site**: site name, description, a home-page announcement, the name and description of each blog,
  and the Who Am I text (Markdown; `{handle}` becomes your username).
- **Analytics**: visitors and page views over 24 hours / 7 / 30 / 90 days, who's online, top pages, the
  sites people came from, countries, cities, devices, browsers and operating systems. Below that, every
  visitor (one per guest cookie) with their IP address, location, network, device and what they read, and
  the raw log of recent visits. You can block an IP from there.
- **Comments**: every guest reply with its IP address and location. Delete replies, block an IP (and
  delete everything it posted), and see and lift blocks.

Analytics and Comments need the comments server; until it's set up they show the setup steps.

These settings are stored in `src/data/settings.json`, `src/data/whoami.md` and `public/owner.jpg`, so you
can also edit them in the repo. The build checks them and falls back to a default for any value that's
missing or invalid, such as a link that isn't http(s). After a save, `/admin` shows the deploy and says
when the change is live.

*Optional: username + password instead of the token.* The Pages build can encrypt the token with a
username and password and publish only the encrypted copy (`/admin/vault.json`). A password form then
appears under the token field and decrypts the token in your browser. To set it up:
1. In this repo: Settings → Secrets and variables → Actions → **Secrets** → add:
   - `ADMIN_PASSWORD`: your admin password.
   - `ADMIN_TOKEN`: a token made as above.
2. Optional: under **Variables**, add `ADMIN_USERNAME`. The default is `t0b!`.
3. Actions → **Deploy to GitHub Pages** → Run workflow.

> Anyone can download the encrypted token and try passwords against it offline, so the password is what
> protects it. Use a long passphrase. If the token leaks, someone can edit this repo's content (not its
> workflows): revoke the token on GitHub and set a new one.

User accounts exist only on the Node server (`/admin-panel`).

### Comments, likes & visitor stats
Guests can reply to posts and like them without an account, and `/admin` shows who visits: IP address,
location, pages, devices. GitHub Pages can't store any of that, so a small server does: a Cloudflare Worker
with a D1 (SQLite) database, in `api/`. Cloudflare's free plan covers a blog easily (100,000 requests a day)
and needs no card. The Pages workflow deploys the server and wires the site to it; you only give it access
once. It works from a phone:
1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
2. **My Profile → API Tokens → Create Token → Edit Cloudflare Workers** (Use template). Under Permissions,
   **+ Add more → Account · D1 · Edit**. Continue to summary → Create Token, and copy it.
3. This repo → **Settings → Secrets and variables → Actions → New repository secret**:
   name `CLOUDFLARE_API_TOKEN`, value the token.
4. `/admin` → Analytics → **Connect now** (or Actions → Deploy to GitHub Pages → Run workflow, or save any
   post). About 2 minutes later the site has replies and likes, and `/admin` has the stats.

The first deploy picks a `<name>.workers.dev` address for the account if it has none, creates the database
and deploys the Worker. Later deploys only redeploy it when `api/` or the settings it uses (site address,
repo, username) changed. If an update fails, the running version stays, and a Cloudflare problem never
stops the site itself from deploying.
If the token can reach several Cloudflare accounts, add a `CLOUDFLARE_ACCOUNT_ID` secret to pick one.

How it works:
- **Guests** get one cookie, `guest`: a random id (no personal data) that remembers their likes, lets them
  delete their own replies and counts unique visitors. Each page view is recorded with the visitor's IP
  address, Cloudflare's location for it (country, region, city, network), browser, OS, device, screen
  size, language and the site they came from. Bots and crawlers are counted separately; your own visits
  while signed in to `/admin` aren't counted. Visits are deleted after 90 days, and so are the IP
  addresses stored with replies.
- **Replies** are plain text with the guest's chosen name and a letter avatar. Spam protection: a hidden
  field bots fill in, a minimum time on the page, at most 3 replies per 2 minutes and 20 a day per IP,
  at most 3 links, no duplicates, no replies to posts that don't exist, and IP blocks from `/admin`.
  Guests can't use your username. Signed in to `/admin`, you reply as the author (your photo and an
  **Author** badge) and can delete any reply right on the post.
- **Privacy:** IP addresses and locations are only ever shown in `/admin`. The server checks your GitHub
  token for that, the same way `/admin` does at login. The cookie notice mentions the tracking and links
  to a `/privacy` page that explains it.
- To turn it all off, delete the `CLOUDFLARE_API_TOKEN` secret: the next deploy builds the site without
  replies, likes or tracking. The data stays in Cloudflare (Workers & Pages → `secblog-api`, and D1 →
  `secblog`) until you delete it there.

Local development: `cd api && npx wrangler dev` runs the Worker with a local database; build the site with
`PUBLIC_API_URL=http://localhost:8787` to point it there.

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
This runs the integration tests in `test/`. They build a throwaway copy of the project with a test post of
its own and start the server against it. Your real posts and database are never touched, and adding or
deleting posts can't break the tests. They cover auth, sessions, rate
limiting, path handling and posting rules. The comments server (`api/`) is tested in Node against an
in-memory stand-in for its database (replies, likes, spam limits, visit tracking, the admin stats, IP
blocks and clean-up), and its deploy script against a fake Cloudflare. CI (`.github/workflows/ci.yml`) runs
them on every push.
