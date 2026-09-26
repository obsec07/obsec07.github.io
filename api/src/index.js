// Comments, likes and visitor stats for the static blog. GitHub Pages only serves files, so this small Cloudflare
// Worker (with a D1 / SQLite database) stores them. It is deployed by .github/workflows/pages.yml (see deploy.mjs).
//
// Public — called by the site's pages. Nothing here ever returns an IP address or someone else's guest id.
//   GET  /health                              { ok, version }
//   POST /hit                                 a page view: { path, ref, title, guest, lang, screen }
//   GET  /posts/:slug?g=<guest>               { comments (newest 500), total, likes, liked, form }
//   POST /posts/:slug/comments                { guest, name, body, form, trap }; the owner adds Authorization. `form` is the
//                                             signed token from the GET (at least 3s old: bots have to load and wait),
//                                             `trap` a hidden field only bots fill in
//   POST /posts/:slug/comments/:id/delete     { guest }: your own comment (the owner: any)
//   POST /posts/:slug/like                    { guest, like }
//   GET  /counts?posts=a,b                    { a: { comments, likes }, … }
// Admin — Authorization: Bearer <the GitHub token /admin signs in with>. The token is checked with GitHub (its user
// has push rights on the repo, and the token itself can write there) and only its SHA-256 is kept, to skip that check
// for the next 30 minutes.
//   GET  /admin/me, /admin/stats, /admin/visits, /admin/visitors, /admin/comments, /admin/blocks
//   POST /admin/comments/:id/delete, /admin/blocks, /admin/blocks/delete
//
// Guests are told apart by the random id in their `guest` cookie (set by the site). IP addresses and locations come
// from Cloudflare (CF-Connecting-IP, request.cf). Visits older than RETENTION_DAYS (default 90) are deleted daily, and
// so are the IP address + location stored with older comments and the IP address stored with older likes.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, path TEXT NOT NULL, title TEXT,
    referrer TEXT, ref_host TEXT, guest TEXT, ip TEXT,
    country TEXT, region TEXT, city TEXT, lat REAL, lon REAL, timezone TEXT, asn INTEGER, org TEXT,
    browser TEXT, os TEXT, device TEXT, ua TEXT, lang TEXT, screen TEXT, bot INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS visits_ts ON visits (ts)',
  'CREATE INDEX IF NOT EXISTS visits_ip_ts ON visits (ip, ts)',
  'CREATE INDEX IF NOT EXISTS visits_guest ON visits (guest, ts)',
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, post TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL,
    owner INTEGER NOT NULL DEFAULT 0, guest TEXT, ip TEXT, country TEXT, region TEXT, city TEXT)`,
  'CREATE INDEX IF NOT EXISTS comments_post ON comments (post, ts)',
  'CREATE INDEX IF NOT EXISTS comments_ip_ts ON comments (ip, ts)',
  'CREATE INDEX IF NOT EXISTS comments_guest ON comments (guest, ts)',
  `CREATE TABLE IF NOT EXISTS likes (post TEXT NOT NULL, guest TEXT NOT NULL, ts INTEGER NOT NULL, ip TEXT, PRIMARY KEY (post, guest))`,
  'CREATE INDEX IF NOT EXISTS likes_ip_ts ON likes (ip, ts)',
  'CREATE INDEX IF NOT EXISTS likes_guest ON likes (guest)',
  'CREATE INDEX IF NOT EXISTS likes_ts ON likes (ts)',
  `CREATE TABLE IF NOT EXISTS blocks (ip TEXT PRIMARY KEY, ts INTEGER NOT NULL, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS admin_tokens (hash TEXT PRIMARY KEY, until INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,   // schema version, the form-token key
];
const SCHEMA_VERSION = '1';

const LIMITS = { name: 40, body: 2000, links: 3, perPost: 500 };
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const empty = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
const now = () => Date.now();

// First request per isolate: one small read of `meta`. Only a new database (or a new SCHEMA_VERSION) runs the
// CREATE statements, so a new deploy needs no separate migration step. Also loads the key that signs form tokens.
const state = new WeakMap();
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function readMeta(env) {
  try { return Object.fromEntries((await env.DB.prepare('SELECT k, v FROM meta').all()).results.map((r) => [r.k, r.v])); } catch { return {}; }
}
async function init(env) {
  let meta = await readMeta(env);
  if (meta.schema !== SCHEMA_VERSION || !meta.form_key) {
    await env.DB.batch([...SCHEMA.map((s) => env.DB.prepare(s)),
      env.DB.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind('form_key', hex(crypto.getRandomValues(new Uint8Array(32)))),
      env.DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind('schema', SCHEMA_VERSION)]);
    meta = await readMeta(env);
  }
  const raw = Uint8Array.from(meta.form_key.match(/../g), (h) => parseInt(h, 16));
  return { formKey: await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) };
}
function ready(env) {
  let p = state.get(env.DB);
  if (!p) { p = init(env).catch((e) => { state.delete(env.DB); throw e; }); state.set(env.DB, p); }
  return p;
}

async function readBody(req) {
  if (Number(req.headers.get('content-length')) > 20000) throw new HttpError(413, 'Too long.');
  const text = await req.text();
  if (text.length > 20000) throw new HttpError(413, 'Too long.');
  try { const v = JSON.parse(text || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const GUEST_RE = /^[a-f0-9]{32}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/i;
const isGuest = (g) => typeof g === 'string' && GUEST_RE.test(g);

// ---- who is asking ----
function parseUA(ua) {
  const bot = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pagespeed|curl\/|wget|python|go-http|java\/|okhttp|axios|node-fetch|undici|httpclient|scrapy|phantom|puppeteer|playwright/i.test(ua) || !ua;
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Brave/.test(ua) ? 'Brave' : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari' : 'Other';
  const device = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'Tablet' : /Mobi|iPhone|iPod/.test(ua) ? 'Mobile' : 'Desktop';
  return { bot, os, browser, device };
}
function client(req) {
  const cf = req.cf || {}, ua = (req.headers.get('user-agent') || '').slice(0, 400);
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    ip: req.headers.get('cf-connecting-ip') || '',
    country: cf.country || null, region: cf.region || null, city: cf.city || null,
    lat: num(cf.latitude), lon: num(cf.longitude), timezone: cf.timezone || null,
    asn: num(cf.asn), org: cf.asOrganization || null, ua, ...parseUA(ua),
  };
}

// ---- which sites may call this API (the blog itself; ALLOWED_ORIGINS adds more, "*" allows any; none set: none) ----
function origins(env) {
  const list = new Set();
  if (env.SITE_URL) { try { list.add(new URL(env.SITE_URL).origin); } catch {} }
  for (const o of String(env.ALLOWED_ORIGINS || '').split(',')) if (o.trim()) list.add(o.trim().replace(/\/+$/, ''));
  return list;
}
function allowedOrigin(origin, env) {
  if (!origin) return null;
  const list = origins(env);
  return list.has('*') || list.has(origin) ? origin : null;
}

// ---- posts that exist on the site (its /search-index.json), so nobody can comment on made-up pages ----
let index = { at: 0, slugs: null };
async function postExists(slug, env) {
  if (!SLUG_RE.test(slug)) return false;
  if (!env.SITE_URL) return true;
  const age = now() - index.at;
  if (!index.slugs || age > 5 * MIN || (!index.slugs.has(slug) && age > 30e3)) {   // a just-published post shows up within 30s
    try {
      const r = await fetch(new URL('search-index.json', env.SITE_URL.replace(/\/*$/, '/')), { headers: { 'user-agent': 'secblog-api' } });
      if (r.ok) index = { at: now(), slugs: new Set((await r.json()).map((p) => String(p.url || '').replace(/\/+$/, '').split('/').pop())) };
    } catch {}
  }
  return index.slugs ? index.slugs.has(slug) : true;   // site unreachable: don't lock comments
}

// ---- the owner: a GitHub token that can write to the blog's repo (the same two checks /admin does at login) ----
const TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;
const refused = new Map();   // hash -> until: tokens GitHub just said no to (not asked again for a minute)
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function isAdmin(req, env) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '');
  if (!m || !TOKEN_RE.test(m[1]) || !env.GITHUB_REPO) return false;
  const hash = await sha256(m[1]);
  const row = await env.DB.prepare('SELECT until FROM admin_tokens WHERE hash = ?').bind(hash).first();
  if (row && row.until > now()) return true;
  if ((refused.get(hash) || 0) > now()) return false;
  const api = (env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${m[1]}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'secblog-api' };
  const no = () => { if (refused.size > 1000) refused.clear(); refused.set(hash, now() + MIN); return false; };
  const odd = (status) => new HttpError(502, `Couldn't check your sign-in with GitHub (${status}). Try again in a minute.`);
  // 1. whose token is it: they must be allowed to push to the repo (any GitHub user's token can read a public repo)
  const repo = await fetch(`${api}/repos/${env.GITHUB_REPO}`, { headers });
  if ([401, 403, 404].includes(repo.status)) return no();
  if (!repo.ok) throw odd(repo.status);
  const perms = (await repo.json().catch(() => ({}))).permissions || {};
  if (!(perms.push || perms.maintain || perms.admin)) return no();
  // 2. can this token write: a PUT with no file content changes nothing; 422 = allowed, 401/403/404 = not
  const r = await fetch(`${api}/repos/${env.GITHUB_REPO}/contents/src/content/posts/.admin-write-check`, {
    method: 'PUT', headers, body: JSON.stringify({ message: 'write check', branch: 'main' }),
  });
  if (r.status === 422) {
    await env.DB.prepare('INSERT OR REPLACE INTO admin_tokens (hash, until) VALUES (?, ?)').bind(hash, now() + 30 * MIN).run();
    return true;
  }
  if ([401, 403, 404].includes(r.status)) return no();
  throw odd(r.status);
}
async function needAdmin(req, env) {
  if (!(await isAdmin(req, env))) throw new HttpError(401, 'Your admin sign-in was not accepted. Log out of /admin and in again.');
}

// short bursts per IP, in this isolate's memory: likes and deletes write to the database, so they're capped too
const bursts = new Map();
function burst(kind, ip, max, ms) {
  if (!ip) return false;
  const k = `${kind}:${ip}`, t = now();
  let e = bursts.get(k);
  if (!e || t - e.at > ms) { if (bursts.size > 5000) bursts.clear(); e = { at: t, n: 0 }; bursts.set(k, e); }
  return ++e.n > max;
}

// ---- form tokens: GET /posts/:slug hands one out; a reply must bring it back, at least 3 seconds later ----
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const enc = new TextEncoder();
async function formToken(env, slug) {
  const { formKey } = await ready(env), ts = now();
  return `${ts}.${b64url(await crypto.subtle.sign('HMAC', formKey, enc.encode(`${slug}.${ts}`)))}`;
}
async function checkForm(env, slug, token) {
  const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(typeof token === 'string' ? token : '');
  const { formKey } = await ready(env);
  if (!m || !(await crypto.subtle.verify('HMAC', formKey, unb64url(m[2]), enc.encode(`${slug}.${m[1]}`)))) throw new HttpError(400, 'Reload the page and try again.');
  const age = now() - Number(m[1]);
  if (age < 3000) throw new HttpError(400, 'That was quick! Wait a moment and post again.');
  if (age > DAY) throw new HttpError(400, 'This page has been open a long time. Reload it and post again.');
}

const isBlocked = async (env, ip) => !!ip && !!(await env.DB.prepare('SELECT 1 x FROM blocks WHERE ip = ?').bind(ip).first());
async function count(env, sql, ...args) { return (await env.DB.prepare(sql).bind(...args).first()).n; }

// ---- page views ----
// a path on this site only: '/\\evil.com' or '/<tab>/evil.com' would become //evil.com in a link, so anything with a
// backslash, whitespace or a control character is dropped, and what's kept is the parsed, percent-encoded path
function cleanPath(p) {
  if (typeof p !== 'string' || !/^\/(?!\/)/.test(p) || /[\\\s\u0000-\u001f\u007f]/.test(p)) return '';
  let u;
  try { u = new URL(p, 'https://site.invalid'); } catch { return ''; }
  return u.origin === 'https://site.invalid' && !u.pathname.startsWith('//') ? u.pathname.slice(0, 300) : '';
}
function externalRef(ref, env) {
  let u;
  try { u = new URL(String(ref || '')); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || origins(env).has(u.origin)) return null;   // internal clicks aren't referrers
  return { referrer: (u.host + u.pathname).slice(0, 200), host: u.host.replace(/^www\./, '').slice(0, 100) };
}
async function hit(req, env) {
  const b = await readBody(req), c = client(req), path = cleanPath(b.path);
  if (!path) return empty();
  if (c.ip && (await count(env, 'SELECT COUNT(*) n FROM visits WHERE ip = ? AND ts > ?', c.ip, now() - 10 * MIN)) >= 120) return empty();
  const ref = externalRef(b.ref, env);
  const screen = /^\d{2,5}x\d{2,5}$/.test(b.screen) ? b.screen : null;
  await env.DB.prepare(`INSERT INTO visits (ts, path, title, referrer, ref_host, guest, ip, country, region, city, lat, lon, timezone, asn, org,
      browser, os, device, ua, lang, screen, bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(now(), path, str(b.title, 200) || null, ref && ref.referrer, ref && ref.host, isGuest(b.guest) ? b.guest : null, c.ip || null,
      c.country, c.region, c.city, c.lat, c.lon, c.timezone, c.asn, c.org, c.browser, c.os, c.device, c.ua || null,
      str(b.lang, 20) || null, screen, c.bot ? 1 : 0)
    .run();
  return empty();
}

// ---- comments + likes ----
const shape = (row, guest) => ({ id: row.id, name: row.name, body: row.body, ts: row.ts, owner: !!row.owner, mine: !!guest && row.guest === guest });
function cleanText(s) {
  return (typeof s === 'string' ? s : '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
async function listComments(req, env, slug) {
  const guest = new URL(req.url).searchParams.get('g') || '';
  const [comments, total, likes, liked] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, body, ts, owner, guest FROM comments WHERE post = ? ORDER BY ts DESC, id DESC LIMIT ?').bind(slug, LIMITS.perPost),
    env.DB.prepare('SELECT COUNT(*) n FROM comments WHERE post = ?').bind(slug),
    env.DB.prepare('SELECT COUNT(*) n FROM likes WHERE post = ?').bind(slug),
    env.DB.prepare('SELECT COUNT(*) n FROM likes WHERE post = ? AND guest = ?').bind(slug, isGuest(guest) ? guest : ''),
  ]);
  return json({
    comments: comments.results.reverse().map((r) => shape(r, isGuest(guest) ? guest : '')),   // the newest, oldest first
    total: total.results[0].n, likes: likes.results[0].n, liked: liked.results[0].n > 0,
    form: SLUG_RE.test(slug) ? await formToken(env, slug) : null,
  });
}
async function addComment(req, env, slug) {
  const b = await readBody(req), c = client(req), admin = await isAdmin(req, env);
  const name = str(b.name, 200).replace(/\s+/g, ' '), body = cleanText(b.body);
  if (!admin && req.headers.get('authorization')) throw new HttpError(401, 'Your admin sign-in has expired. Log in to /admin again, then post.');
  if (!admin) {
    if (!isGuest(b.guest)) throw new HttpError(400, 'Reload the page and try again.');
    if (b.trap || b.website) throw new HttpError(400, 'Your comment was flagged as spam.');   // hidden field only bots fill in
    await checkForm(env, slug, b.form);
    if (await isBlocked(env, c.ip)) throw new HttpError(403, "Comments from your network aren't allowed.");
    if (!name) throw new HttpError(400, 'Enter a name.');
    if (env.OWNER_NAME && name.toLowerCase() === String(env.OWNER_NAME).trim().toLowerCase()) throw new HttpError(400, 'That name belongs to the site owner. Pick another.');
    if (/https?:|www\./i.test(name)) throw new HttpError(400, "Names can't contain links.");
    const recent = (ms) => count(env, 'SELECT COUNT(*) n FROM comments WHERE (ip = ? OR guest = ?) AND ts > ?', c.ip, b.guest, now() - ms);
    if ((await recent(2 * MIN)) >= 3 || (await recent(DAY)) >= 20) throw new HttpError(429, 'You are commenting too fast. Try again in a few minutes.');
  }
  if (name.length > LIMITS.name) throw new HttpError(400, `Names can be at most ${LIMITS.name} characters.`);
  if (!body) throw new HttpError(400, 'Write something first.');
  if (body.length > LIMITS.body) throw new HttpError(400, `Comments can be at most ${LIMITS.body} characters.`);
  if (!admin && (body.match(/https?:\/\//gi) || []).length > LIMITS.links) throw new HttpError(400, `At most ${LIMITS.links} links per comment.`);
  if (!(await postExists(slug, env))) throw new HttpError(404, "That post doesn't exist.");
  const guest = isGuest(b.guest) ? b.guest : null;
  if (guest && (await count(env, 'SELECT COUNT(*) n FROM comments WHERE post = ? AND guest = ? AND body = ? AND ts > ?', slug, guest, body, now() - 10 * MIN)))
    throw new HttpError(409, 'You already posted that.');
  const row = await env.DB.prepare(`INSERT INTO comments (post, name, body, ts, owner, guest, ip, country, region, city)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, name, body, ts, owner, guest`)
    .bind(slug, name || String(env.OWNER_NAME || 'admin'), body, now(), admin ? 1 : 0, guest, c.ip || null, c.country, c.region, c.city)
    .first();
  return json({ comment: shape(row, guest) }, 201);
}
async function deleteComment(req, env, slug, id) {
  const b = await readBody(req);
  if (burst('delete', client(req).ip, 20, MIN)) throw new HttpError(429, 'Too many deletes. Try again in a minute.');
  const row = await env.DB.prepare('SELECT id, guest FROM comments WHERE id = ? AND post = ?').bind(id, slug).first();
  if (!row) throw new HttpError(404, 'That comment is already gone.');
  const own = isGuest(b.guest) && row.guest === b.guest;
  if (!own && !(await isAdmin(req, env))) throw new HttpError(403, 'You can only delete your own comments.');
  await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
  return json({ ok: true });
}
async function like(req, env, slug) {
  const b = await readBody(req), c = client(req);
  if (!isGuest(b.guest)) throw new HttpError(400, 'Reload the page and try again.');
  if (burst('like', c.ip, 30, MIN)) throw new HttpError(429, 'Too many likes. Try again in a minute.');
  if (await isBlocked(env, c.ip)) throw new HttpError(403, "Likes from your network aren't allowed.");
  if (!(await postExists(slug, env))) throw new HttpError(404, "That post doesn't exist.");
  if (b.like) {
    if ((await count(env, 'SELECT COUNT(*) n FROM likes WHERE ip = ? AND ts > ?', c.ip, now() - HOUR)) >= 60) throw new HttpError(429, 'Too many likes. Try again later.');
    await env.DB.prepare('INSERT OR IGNORE INTO likes (post, guest, ts, ip) VALUES (?, ?, ?, ?)').bind(slug, b.guest, now(), c.ip || null).run();
  } else {
    await env.DB.prepare('DELETE FROM likes WHERE post = ? AND guest = ?').bind(slug, b.guest).run();
  }
  const [n, mine] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) n FROM likes WHERE post = ?').bind(slug),
    env.DB.prepare('SELECT COUNT(*) n FROM likes WHERE post = ? AND guest = ?').bind(slug, b.guest),
  ]);
  return json({ likes: n.results[0].n, liked: mine.results[0].n > 0 });
}
async function counts(req, env) {
  const slugs = [...new Set((new URL(req.url).searchParams.get('posts') || '').split(','))].filter((s) => SLUG_RE.test(s)).slice(0, 60);
  const out = Object.fromEntries(slugs.map((s) => [s, { comments: 0, likes: 0 }]));
  if (slugs.length) {
    const q = slugs.map(() => '?').join(',');
    const [cm, lk] = await env.DB.batch([
      env.DB.prepare(`SELECT post, COUNT(*) n FROM comments WHERE post IN (${q}) GROUP BY post`).bind(...slugs),
      env.DB.prepare(`SELECT post, COUNT(*) n FROM likes WHERE post IN (${q}) GROUP BY post`).bind(...slugs),
    ]);
    for (const r of cm.results) out[r.post].comments = r.n;
    for (const r of lk.results) out[r.post].likes = r.n;
  }
  return json(out, 200, { 'cache-control': 'public, max-age=30' });
}

// ---- admin ----
const WHO = "COALESCE(guest, 'ip:' || ip)";   // a visitor: their guest cookie, or their IP when they had none
function range(url) {
  const p = url.searchParams;
  const days = [1, 7, 30, 90].includes(Number(p.get('days'))) ? Number(p.get('days')) : 7;
  // the admin's UTC offset in minutes for each stretch of the range ("start:offset,…", so days stay right across a
  // daylight-saving change), or one offset (tzo). Validated whole numbers, so they can go into the SQL as they are.
  const segs = String(p.get('tz') || '').split(',').map((x) => x.split(':').map(Number))
    .filter(([t, o]) => Number.isSafeInteger(t) && Number.isInteger(o) && Math.abs(o) <= 840).slice(0, 8).sort((a, b) => a[0] - b[0]);
  const tzo = Math.max(-840, Math.min(840, Math.trunc(Number(p.get('tzo')) || 0)));
  const offset = segs.length ? segs.slice(1).reduce((acc, [t, o]) => `CASE WHEN ts >= ${t} THEN ${o} ELSE ${acc} END`, String(segs[0][1])) : String(tzo);
  return { days, since: now() - days * DAY, offset };
}
async function stats(req, env) {
  const url = new URL(req.url), { days, since, offset } = range(url);
  // 24 hours: by UTC hour (the page labels each one in local time); longer: by the admin's local day
  const bucket = days === 1 ? 'ts / 3600000' : `date(ts / 1000 + (${offset}) * 60, 'unixepoch')`;
  const V = `FROM visits WHERE ts > ? AND bot = 0`;
  const top = (col, extra = '') => env.DB.prepare(`SELECT ${col}, COUNT(*) views, COUNT(DISTINCT ${WHO}) visitors ${V} ${extra} GROUP BY ${col} ORDER BY visitors DESC, views DESC LIMIT 10`).bind(since);
  const q = [
    env.DB.prepare(`SELECT COUNT(*) views, COUNT(DISTINCT ${WHO}) visitors ${V}`).bind(since),
    env.DB.prepare(`SELECT COUNT(DISTINCT ${WHO}) n ${V}`).bind(now() - 5 * MIN),
    env.DB.prepare('SELECT COUNT(*) n FROM comments WHERE ts > ? AND owner = 0').bind(since),
    env.DB.prepare('SELECT COUNT(*) n FROM likes WHERE ts > ?').bind(since),
    env.DB.prepare('SELECT COUNT(*) n FROM visits WHERE ts > ? AND bot = 1').bind(since),
    env.DB.prepare(`SELECT ${bucket} b, COUNT(*) views, COUNT(DISTINCT ${WHO}) visitors ${V} GROUP BY b ORDER BY b`).bind(since),
    env.DB.prepare(`SELECT path, MAX(title) title, COUNT(*) views, COUNT(DISTINCT ${WHO}) visitors ${V} GROUP BY path ORDER BY views DESC LIMIT 10`).bind(since),
    top('country'),
    env.DB.prepare(`SELECT city, region, country, COUNT(*) views, COUNT(DISTINCT ${WHO}) visitors ${V} AND city IS NOT NULL GROUP BY city, region, country ORDER BY visitors DESC, views DESC LIMIT 10`).bind(since),
    top('ref_host', 'AND ref_host IS NOT NULL'),
    top('browser'), top('os'), top('device'),
  ];
  const [tot, live, cm, lk, bots, series, pages, countries, cities, refs, browsers, oses, devices] = (await env.DB.batch(q)).map((r) => r.results);
  return json({
    days, views: tot[0].views, visitors: tot[0].visitors, live: live[0].n, comments: cm[0].n, likes: lk[0].n, bots: bots[0].n,
    series, pages, countries, cities, referrers: refs, browsers, os: oses, devices,
  });
}
async function visits(req, env) {
  const url = new URL(req.url), p = url.searchParams;
  const limit = Math.max(1, Math.min(200, Number(p.get('limit')) || 50));
  const where = ['1 = 1'], args = [];
  if (Number(p.get('before')) > 0) { where.push('v.id < ?'); args.push(Number(p.get('before'))); }
  if (isGuest(p.get('guest'))) { where.push('v.guest = ?'); args.push(p.get('guest')); }
  if (p.get('ip')) { where.push('v.ip = ?'); args.push(p.get('ip').slice(0, 64)); }
  if (p.get('bots') !== '1') where.push('v.bot = 0');
  const rows = await env.DB.prepare(`SELECT v.id, v.ts, v.path, v.title, v.referrer, v.guest, v.ip, v.country, v.region, v.city, v.lat, v.lon, v.timezone,
      v.asn, v.org, v.browser, v.os, v.device, v.lang, v.screen, v.bot,
      (SELECT name FROM comments c WHERE c.guest = v.guest ORDER BY c.ts DESC LIMIT 1) name,
      EXISTS (SELECT 1 FROM blocks b WHERE b.ip = v.ip) blocked
    FROM visits v WHERE ${where.join(' AND ')} ORDER BY v.id DESC LIMIT ?`).bind(...args, limit).all();
  return json({ visits: rows.results.map((r) => ({ ...r, blocked: !!r.blocked, bot: !!r.bot })) });
}
async function visitors(req, env) {
  const { since } = range(new URL(req.url));
  const rows = await env.DB.prepare(`WITH agg AS (
      SELECT ${WHO} who, MIN(ts) first, MAX(ts) last, MAX(id) last_id, COUNT(*) views, COUNT(DISTINCT path) pages
      FROM visits WHERE ts > ? AND bot = 0 GROUP BY who ORDER BY last DESC LIMIT 100)
    SELECT agg.first, agg.last, agg.views, agg.pages, v.guest, v.ip, v.country, v.region, v.city, v.org, v.browser, v.os, v.device,
      (SELECT name FROM comments c WHERE c.guest = v.guest ORDER BY c.ts DESC LIMIT 1) name,
      (SELECT COUNT(*) FROM comments c WHERE c.guest = v.guest) comments,
      (SELECT COUNT(*) FROM likes l WHERE l.guest = v.guest) likes,
      EXISTS (SELECT 1 FROM blocks b WHERE b.ip = v.ip) blocked
    FROM agg JOIN visits v ON v.id = agg.last_id ORDER BY agg.last DESC`).bind(since).all();
  return json({ visitors: rows.results.map((r) => ({ ...r, blocked: !!r.blocked })) });
}
async function adminComments(req, env) {
  const p = new URL(req.url).searchParams, limit = Math.max(1, Math.min(200, Number(p.get('limit')) || 50));
  const before = Number(p.get('before')) > 0 ? Number(p.get('before')) : Number.MAX_SAFE_INTEGER;
  const rows = await env.DB.prepare(`SELECT c.id, c.post, c.name, c.body, c.ts, c.owner, c.guest, c.ip, c.country, c.region, c.city,
      EXISTS (SELECT 1 FROM blocks b WHERE b.ip = c.ip) blocked
    FROM comments c WHERE c.id < ? ORDER BY c.id DESC LIMIT ?`).bind(before, limit).all();
  const total = await count(env, 'SELECT COUNT(*) n FROM comments');
  return json({ total, comments: rows.results.map((r) => ({ ...r, owner: !!r.owner, blocked: !!r.blocked })) });
}
const IP_RE = /^[0-9a-f:.]{3,45}$/i;
async function block(req, env) {
  const b = await readBody(req), ip = str(b.ip, 64);
  if (!IP_RE.test(ip)) throw new HttpError(400, 'Not an IP address.');
  const q = [env.DB.prepare('INSERT OR REPLACE INTO blocks (ip, ts, note) VALUES (?, ?, ?)').bind(ip, now(), str(b.note, 200) || null)];
  if (b.purge) q.push(env.DB.prepare('DELETE FROM comments WHERE ip = ? AND owner = 0').bind(ip), env.DB.prepare('DELETE FROM likes WHERE ip = ?').bind(ip));
  const res = await env.DB.batch(q);
  return json({ ok: true, removedComments: b.purge ? res[1].meta.changes : 0 });
}
async function unblock(req, env) {
  const b = await readBody(req);
  await env.DB.prepare('DELETE FROM blocks WHERE ip = ?').bind(str(b.ip, 64)).run();
  return json({ ok: true });
}

const param = (s) => { try { return decodeURIComponent(s); } catch { throw new HttpError(400, 'Bad address.'); } };
async function route(req, env) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/', M = req.method;
  let m;
  if (path === '/health' && M === 'GET') return json({ ok: true, version: env.API_VERSION || 'dev' });
  if (path === '/hit' && M === 'POST') return hit(req, env);
  if (path === '/counts' && M === 'GET') return counts(req, env);
  if ((m = /^\/posts\/([^/]+)$/.exec(path)) && M === 'GET') return listComments(req, env, param(m[1]));
  if ((m = /^\/posts\/([^/]+)\/comments$/.exec(path)) && M === 'POST') return addComment(req, env, param(m[1]));
  if ((m = /^\/posts\/([^/]+)\/comments\/(\d+)\/delete$/.exec(path)) && M === 'POST') return deleteComment(req, env, param(m[1]), Number(m[2]));
  if ((m = /^\/posts\/([^/]+)\/like$/.exec(path)) && M === 'POST') return like(req, env, param(m[1]));
  if (path.startsWith('/admin/')) {
    await needAdmin(req, env);
    if (path === '/admin/me' && M === 'GET') return json({ ok: true, version: env.API_VERSION || 'dev', retentionDays: Number(env.RETENTION_DAYS) || 90 });
    if (path === '/admin/stats' && M === 'GET') return stats(req, env);
    if (path === '/admin/visits' && M === 'GET') return visits(req, env);
    if (path === '/admin/visitors' && M === 'GET') return visitors(req, env);
    if (path === '/admin/comments' && M === 'GET') return adminComments(req, env);
    if ((m = /^\/admin\/comments\/(\d+)\/delete$/.exec(path)) && M === 'POST') {
      await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(Number(m[1])).run();
      return json({ ok: true });
    }
    if (path === '/admin/blocks' && M === 'GET') return json({ blocks: (await env.DB.prepare('SELECT ip, ts, note FROM blocks ORDER BY ts DESC').all()).results });
    if (path === '/admin/blocks' && M === 'POST') return block(req, env);
    if (path === '/admin/blocks/delete' && M === 'POST') return unblock(req, env);
  }
  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('origin'), allowed = allowedOrigin(origin, env);
    const cors = { vary: 'Origin', ...(allowed ? { 'access-control-allow-origin': allowed } : {}) };
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400' } });
    }
    let res;
    try {
      if (origin && !allowed && req.method !== 'GET') throw new HttpError(403, 'This site may not use this API.');
      await ready(env);
      res = await route(req, env);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      res = e instanceof HttpError ? json({ error: e.message }, e.status) : json({ error: 'Something went wrong. Try again.' }, 500);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
  // daily clean-up: old visits, the IP address + location kept with old comments and likes, expired admin sign-ins
  async scheduled(_event, env) {
    await ready(env);
    const cutoff = now() - (Number(env.RETENTION_DAYS) || 90) * DAY;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM visits WHERE ts < ?').bind(cutoff),
      env.DB.prepare('UPDATE comments SET ip = NULL, country = NULL, region = NULL, city = NULL WHERE ts < ? AND (ip IS NOT NULL OR country IS NOT NULL OR region IS NOT NULL OR city IS NOT NULL)').bind(cutoff),
      env.DB.prepare('UPDATE likes SET ip = NULL WHERE ts < ? AND ip IS NOT NULL').bind(cutoff),
      env.DB.prepare('DELETE FROM admin_tokens WHERE until < ?').bind(now()),
    ]);
  },
};
