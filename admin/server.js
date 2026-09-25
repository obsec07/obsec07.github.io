// Full app server: static site + auth + admin. Everything SERVER-SIDE rendered; actions are form POSTs.
//   npm run start   ->  http://localhost:4331   (admin: t0b!)
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import matter from 'gray-matter';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const POSTS_DIR = path.join(ROOT, 'src', 'content', 'posts');
// runtime data (SQLite DB + generated JWT secret). Point DATA_DIR at a persistent disk in production.
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'app.db');
const PORT = process.env.PORT || process.env.APP_PORT || 4331;   // hosts inject PORT
// Reverse proxies in front of the app (Render/Fly/Railway/nginx = 1). req.ip is then the address the LAST trusted proxy saw,
// which the client can't forge — unlike `true`, which takes the client-supplied left-most X-Forwarded-For entry.
// Set TRUST_PROXY=0 when the app is exposed directly with no proxy (a list of proxy IPs/subnets also works).
const TRUST_PROXY = process.env.TRUST_PROXY || '1';
const CATEGORIES = ['0day', 'ctf', 'infosec', 'tools'];
// JWT secret: from env, else a persisted random file (gitignored) so restarts keep sessions — never hardcoded.
const SECRET_FILE = path.join(DATA_DIR, '.secret');
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  try { const s = fs.readFileSync(SECRET_FILE, 'utf8').trim(); if (s) return s; } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 }); } catch {}
  return s;
})();
const CAPTCHA_SECRET = crypto.createHash('sha256').update('captcha:' + JWT_SECRET).digest();
// Admin: username/email/password all from env; if no password is set, a random one is generated and printed once.
const ADMIN = { username: process.env.ADMIN_USERNAME || 't0b!', password: process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url'), email: (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase() };

// ---- DB ----
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, username_lc TEXT UNIQUE, email TEXT, email_lc TEXT UNIQUE, pass_hash TEXT, role TEXT DEFAULT 'user', approved INTEGER DEFAULT 0, suspended INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, actor TEXT, action TEXT, target TEXT, ip TEXT);
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post TEXT, username TEXT, body TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS likes (post TEXT, username TEXT, ts INTEGER, UNIQUE(post, username));
`);
// profile columns (added incrementally so existing DBs upgrade cleanly). `approved` now means "may publish posts".
for (const col of ['avatar TEXT', 'about TEXT', 'location TEXT', 'website TEXT']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch {} }
try { db.exec('ALTER TABLE audit ADD COLUMN ip TEXT'); } catch {}  // audit now records source IP
try { db.exec('ALTER TABLE users ADD COLUMN uid TEXT'); } catch {} // random, unguessable public id (anti-IDOR-enumeration)
for (const col of ['stat_messages INTEGER', 'stat_reactions INTEGER', 'stat_points INTEGER']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch {} } // admin-editable stat overrides (NULL = auto)
const newUid = () => crypto.randomBytes(12).toString('base64url');
if (process.argv.includes('--reset')) { db.exec('DELETE FROM users; DELETE FROM audit; DELETE FROM comments; DELETE FROM likes;'); console.log('data reset.'); }
if (!db.prepare('SELECT id FROM users WHERE username_lc=?').get(ADMIN.username.toLowerCase())) {
  db.prepare('INSERT INTO users (uid,username,username_lc,email,email_lc,pass_hash,role,approved,suspended,created) VALUES (?,?,?,?,?,?,?,1,0,?)')
    .run(newUid(), ADMIN.username, ADMIN.username.toLowerCase(), ADMIN.email, ADMIN.email, bcrypt.hashSync(ADMIN.password, 10), 'admin', Date.now());
  console.log(`\n  admin ready -> ${ADMIN.username}  (email: ${ADMIN.email})${process.env.ADMIN_PASSWORD ? '' : `\n  GENERATED PASSWORD (save it now): ${ADMIN.password}`}\n  [configure via env: ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_EMAIL / JWT_SECRET]\n`);
}
for (const r of db.prepare("SELECT id FROM users WHERE uid IS NULL OR uid=''").all()) db.prepare('UPDATE users SET uid=? WHERE id=?').run(newUid(), r.id);  // backfill any legacy rows
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1') || '—';
const log = (actor, action, target, ip) => db.prepare('INSERT INTO audit (ts,actor,action,target,ip) VALUES (?,?,?,?,?)').run(Date.now(), actor, action, String(target || ''), cleanIp(ip));

// ---- JWT / captcha / rate limit ----
const ABS_MS = 15 * 60e3;      // absolute session lifetime: 15 minutes
const IDLE_MS = 5 * 60e3;      // inactivity timeout: 5 minutes
const b64u = (b) => Buffer.from(b).toString('base64url');
function jwtSign(p) { const now = Date.now(); const login = p.login || now; const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const pl = b64u(JSON.stringify({ ...p, login, iat: now, exp: Math.min(login + ABS_MS, now + IDLE_MS) })); return `${h}.${pl}.` + crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + pl).digest('base64url'); }
// token holds only the account's uid + login time; name/role are re-read from the DB on every request (see session middleware)
const setSession = (req, res, p) => res.cookie('token', jwtSign({ uid: p.uid, login: p.login }), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: IDLE_MS });
function jwtVerify(t) { try { const [h, p, s] = String(t).split('.'); const e = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest('base64url'); if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null; const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.exp < Date.now() ? null : d; } catch { return null; } }
function makeCaptcha() { const a = 1 + (Math.random() * 9 | 0), b = 1 + (Math.random() * 9 | 0), exp = Date.now() + 6e5; return { q: `What is ${a} + ${b}?`, token: `${a + b}.${exp}.` + crypto.createHmac('sha256', CAPTCHA_SECRET).update(`${a + b}.${exp}`).digest('base64url') }; }
function checkCaptcha(ans, tok) { const [s, e, sig] = String(tok || '').split('.'); if (!s || !e || Date.now() > +e) return false; return sig === crypto.createHmac('sha256', CAPTCHA_SECRET).update(`${s}.${e}`).digest('base64url') && String(ans).trim() === s; }
const hits = new Map();
function rateLimit(req, res, next) { const ip = req.ip || 'x', now = Date.now(); const a = (hits.get(ip) || []).filter((t) => now - t < 1000); a.push(now); hits.set(ip, a); if (a.length > 5) return res.status(429).type('html').send(pageMsg('Slow down', 'Too many requests — wait a second.')); next(); }

// ---- helpers ----
const lc = (s) => String(s || '').trim().toLowerCase();
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (s) => lc(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'post';
const fmtDate = (d) => { try { return new Date(d).toISOString().slice(0, 10); } catch { return d; } };
const fmtTs = (t) => new Date(t).toLocaleString('en-GB', { hour12: false });
const me = (req) => req.auth || null;   // set by the session middleware from the DB, never from the request body
const back = (req, res, hash = '') => res.redirect((req.get('referer') || '/') + hash);
// password field with a Show/Hide toggle (inline handler so it works in both admin pages and the public shell)
const PW = (name, attrs = '') => `<span class="pw-wrap"><input type="password" name="${name}" ${attrs}><button type="button" class="pw-eye" tabindex="-1" aria-label="show password" onclick="var i=this.parentNode.querySelector('input');var s=i.type==='password';i.type=s?'text':'password';this.textContent=s?'Hide':'Show';">Show</button></span>`;
function listPosts() { if (!fs.existsSync(POSTS_DIR)) return []; return fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md')).map((f) => { const g = matter(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8')); return { slug: f.replace(/\.md$/, ''), ...g.data }; }).sort((a, b) => new Date(b.date) - new Date(a.date)); }
function readPost(s) { const p = path.join(POSTS_DIR, path.basename(s) + '.md'); if (!fs.existsSync(p)) return null; const g = matter(fs.readFileSync(p, 'utf8')); return { slug: s, data: g.data, body: g.content }; }
// a NEW post (no slug given) never replaces an existing file: "my-post" -> "my-post-2", "my-post-3", …
function freeSlug(s) { let slug = s, i = 2; while (fs.existsSync(path.join(POSTS_DIR, slug + '.md'))) slug = `${s}-${i++}`; return slug; }
function writePost(o) { const data = { title: o.title || 'Untitled', date: o.date || new Date().toISOString().slice(0, 10), category: CATEGORIES.includes(o.category) ? o.category : 'infosec', description: o.description || '', tags: (Array.isArray(o.tags) ? o.tags : String(o.tags || '').split(',')).map((t) => t.trim()).filter(Boolean), draft: !!o.draft }; const s = o.slug || freeSlug(slugify(o.title)); fs.mkdirSync(POSTS_DIR, { recursive: true }); fs.writeFileSync(path.join(POSTS_DIR, path.basename(s) + '.md'), matter.stringify(o.body || '', data)); return s; }
const livePost = (slug) => { const p = readPost(slug); return p && !p.data.draft ? p : null; };   // published posts only
// the public site is statically built — after any content change, rebuild dist/ so the new/edited post page exists (debounced, non-blocking)
let building = false, rebuildQueued = false;
function rebuild() {
  if (building) { rebuildQueued = true; return; }
  building = true;
  const p = spawn('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
  p.on('exit', () => { building = false; if (rebuildQueued) { rebuildQueued = false; rebuild(); } });
  p.on('error', () => { building = false; });
}

// ---- avatar upload: memory storage, hard 2MB cap; ALL validation is server-side ----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
// Verify the real file header (magic bytes) AND require the declared content-type to match. jpeg/png only.
function imageType(buf, mime) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (png && mime === 'image/png') return 'image/png';
  if (jpg && (mime === 'image/jpeg' || mime === 'image/jpg')) return 'image/jpeg';
  return null; // header/content-type mismatch or unsupported type -> reject
}
const fullUser = (name) => db.prepare('SELECT * FROM users WHERE username_lc=?').get(lc(name));

// ---- strict server-side input validation (never trust the client) ----
const CTRL = /[\x00-\x1f\x7f]/;                 // control chars / null bytes
const OWNER = 'tobi';                                 // brand handle -> maps to the admin account for avatars
const RESERVED = new Set(['admin', 'administrator', 'root', 'superuser', 'moderator', 'mod', 'system', 'support', 'staff', 'owner', OWNER, ADMIN.username.toLowerCase()]);
function validUsername(u, { allowReserved = false } = {}) {   // admins may hand out reserved names; the charset rule always applies
  u = String(u == null ? '' : u).trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(u)) return 'Username must be 3–32 characters: letters, numbers, and . _ - only.';
  if (!allowReserved && RESERVED.has(u.toLowerCase())) return 'That username is reserved.';
  return null;
}
function validEmail(e) {
  e = String(e == null ? '' : e).trim();
  if (e.length < 5 || e.length > 254 || CTRL.test(e)) return 'Enter a valid email address.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return 'Enter a valid email address.';
  return null;
}
function validPassword(p) {
  p = String(p == null ? '' : p);
  if (p.length < 8) return 'Password must be at least 8 characters.';
  if (p.length > 200) return 'Password is too long (max 200).';   // bound bcrypt input
  if (CTRL.test(p)) return 'Password contains invalid characters.';
  return null;
}
const ownerName = (name) => { const n = lc(name); return (n === OWNER || n === ADMIN.username.toLowerCase()) ? ADMIN.username : name; };

// ---- rate limiting + abuse blocking (keyed by client IP) ----
// Deliberately NOT keyed by User-Agent: it's client-chosen and shared by everyone on the same browser build, so one
// abuser sending a common Chrome UA would lock every Chrome user out of login/comments.
const buckets = new Map();   // "name|ip" -> [timestamps]
const blocked = new Map();   // ip -> unblock-at ts
const overLimit = (k, max, win) => { const now = Date.now(); const a = (buckets.get(k) || []).filter((t) => now - t < win); a.push(now); buckets.set(k, a); return a.length > max; };
function guard(name, max, win, blockMs) {
  return (req, res, next) => {
    const ip = req.ip || 'x', now = Date.now();
    if (blocked.get(ip) > now) return res.status(429).type('html').send(pageMsg('Temporarily blocked', 'Too many requests. Your address is blocked for a few minutes.'));
    if (overLimit(name + '|' + ip, max, win)) {
      blocked.set(ip, now + blockMs);
      log((me(req) || {}).sub || 'anon', 'ratelimit-block:' + name, 'ua=' + (req.get('user-agent') || '-').slice(0, 60), ip);
      return res.status(429).type('html').send(pageMsg('Temporarily blocked', 'Too many requests. Your address is blocked for a few minutes.'));
    }
    next();
  };
}
// forget expired entries so the maps don't grow forever (every rate window is <= 60s)
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of blocked) if (t <= now) blocked.delete(k);
  for (const m of [buckets, hits]) for (const [k, a] of m) if (!a.length || now - a[a.length - 1] > 60e3) m.delete(k);
}, 60e3).unref();
const guardAuth = guard('auth', 12, 60e3, 10 * 60e3);   // 12 auth attempts/min -> 10-min block
const guardLike = guard('like', 20, 60e3, 5 * 60e3);    // 20 likes/min       -> 5-min block
const guardComment = guard('comment', 10, 60e3, 5 * 60e3);

// ---- app ----
const app = express();
app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? +TRUST_PROXY : TRUST_PROXY);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '1mb' }));   // room for long writeups from the post editor (default is 100kb)
app.use(cookieParser());
app.use((req, res, next) => {
  // no framing (clickjacking on the admin panel), no MIME sniffing, no <base>/<object> injection, forms only post back here
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  // dynamic, per-session pages must not be served stale from the bfcache (back/forward). Static assets (with a file extension) keep normal caching.
  if (!/\.[a-z0-9]+$/i.test(req.path)) res.set('Cache-Control', 'no-store, must-revalidate');
  next();
});
// sliding session: re-load the account on every request so suspension, deletion and role changes take effect immediately
// (not when the token happens to expire), then slide the 5-min idle window, hard-capped at 15 min absolute
app.use((req, res, next) => {
  const t = req.cookies.token; if (!t) return next();
  const p = jwtVerify(t);
  const u = p && p.uid && Date.now() < (p.login || 0) + ABS_MS ? userByUid(p.uid) : null;
  if (!u || u.suspended) { res.clearCookie('token'); return next(); }
  req.auth = { uid: u.uid, sub: u.username, role: u.role, email: u.email_lc, login: p.login };
  setSession(req, res, req.auth);
  next();
});
const needUser = (req, res, next) => { const u = me(req); if (!u) return res.redirect('/login'); req.u = u; next(); };
// admin panel is HIDDEN: non-admins get a 404 (no hint it exists), never a redirect
const needAdmin = (req, res, next) => { const u = me(req); if (!u || u.role !== 'admin') return notFound(res); req.u = u; next(); };

// ---- auth ----
app.get('/login', (req, res) => res.type('html').send(pageAuth('login', makeCaptcha())));
app.get('/register', (req, res) => res.type('html').send(pageAuth('register', makeCaptcha())));
app.post('/api/login', guardAuth, rateLimit, (req, res) => {
  const { login, email, password, captcha, captcha_token } = req.body;
  if (!checkCaptcha(captcha, captcha_token)) return fail(res, 'Captcha incorrect.');
  // accept EITHER an email OR a username; server-side bounds/charset checks (never rely on the client)
  const id = String(login != null ? login : (email != null ? email : '')).trim(), pw = String(password == null ? '' : password);
  if (id.length < 3 || id.length > 254 || pw.length > 200 || CTRL.test(id)) return fail(res, 'Invalid credentials.');
  const u = db.prepare('SELECT * FROM users WHERE email_lc=? OR username_lc=?').get(lc(id), lc(id));
  if (!u || !bcrypt.compareSync(pw, u.pass_hash)) return fail(res, 'Invalid credentials.');
  if (u.suspended) return fail(res, 'Your account has been suspended.');
  // NOTE: approval no longer gates login — any active account can sign in and use its profile.
  //       `approved` only controls whether the user may publish posts (checked at the post routes).
  setSession(req, res, { uid: u.uid, login: Date.now() });
  log(u.username, 'login', '', req.ip); res.redirect('/');   // never auto-redirect to the panel
});
app.post('/api/register', guardAuth, rateLimit, (req, res) => {
  const { username, email, password, captcha, captcha_token } = req.body;
  if (!checkCaptcha(captcha, captcha_token)) return fail(res, 'Captcha incorrect.', 'register');
  // strict server-side validation: charset, length bounds, reserved names, control chars
  let e;
  if ((e = validUsername(username))) return fail(res, e, 'register');
  if ((e = validEmail(email))) return fail(res, e, 'register');
  if ((e = validPassword(password))) return fail(res, e, 'register');
  if (db.prepare('SELECT id FROM users WHERE username_lc=?').get(lc(username))) return fail(res, 'That username is already taken.', 'register');
  if (db.prepare('SELECT id FROM users WHERE email_lc=?').get(lc(email))) return fail(res, 'That email is already registered.', 'register');
  const uid = newUid();
  db.prepare('INSERT INTO users (uid,username,username_lc,email,email_lc,pass_hash,role,approved,suspended,created) VALUES (?,?,?,?,?,?,?,0,0,?)')
    .run(uid, String(username).trim(), lc(username), String(email).trim(), lc(email), bcrypt.hashSync(password, 10), 'user', Date.now());
  log(String(username).trim(), 'register', lc(email), req.ip);
  // account is usable immediately: sign them in and drop them on their profile. Posting stays gated on approval.
  setSession(req, res, { uid, login: Date.now() });
  res.redirect('/account?welcome=1');
});
app.post('/logout', (req, res) => { const u = me(req); if (u) log(u.sub, 'logout', '', req.ip); res.clearCookie('token').redirect('/'); });

// ---- avatar serving: one URL per user; returns the stored base64 photo or the default silhouette ----
app.get('/avatar/:name', (req, res) => {
  const u = fullUser(ownerName(req.params.name));
  res.set('Cache-Control', 'no-cache');   // so a new upload shows everywhere immediately
  if (u && typeof u.avatar === 'string' && u.avatar.startsWith('data:image/')) {
    const comma = u.avatar.indexOf(','), mime = u.avatar.slice(5, u.avatar.indexOf(';'));
    return res.type(mime).send(Buffer.from(u.avatar.slice(comma + 1), 'base64'));
  }
  res.sendFile(path.join(DIST, u && isAdminName(u.username) ? 'owner.jpg' : 'avatar.svg'));   // the admin's default picture is the owner photo
});
// newest registered members (excludes the primary admin) — injected into the footer on every page
function newestMembers() {
  const rows = db.prepare('SELECT username FROM users WHERE suspended=0 ORDER BY id DESC').all().filter((r) => !isAdminName(r.username)).slice(0, 6);
  if (!rows.length) return '<span class="foot-nomembers">No members yet.</span>';
  return rows.map((r) => `<a class="foot-member" href="/members/${encodeURIComponent(lc(r.username))}" title="${esc(r.username)}"><img src="/avatar/${encodeURIComponent(lc(r.username))}" data-uprofile="${esc(lc(r.username))}" alt="${esc(r.username)}" width="40" height="40"></a>`).join('');
}
// home "Forum statistics" widget: active accounts, and the newest one's public name (the owner shows as its brand handle)
function memberStats() {
  const rows = db.prepare('SELECT username FROM users WHERE suspended=0 ORDER BY id DESC').all();
  return { count: rows.length, latest: rows.length ? dispName(rows[0]) : OWNER };
}
// thread-list stats (category pages): replies = comments, reactions = likes — real data, injected per slug
const countComments = (slug) => db.prepare('SELECT COUNT(*) c FROM comments WHERE post=?').get(slug).c;
const countLikes = (slug) => db.prepare('SELECT COUNT(*) c FROM likes WHERE post=?').get(slug).c;
function threadStats(slug) {
  return `<div><dt>Replies:</dt><dd>${countComments(slug)}</dd></div><div><dt>Reactions:</dt><dd>${countLikes(slug)}</dd></div>`;
}
// "post here" footer on category pages, driven by permission
function postHere(u) {
  if (!u) return '<a class="tl-post-btn" href="/login">You must log in or register to post here.</a>';
  return canPost(fullUser(u.sub)) ? '<a class="tl-post-btn can-post" href="/account?tab=write">Post thread</a>' : '<span class="tl-post-btn tl-post-note">Your account needs administrator permission before you can post.</span>';
}
// author info card on a thread — points derived from likes + comments on that thread
function authorCard(slug) {
  const messages = listPosts().filter((p) => !p.draft).length;
  const reactions = countLikes(slug);
  const points = reactions + countComments(slug);
  const av = `/avatar/${encodeURIComponent(OWNER)}`;
  return `<div class="ac-inner">
    <img class="ac-av" src="${av}" alt="${esc(OWNER)}">
    <div class="ac-name">${esc(OWNER)} <span class="ac-role">Administrator</span></div>
    <div class="ac-badges"><span class="ac-badge staff">Staff member</span><span class="ac-badge">Member</span></div>
    <div class="ac-stats"><div><span>Messages</span><b>${messages}</b></div><div><span>Reaction score</span><b>${reactions}</b></div><div><span>Points</span><b>${points}</b></div></div>
  </div>`;
}
// ---- per-user profile: stats, hover card, and full member page ----
const dispName = (u) => (isAdminName(u.username) ? OWNER : u.username);   // owner's public handle
const joinedOf = (u) => { try { return new Date(u.created).toISOString().slice(0, 10); } catch { return ''; } };
function userStats(u) {
  const owner = isAdminName(u.username);
  const posts = owner ? listPosts().filter((p) => !p.draft).length : 0;
  const comments = db.prepare('SELECT COUNT(*) c FROM comments WHERE username=?').get(u.username).c;
  // admin-set overrides win; otherwise auto-computed
  const messages = u.stat_messages != null ? u.stat_messages : posts + comments;
  const reactions = u.stat_reactions != null ? u.stat_reactions : (owner ? db.prepare('SELECT COUNT(*) c FROM likes').get().c : 0);
  const points = u.stat_points != null ? u.stat_points : reactions + messages;
  return { messages, reactions, points };
}
// one hidden hover card per referenced user (owner + newest members); JS shows the one matching the hovered avatar
function uprofileCards() {
  const members = db.prepare('SELECT * FROM users WHERE suspended=0 AND username_lc != ? ORDER BY id DESC').all(ADMIN.username.toLowerCase()).slice(0, 6);
  const users = [fullUser(ADMIN.username), ...members].filter(Boolean);
  return users.map((u) => {
    const s = userStats(u), staff = isStaff(u), name = dispName(u), key = lc(name);
    const link = '/members/' + encodeURIComponent(key), roleLabel = u.role.charAt(0).toUpperCase() + u.role.slice(1);
    return `<div class="uprofile" data-user="${esc(key)}">
      <div class="up-top"><a href="${link}"><img class="up-av" src="/avatar/${encodeURIComponent(key)}" alt="${esc(name)}"></a>
      <div class="up-meta"><a class="up-name" href="${link}">${esc(name)}</a>
        <div class="up-badges">${staff ? '<span class="up-badge staff">Staff member</span>' : ''}<span class="up-badge">Member</span></div>
        <div class="up-role">${staff ? roleLabel : 'Member'}</div>
        <div class="up-since">Joined: <b>${joinedOf(u)}</b></div></div>
      </div>
      <div class="up-stats"><div><span>Messages</span><b>${s.messages}</b></div><div><span>Reaction score</span><b>${s.reactions}</b></div><div><span>Points</span><b>${s.points}</b></div></div>
    </div>`;
  }).join('');
}
// full member profile page (rendered into the /members/:name shell)
function memberProfile(u) {
  const s = userStats(u), staff = isStaff(u), name = dispName(u), key = lc(name);
  const roleLabel = u.role.charAt(0).toUpperCase() + u.role.slice(1);
  return `<nav class="crumbs-box"><a href="/">⌂ Home</a></nav>
  <div class="member-card">
    <img class="mc-av" src="/avatar/${encodeURIComponent(key)}" alt="${esc(name)}">
    <div class="mc-body">
      <div class="mc-name">${esc(name)}</div>
      <div class="mc-badges">${staff ? '<span class="mc-badge staff">Staff member</span>' : ''}<span class="mc-badge">Member</span></div>
      <div class="mc-role">${staff ? roleLabel : 'Member'}</div>
      <div class="mc-since">Joined: <b>${joinedOf(u)}</b></div>
      <div class="mc-stats"><div><span>Messages</span><b>${s.messages}</b></div><div><span>Reaction score</span><b>${s.reactions}</b></div><div><span>Points</span><b>${s.points}</b></div></div>
    </div>
  </div>
  <div class="member-tabs"><span class="on">About</span></div>
  <div class="member-about"><b>${esc(name)}</b> ${staff ? 'is an administrator of this site.' : 'is a member of this community.'}</div>`;
}

// ---- account / profile (server-rendered, form POST) ----
app.post('/account/details', needUser, (req, res) => {
  db.prepare('UPDATE users SET about=?, location=?, website=? WHERE username_lc=?')
    .run(String(req.body.about || '').slice(0, 2000), String(req.body.location || '').slice(0, 120), String(req.body.website || '').slice(0, 200), lc(req.u.sub));
  log(req.u.sub, 'profile-update', '', req.ip); res.redirect('/account?tab=details&ok=1');
});
app.post('/account/avatar', needUser, (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return res.redirect('/account?tab=details&err=size');           // >2MB or malformed multipart
    const f = req.file;
    if (!f) return res.redirect('/account?tab=details&err=none');
    const type = imageType(f.buffer, f.mimetype);                            // content-type + magic-byte header check
    if (!type) return res.redirect('/account?tab=details&err=type');         // anything not a real jpeg/png is rejected
    const dataUri = `data:${type};base64,` + f.buffer.toString('base64');    // stored as base64 data URI
    db.prepare('UPDATE users SET avatar=? WHERE username_lc=?').run(dataUri, lc(req.u.sub));
    log(req.u.sub, 'avatar-upload', type, req.ip); res.redirect('/account?tab=details&ok=photo');
  });
});
app.post('/account/remove-avatar', needUser, (req, res) => { db.prepare('UPDATE users SET avatar=NULL WHERE username_lc=?').run(lc(req.u.sub)); log(req.u.sub, 'avatar-remove', '', req.ip); res.redirect('/account?tab=details&ok=1'); });
app.post('/account/password', needUser, (req, res) => {
  const u = fullUser(req.u.sub);
  if (!u || !bcrypt.compareSync(String(req.body.current || ''), u.pass_hash)) return res.redirect('/account?tab=security&err=current');
  if (validPassword(req.body.pw)) return res.redirect('/account?tab=security&err=pw');   // same rules as registration (login rejects >200 chars)
  if (req.body.pw !== req.body.pw2) return res.redirect('/account?tab=security&err=match');
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(req.body.pw, 10), u.id);
  log(req.u.sub, 'password-change', '', req.ip); res.redirect('/account?tab=security&ok=1');
});
// posting is permission-gated: only an approved (or admin) account may publish
const isStaff = (u) => !!(u && (u.role === 'admin' || u.role === 'moderator'));   // staff publish immediately
const canPost = (u) => !!(u && (isStaff(u) || u.approved));                        // approved users may submit (as drafts)
app.post('/account/write', needUser, (req, res) => {
  const u = fullUser(req.u.sub); if (!canPost(u)) return notFound(res);
  const { title, category, body } = req.body;
  if (!String(title || '').trim()) return res.redirect('/account?tab=write&err=title');
  const staff = isStaff(u);   // admins/moderators publish live; everyone else submits a draft for admin review
  const slug = writePost({ title, category, body, description: String(body || '').replace(/\s+/g, ' ').slice(0, 160), draft: !staff });
  log(req.u.sub, staff ? 'publish-post' : 'submit-post', slug, req.ip); rebuild();
  res.redirect('/account?tab=write&ok=' + (staff ? 'published' : 'submitted'));
});

// ---- comments + likes: form POST, server-rendered (no client fetch) ----
app.post('/posts/:slug/like', guardLike, needUser, (req, res) => {
  const post = path.basename(req.params.slug); if (!livePost(post)) return notFound(res);
  if (db.prepare('SELECT 1 FROM likes WHERE post=? AND username=?').get(post, req.u.sub)) db.prepare('DELETE FROM likes WHERE post=? AND username=?').run(post, req.u.sub);
  else db.prepare('INSERT OR IGNORE INTO likes (post,username,ts) VALUES (?,?,?)').run(post, req.u.sub, Date.now());
  res.redirect('/posts/' + post + '#comments');
});
app.post('/posts/:slug/comment', guardComment, needUser, (req, res) => {
  const post = path.basename(req.params.slug), body = String(req.body.body || '').trim();
  if (!livePost(post)) return notFound(res);   // no comments on drafts or on slugs that don't exist
  if (body) { db.prepare('INSERT INTO comments (post,username,body,ts) VALUES (?,?,?,?)').run(post, req.u.sub, body.slice(0, 4000), Date.now()); log(req.u.sub, 'comment', post, req.ip); }
  res.redirect('/posts/' + post + '#comments');
});
app.post('/posts/:slug/comment/:id/delete', needUser, (req, res) => {
  const post = path.basename(req.params.slug), c = db.prepare('SELECT * FROM comments WHERE id=?').get(req.params.id);
  if (c && (req.u.role === 'admin' || req.u.sub === c.username)) { db.prepare('DELETE FROM comments WHERE id=?').run(req.params.id); log(req.u.sub, 'delete-comment', post, req.ip); }
  res.redirect('/posts/' + post + '#comments');
});

// ---- admin actions (form POST -> redirect /admin-panel) ----
const isAdminName = (n) => lc(n) === ADMIN.username.toLowerCase();
const userByUid = (uid) => db.prepare('SELECT * FROM users WHERE uid=?').get(String(uid || ''));
app.post('/admin-panel/approve/:uid', needAdmin, (req, res) => { const u = userByUid(req.params.uid); if (u) { db.prepare('UPDATE users SET approved=1 WHERE id=?').run(u.id); log(req.u.sub, 'approve', u.username, req.ip); } res.redirect('/admin-panel'); });
app.post('/admin-panel/suspend/:uid', needAdmin, (req, res) => { const u = userByUid(req.params.uid); if (u && !isAdminName(u.username)) { db.prepare('UPDATE users SET suspended=1 WHERE id=?').run(u.id); log(req.u.sub, 'suspend', u.username, req.ip); } res.redirect('/admin-panel'); });
app.post('/admin-panel/unsuspend/:uid', needAdmin, (req, res) => { const u = userByUid(req.params.uid); if (u) { db.prepare('UPDATE users SET suspended=0 WHERE id=?').run(u.id); log(req.u.sub, 'unsuspend', u.username, req.ip); } res.redirect('/admin-panel'); });
app.post('/admin-panel/role/:uid', needAdmin, (req, res) => { const u = userByUid(req.params.uid); if (u && !isAdminName(u.username) && lc(u.username) !== lc(req.u.sub)) { const role = ['user', 'moderator', 'admin'].includes(req.body.role) ? req.body.role : 'user'; db.prepare('UPDATE users SET role=?, approved=1 WHERE id=?').run(role, u.id); log(req.u.sub, 'role:' + role, u.username, req.ip); } res.redirect('/admin-panel'); });
app.post('/admin-panel/delete-user/:uid', needAdmin, (req, res) => { const u = userByUid(req.params.uid); if (u && !isAdminName(u.username)) { db.prepare('DELETE FROM users WHERE id=?').run(u.id); log(req.u.sub, 'delete-user', u.username, req.ip); } res.redirect('/admin-panel'); });
app.post('/admin-panel/add-user', needAdmin, (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !email || !password) return res.redirect('/admin-panel?msg=add_fields');
  if (validUsername(username, { allowReserved: true })) return res.redirect('/admin-panel?msg=add_user');
  if (validEmail(email)) return res.redirect('/admin-panel?msg=add_email');
  if (validPassword(password)) return res.redirect('/admin-panel?msg=add_pw');
  if (db.prepare('SELECT id FROM users WHERE username_lc=?').get(lc(username))) return res.redirect('/admin-panel?msg=add_dupuser');
  if (db.prepare('SELECT id FROM users WHERE email_lc=?').get(lc(email))) return res.redirect('/admin-panel?msg=add_dupemail');
  db.prepare('INSERT INTO users (uid,username,username_lc,email,email_lc,pass_hash,role,approved,suspended,created) VALUES (?,?,?,?,?,?,?,1,0,?)')
    .run(newUid(), String(username).trim(), lc(username), String(email).trim(), lc(email), bcrypt.hashSync(password, 10), ['user', 'moderator', 'admin'].includes(role) ? role : 'user', Date.now());
  log(req.u.sub, 'add-user', username, req.ip);
  res.redirect('/admin-panel?msg=add_ok');
});
app.post('/admin-panel/delete-comment/:id', needAdmin, (req, res) => { const c = db.prepare('SELECT * FROM comments WHERE id=?').get(req.params.id); db.prepare('DELETE FROM comments WHERE id=?').run(req.params.id); if (c) log(req.u.sub, 'delete-comment', c.post, req.ip); res.redirect('/admin-panel'); });
app.post('/admin-panel/delete-post/:slug', needAdmin, (req, res) => { const p = path.join(POSTS_DIR, path.basename(req.params.slug) + '.md'); if (fs.existsSync(p)) fs.unlinkSync(p); log(req.u.sub, 'delete-post', req.params.slug, req.ip); rebuild(); res.redirect('/admin-panel'); });
// approve a user-submitted draft -> publish it live
app.post('/admin-panel/publish/:slug', needAdmin, (req, res) => { const p = readPost(req.params.slug); if (p) { writePost({ slug: p.slug, title: p.data.title, date: fmtDate(p.data.date), category: p.data.category, description: p.data.description, tags: p.data.tags, body: p.body, draft: false }); log(req.u.sub, 'publish-post', p.slug, req.ip); rebuild(); } res.redirect('/admin-panel?msg=post_saved'); });

app.get('/admin-panel', needAdmin, (req, res) => {
  const pending = db.prepare("SELECT uid,username,email FROM users WHERE approved=0 AND suspended=0 ORDER BY created DESC").all();
  const users = db.prepare("SELECT uid,username,email,role,approved,suspended FROM users ORDER BY id").all();
  const comments = db.prepare("SELECT id,post,username,body,ts FROM comments ORDER BY ts DESC LIMIT 50").all();
  const audit = db.prepare("SELECT ts,actor,action,target,ip FROM audit ORDER BY id DESC LIMIT 60").all();
  res.type('html').send(pageAdmin(req.u, pending, users, listPosts(), comments, audit, req.query.msg));
});
app.get('/admin-panel/new', needAdmin, (req, res) => res.type('html').send(pageEditor(null)));
app.get('/admin-panel/edit/:slug', needAdmin, (req, res) => { const p = readPost(req.params.slug); if (!p) return res.redirect('/admin-panel'); res.type('html').send(pageEditor(p)); });
app.post('/admin-panel/save-post', needAdmin, (req, res) => { const slug = writePost({ ...req.body, draft: req.body.draft === 'true' }); log(req.u.sub, 'save-post', slug, req.ip); rebuild(); res.redirect('/admin-panel?msg=post_saved'); });

// ---- edit user / profile (admin) ----
app.get('/admin-panel/edit-user/:uid', needAdmin, (req, res) => { const u = userByUid(req.params.uid); if (!u) return res.redirect('/admin-panel'); res.type('html').send(pageEditUser(u, '', req.u.sub)); });
app.post('/admin-panel/save-user/:uid', needAdmin, (req, res) => {
  const u = userByUid(req.params.uid); if (!u) return res.redirect('/admin-panel');
  const self = lc(u.username) === lc(req.u.sub);   // "am I editing my own account?" — decided from the session, not the body
  const primary = isAdminName(u.username);          // the seed admin identity
  const { username, email, password, role } = req.body;
  const bad = (username && !primary && validUsername(username, { allowReserved: true })) || (email && validEmail(email)) || (password && validPassword(password));
  if (bad) return res.type('html').send(pageEditUser(u, bad, req.u.sub));
  // username: editable for other users only; the primary admin username is fixed (it's the seed identity)
  if (username && !primary && lc(username) !== u.username_lc && db.prepare('SELECT id FROM users WHERE username_lc=?').get(lc(username))) return res.type('html').send(pageEditUser(u, 'That username is already taken.', req.u.sub));
  if (email && lc(email) !== u.email_lc && db.prepare('SELECT id FROM users WHERE email_lc=?').get(lc(email))) return res.type('html').send(pageEditUser(u, 'That email is already registered.', req.u.sub));
  if (username && !primary) db.prepare('UPDATE users SET username=?, username_lc=? WHERE id=?').run(String(username).trim(), lc(username), u.id);
  if (email) db.prepare('UPDATE users SET email=?, email_lc=? WHERE id=?').run(String(email).trim(), lc(email), u.id);
  if (password) db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), u.id);
  // ROLE is authority — never take it from the client for your own record or the primary admin. Your privilege stays whatever the DB already says.
  if (role && ['user', 'moderator', 'admin'].includes(role) && !primary && !self) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, u.id);
  // admin-editable stat overrides (blank -> revert to auto)
  const numOrNull = (v) => (v === undefined || String(v).trim() === '' ? null : (Number.isFinite(+v) ? Math.max(0, Math.trunc(+v)) : null));
  db.prepare('UPDATE users SET stat_messages=?, stat_reactions=?, stat_points=? WHERE id=?').run(numOrNull(req.body.stat_messages), numOrNull(req.body.stat_reactions), numOrNull(req.body.stat_points), u.id);
  log(req.u.sub, 'edit-user', u.username, req.ip); res.redirect('/admin-panel?msg=save_ok');
});

// ---- member profile page (dynamic, rendered into the /members shell) ----
app.get('/members/:name', (req, res) => {
  const target = fullUser(ownerName(req.params.name)); if (!target) return notFound(res);
  const shell = path.join(DIST, 'members', 'index.html'); if (!fs.existsSync(shell)) return notFound(res);
  const u = me(req);
  const html = fill(fs.readFileSync(shell, 'utf8'), { ICONS_SLOT: headerIcons(u), MEMBERS_SLOT: newestMembers(), UPROFILE: uprofileCards(), MEMBER_SLOT: memberProfile(target) });
  res.type('html').send(html);
});

// ---- serve static HTML with server-side injection (admin link on every page; comments on posts) ----
// Slot values go in via a replacer FUNCTION: with a plain string, `$&` / "$`" / "$'" inside a comment would be expanded
// by String.replace and splice copies of the page's own HTML into the output.
const fill = (html, slots) => Object.entries(slots).reduce((h, [k, v]) => h.replace(`<!--${k}-->`, () => v), html);
function htmlFile(p) {
  try { p = decodeURIComponent(p.split('?')[0]); } catch { return null; }   // malformed %-escapes
  let f = path.join(DIST, p);
  if (f !== DIST && !f.startsWith(DIST + path.sep)) return null;             // "..%2f" must never climb out of dist/
  try { if (fs.statSync(f).isFile() && f.endsWith('.html')) return f; } catch {}
  f = path.join(f, 'index.html'); return fs.existsSync(f) ? f : null;
}
app.get('*', (req, res, next) => {
  const f = htmlFile(req.path); if (!f) return next();
  const u = me(req);
  let html = fill(fs.readFileSync(f, 'utf8'), { ICONS_SLOT: headerIcons(u), MEMBERS_SLOT: newestMembers(), UPROFILE: uprofileCards() });
  if (html.includes('<!--STAT_MEMBERS-->')) { const m = memberStats(); html = fill(html, { STAT_MEMBERS: String(m.count), STAT_LATEST: esc(m.latest) }); }
  if (html.includes('<!--THSTATS:')) html = fill(html.replace(/<!--THSTATS:([^]*?)-->/g, (m, slug) => threadStats(slug)), { POSTHERE: postHere(u) });
  if (req.path === '/account' || req.path === '/account/') html = fill(html, { ACCOUNT_SLOT: u ? accountPanel(fullUser(u.sub), req.query.tab, req.query) : accountAnon() });
  if (req.path.startsWith('/posts/')) { const slug = path.basename(req.path.replace(/\/+$/, '')); html = fill(html, { COMMENTS_SLOT: renderComments(slug, u), AUTHORCARD: authorCard(slug) }); }
  res.type('html').send(html);
});
app.use(express.static(DIST));
app.use((req, res) => notFound(res));
// never show stack traces: malformed requests (bad %-escapes, oversized bodies) get their 4xx, anything else is logged + generic 500
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || (err instanceof URIError ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).type('html').send(pageError(status, status >= 500 ? 'Something went wrong on our side.' : 'That request could not be processed.'));
});
app.listen(PORT, () => console.log(`\n  blog + auth + admin  ->  http://localhost:${PORT}\n  login: /login  ·  admin panel: /admin-panel  (admin: ${ADMIN.username})\n`));
const fail = (res, msg, mode = 'login') => res.type('html').send(pageAuth(mode, makeCaptcha(), msg));
const notFound = (res) => res.status(404).type('html').send(pageNotFound());
// header auth icons injected into the public site chrome (ICONS_SLOT), driven by session state
const _svg = (p) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const SVG = {
  login: _svg('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>'),
  register: _svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>'),
  user: _svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  shield: _svg('<path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5z"/>'),
  logout: _svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
};
function headerIcons(u) {
  if (!u) return `<a class="h-icon" href="/login" title="Log in" aria-label="log in">${SVG.login}</a><a class="h-icon" href="/register" title="Register" aria-label="register">${SVG.register}</a>`;
  const admin = u.role === 'admin' ? `<a class="h-icon" href="/admin-panel" title="Admin panel" aria-label="admin panel">${SVG.shield}</a>` : '';
  return `<a class="h-icon h-avatar" href="/account" title="Your account" aria-label="your account"><img src="/avatar/${encodeURIComponent(u.sub)}" alt="" width="24" height="24"></a>${admin}<form method="post" action="/logout" class="h-logout"><button class="h-icon" type="submit" title="Log out" aria-label="log out">${SVG.logout}</button></form>`;
}

// ================= server-rendered comments/likes =================
function renderComments(slug, user) {
  const likeCount = db.prepare('SELECT COUNT(*) n FROM likes WHERE post=?').get(slug).n;
  const liked = user ? !!db.prepare('SELECT 1 FROM likes WHERE post=? AND username=?').get(slug, user.sub) : false;
  const comments = db.prepare('SELECT id,username,body,ts FROM comments WHERE post=? ORDER BY ts ASC').all(slug);
  const isAdmin = !!(user && user.role === 'admin');
  const heart = `<svg viewBox="0 0 24 24" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>`;
  const likeBar = user
    ? `<form method="post" action="/posts/${esc(slug)}/like"><button class="like-btn${liked ? ' on' : ''}" type="submit">${heart} ${liked ? 'Liked' : 'Like'}</button></form>`
    : `<a class="like-btn" href="/login">${heart} Like</a>`;
  const list = comments.map((c) => {
    const canDel = user && (isAdmin || user.sub === c.username);
    return `<li class="cmt-item"><div class="meta"><span class="who${isAdminName(c.username) ? ' admin' : ''}">${esc(c.username)}</span><span>${fmtTs(c.ts)}</span>
      ${canDel ? `<form method="post" action="/posts/${esc(slug)}/comment/${c.id}/delete" onsubmit="return confirm('Delete comment?')"><button class="cmt-del" type="submit">delete</button></form>` : ''}
    </div><div class="body">${esc(c.body)}</div></li>`;
  }).join('');
  const form = user
    ? `<form class="cmt-form" method="post" action="/posts/${esc(slug)}/comment"><textarea name="body" placeholder="Write a comment…" required></textarea><div class="row2"><button type="submit">Post comment</button></div></form>`
    : `<div class="cmt-login">Please <a href="/login">log in</a> to like or comment.</div>`;
  return `<div class="chead"><h2>Comments (${comments.length})</h2></div>
    <div class="likebar">${likeBar}<span class="count">${likeCount} like${likeCount === 1 ? '' : 's'}</span></div>
    <ul class="cmt-list">${list}</ul>${form}`;
}

// ================= inline themed admin/auth HTML =================
// Admin theme: intentionally minimal — light neutrals, normal (roman) serif, no blocky display font, no bright fills.
const THEME = `<style>
 :root{--bg:#f7f4ef;--card:#f4efe7;--ink:#2a3340;--muted:#8a8172;--border:#e7e1d8;--bh:#d8d0c4;--accent:#2a3340;--link:#3a5f80;--red:#a4564f;--green:#4f7a5c;--soft:#f1ece4}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:'Roboto Slab',Georgia,'Times New Roman',serif;font-size:15px;line-height:1.5}
 .top{display:flex;align-items:center;height:58px;padding:0 22px;border-bottom:1px solid var(--border);background:var(--card)}
 .brand{font-weight:700;font-size:18px;letter-spacing:.2px;color:var(--ink)}.brand .a,.brand .b{color:var(--ink)}
 a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
 .wrap{max-width:1040px;margin:24px auto;padding:0 22px}
 h1{font-weight:700;font-size:21px;margin:0 0 6px}
 .sec{font-weight:700;font-size:13px;color:var(--muted);letter-spacing:.5px;text-transform:uppercase;margin:28px 0 12px}
 .card{background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:0 1px 3px rgba(18,32,58,.10),0 1px 2px rgba(18,32,58,.06);padding:24px}
 .auth{max-width:440px;margin:9vh auto}
 label{display:block;font-weight:600;font-size:12.5px;color:var(--muted);margin:14px 0 6px}
 input,select,textarea{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:15px;background:var(--card);color:var(--ink)}
 input:focus,select:focus{outline:none;border-color:var(--accent)}
 .pw-wrap{position:relative;display:flex;align-items:stretch}.pw-wrap input{flex:1;padding-right:64px}
 .pw-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:var(--soft);border:1px solid var(--border);border-radius:6px;font-size:11px;font-weight:600;color:var(--muted);padding:4px 9px;cursor:pointer;font-family:inherit}
 .pw-eye:hover{color:var(--accent);border-color:var(--accent)}
 .btn{font-family:inherit;font-weight:600;font-size:13px;background:var(--ink);color:#fff;border:0;border-radius:7px;padding:8px 14px;cursor:pointer}
 .btn.pink{background:var(--accent)}.btn.ghost{background:var(--card);color:var(--ink);border:1px solid var(--bh)}.btn.red{background:var(--card);color:var(--red);border:1px solid #e3c9c6}
 form.inline{display:inline}
 .err{background:#fbeeed;border:1px solid #eccfcb;color:var(--red);border-radius:8px;padding:10px 12px;margin:14px 0}
 .ok{background:#eef4ef;border:1px solid #d5e4d9;color:var(--green);border-radius:8px;padding:12px 14px;margin:14px 0}
 .muted{color:var(--muted);font-size:14px}.bar{display:flex;gap:10px;justify-content:space-between;align-items:center;margin-top:18px}
 .cap{display:flex;gap:12px;align-items:center}.cap .q{font-weight:600;font-size:13px;background:var(--soft);border:1px solid var(--border);border-radius:8px;padding:9px 12px;white-space:nowrap}
 table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(18,32,58,.10),0 1px 2px rgba(18,32,58,.06)}
 th,td{padding:10px 12px;border-bottom:1px solid var(--border);text-align:left;font-size:14px;vertical-align:middle}
 th{font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);background:var(--soft)}
 .pill{display:inline-block;font-weight:600;font-size:10.5px;border-radius:5px;padding:2px 8px;border:1px solid transparent}
 .pill.admin{background:#eef1f5;color:#3a5068;border-color:#dbe2ea}.pill.mod{background:#eef0f6;color:#5b5896;border-color:#dfe0ee}.pill.user{background:var(--soft);color:var(--muted);border-color:var(--border)}
 .pill.ok{background:#eef4ef;color:var(--green);border-color:#d5e4d9}.pill.pend{background:#f6f0e4;color:#8a6d1f;border-color:#e8ddc4}.pill.susp{background:#fbeeed;color:var(--red);border-color:#eccfcb}
 .acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
 .cmt{border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--card)}
 .cmt .h{font-size:12.5px;color:var(--muted)}.cmt .b{font-size:14.5px;white-space:pre-wrap}
 .log{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
</style>`;
const HEAD = (t) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title>
<link href="https://fonts.googleapis.com/css2?family=Roboto+Slab:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/easymde/dist/easymde.min.css">${THEME}</head><body>
<div class="top"><a class="brand" href="/"><span class="a">to</span><span class="b">bi</span></a></div>`;
const FOOT = `<script src="https://cdn.jsdelivr.net/npm/easymde/dist/easymde.min.js"></script></body></html>`;

function pageMsg(t, html) { return HEAD(t) + `<div class="wrap"><div class="card auth"><h1>${t}</h1><div class="ok">${html}</div><a class="btn ghost" href="/">Back to forums</a></div></div>` + FOOT; }
function pageAuth(mode, cap, err = '') {
  const reg = mode === 'register';
  return HEAD(reg ? 'Register' : 'Log in') + `<div class="wrap"><div class="card auth"><h1>${reg ? 'Register' : 'Log in'}</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="post" action="${reg ? '/api/register' : '/api/login'}">
      ${reg ? '<label>Username</label><input name="username" autocomplete="off" required>' : ''}
      ${reg ? '<label>Email</label><input name="email" type="email" required>' : '<label>Email or username</label><input name="login" autocomplete="username" required>'}
      <label>Password</label>${PW('password', reg ? 'autocomplete="new-password" required' : 'autocomplete="current-password" required')}
      <label>Captcha</label><div class="cap"><span class="q">${cap.q}</span><input name="captcha" autocomplete="off" style="max-width:120px" required></div>
      <input type="hidden" name="captcha_token" value="${cap.token}">
      <div class="bar"><a class="muted" href="${reg ? '/login' : '/register'}">${reg ? 'Already have an account? Log in' : 'No account? Register'}</a>
      <button class="btn pink" type="submit">${reg ? 'Create account' : 'Enter'}</button></div>
    </form>${reg ? '<p class="muted" style="margin-top:14px">You can sign in right away. Publishing posts requires administrator approval.</p>' : ''}
  </div></div>` + FOOT;
}
const statusPill = (u) => u.suspended ? '<span class="pill susp">suspended</span>' : !u.approved ? '<span class="pill pend">no posting</span>' : '<span class="pill ok">can post</span>';
const F = (action, label, cls = 'ghost', confirm = '') => `<form class="inline" method="post" action="${action}"${confirm ? ` onsubmit="return confirm('${confirm}')"` : ''}><button class="btn ${cls}" type="submit">${label}</button></form>`;
const ADMIN_MSG = {
  add_ok: ['ok', 'User created.'], add_fields: ['err', 'Add user: username, email and password are all required.'],
  add_pw: ['err', 'Add user: password must be 8–200 characters.'], add_dupuser: ['err', 'Add user: that username is already taken.'],
  add_user: ['err', 'Add user: username must be 3–32 characters: letters, numbers, and . _ - only.'], add_email: ['err', 'Add user: enter a valid email address.'],
  add_dupemail: ['err', 'Add user: that email is already registered.'], save_ok: ['ok', 'User updated.'],
  post_saved: ['ok', 'Post saved. The site is rebuilding — your post will appear in a few seconds.'],
};
function pageAdmin(user, pending, users, posts, comments, audit, msg) {
  const m = ADMIN_MSG[msg];
  const banner = m ? `<div class="${m[0]}">${esc(m[1])}</div>` : '';
  return HEAD('Admin') + `<div class="wrap">
   <div style="display:flex;justify-content:space-between;align-items:center"><h1>Admin panel</h1>
     <div style="display:flex;gap:10px"><a class="btn pink" href="/admin-panel/new">+ New post</a>${F('/logout', 'Log out')}</div></div>
   <p class="muted">Signed in as <b>${esc(user.sub)}</b> (admin)</p>
   ${banner}

   <div class="sec">Awaiting posting permission (${pending.length})</div>
   <p class="muted" style="margin:-4px 0 10px">These accounts can sign in and use their profile, but cannot publish posts until you allow it.</p>
   ${pending.length ? '<table><tr><th>User</th><th>Email</th><th>Action</th></tr>' + pending.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.email)}</td>
     <td class="acts">${F('/admin-panel/approve/' + u.uid, 'Allow posting', 'pink')}${F('/admin-panel/delete-user/' + u.uid, 'Delete', 'red', 'Delete this account?')}</td></tr>`).join('') + '</table>' : '<div class="card muted">Everyone is allowed to post.</div>'}

   <div class="sec">Users (${users.length})</div>
   <table><tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr>
   ${users.map((u) => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.email)}</td>
     <td><span class="pill ${u.role === 'admin' ? 'admin' : u.role === 'moderator' ? 'mod' : 'user'}">${u.role}</span></td><td>${statusPill(u)}</td>
     <td class="acts"><a class="btn ghost" href="/admin-panel/edit-user/${u.uid}">Edit</a>${isAdminName(u.username) ? '<span class="muted">primary admin</span>' : `
       ${!u.approved ? F('/admin-panel/approve/' + u.uid, 'Allow posting', 'pink') : ''}
       ${u.suspended ? F('/admin-panel/unsuspend/' + u.uid, 'Unsuspend') : F('/admin-panel/suspend/' + u.uid, 'Suspend')}
       <form class="inline" method="post" action="/admin-panel/role/${u.uid}"><select name="role" onchange="this.form.submit()"><option ${u.role === 'user' ? 'selected' : ''}>user</option><option ${u.role === 'moderator' ? 'selected' : ''}>moderator</option><option ${u.role === 'admin' ? 'selected' : ''}>admin</option></select></form>
       ${F('/admin-panel/delete-user/' + u.uid, 'Delete', 'red', 'Delete this user?')}`}</td></tr>`).join('')}
   </table>

   <div class="sec">Add user</div>
   <form class="card" method="post" action="/admin-panel/add-user"><div class="grid">
     <div><label>Username</label><input name="username" required></div><div><label>Email</label><input name="email" type="email" required></div>
     <div><label>Password</label>${PW('password', 'autocomplete="new-password" required')}</div>
     <div><label>Role</label><select name="role"><option>user</option><option>moderator</option><option>admin</option></select></div>
   </div><div class="bar"><span></span><button class="btn pink" type="submit">Create user</button></div></form>

   <div class="sec">Posts (${posts.length})</div>
   <table><tr><th>Title</th><th>Category</th><th>Date</th><th>Actions</th></tr>
   ${posts.map((p) => `<tr><td>${esc(p.title || p.slug)} ${p.draft ? '<span class="pill pend">draft</span>' : ''}</td><td>${esc(p.category)}</td><td>${esc(p.date || '')}</td>
     <td class="acts">${p.draft ? F('/admin-panel/publish/' + p.slug, 'Publish', 'pink') : ''}<a class="btn ghost" href="/admin-panel/edit/${p.slug}">Edit</a>${F('/admin-panel/delete-post/' + p.slug, 'Delete', 'red', 'Delete post?')}</td></tr>`).join('')}</table>

   <div class="sec">Comments (${comments.length})</div>
   ${comments.length ? comments.map((c) => `<div class="cmt"><div class="h"><b>${esc(c.username)}</b> on <a href="/posts/${esc(c.post)}">${esc(c.post)}</a> · ${fmtTs(c.ts)}
     <span style="float:right">${F('/admin-panel/delete-comment/' + c.id, 'Delete', 'red', 'Delete comment?')}</span></div><div class="b">${esc(c.body)}</div></div>`).join('') : '<div class="card muted">No comments.</div>'}

   <div class="sec">Activity log</div>
   <table><tr><th>When</th><th>Actor</th><th>IP</th><th>Action</th><th>Target</th></tr>
   ${audit.map((a) => `<tr><td class="log">${fmtTs(a.ts)}</td><td>${esc(a.actor)}</td><td class="log">${esc(a.ip || '—')}</td><td class="log">${esc(a.action)}</td><td>${esc(a.target)}</td></tr>`).join('')}</table>
  </div>` + FOOT;
}
function pageEditor(post) {
  return HEAD(post ? 'Edit' : 'New post') + `<div class="wrap"><form class="card" method="post" action="/admin-panel/save-post" onsubmit="if(window.mde)mde.codemirror.save()"><h1>${post ? 'Edit post' : 'New post'}</h1>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div><label>Title</label><input name="title" value="${post ? esc(post.data.title) : ''}" required></div>
      <div><label>Slug</label><input name="slug" value="${post ? post.slug : ''}" ${post ? 'readonly' : 'placeholder="auto"'}></div>
      <div><label>Category</label><select name="category">${CATEGORIES.map((c) => `<option ${post && post.data.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div><label>Date</label><input name="date" value="${post ? fmtDate(post.data.date) : new Date().toISOString().slice(0, 10)}"></div>
      <div><label>Tags</label><input name="tags" value="${post ? (post.data.tags || []).join(', ') : ''}"></div>
      <div><label>Status</label><select name="draft"><option value="false">published</option><option value="true" ${post && post.data.draft ? 'selected' : ''}>draft</option></select></div>
    </div><label>Description</label><input name="description" value="${post ? esc(post.data.description || '') : ''}">
    <label>Content</label><textarea name="body" id="body">${post ? esc(post.body) : ''}</textarea>
    <div class="bar"><a class="btn ghost" href="/admin-panel">Cancel</a><button class="btn pink" type="submit">Save</button></div></form></div>
  <script>var mde=new EasyMDE({element:document.getElementById('body'),spellChecker:false,autofocus:true,toolbar:['bold','italic','heading','|','quote','code','unordered-list','ordered-list','|','link','image','table','|','preview','side-by-side','fullscreen','|','guide'],status:['lines','words']});</script>` + FOOT;
}

function pageEditUser(u, err = '', actorSub = '') {
  const st = userStats(u);
  const self = lc(u.username) === lc(actorSub);        // editing your own account
  const primary = isAdminName(u.username);
  const roleLocked = primary || self;                  // your own/the primary admin's role can't be set from here
  return HEAD('Edit user') + `<div class="wrap"><a class="muted" href="/admin-panel">&larr; Back to admin panel</a>
  <form class="card" method="post" action="/admin-panel/save-user/${u.uid}" style="max-width:560px;margin-top:14px"><h1>Edit user</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <label>Username</label>${primary ? `<input value="${esc(u.username)}" disabled><p class="muted" style="text-transform:none">The primary admin username is fixed.</p>` : `<input name="username" value="${esc(u.username)}">`}
    <label>Email</label><input name="email" type="email" value="${esc(u.email)}">
    <label>New password <span class="muted" style="text-transform:none">(leave blank to keep)</span></label>${PW('password', 'autocomplete="new-password"')}
    ${roleLocked ? `<label>Role</label><p class="muted" style="text-transform:none">${self ? 'Your own role is taken from your session — it can’t be changed here.' : 'Primary admin — role locked.'} (currently ${esc(u.role)})</p>` : `<label>Role</label><select name="role"><option ${u.role === 'user' ? 'selected' : ''}>user</option><option ${u.role === 'moderator' ? 'selected' : ''}>moderator</option><option ${u.role === 'admin' ? 'selected' : ''}>admin</option></select>`}
    <label>Profile stats <span class="muted" style="text-transform:none">(shown on the hover card & member page)</span></label>
    <div class="grid" style="grid-template-columns:1fr 1fr 1fr;gap:10px">
      <div><label>Messages</label><input name="stat_messages" type="number" value="${st.messages}"></div>
      <div><label>Reaction score</label><input name="stat_reactions" type="number" value="${st.reactions}"></div>
      <div><label>Points</label><input name="stat_points" type="number" value="${st.points}"></div>
    </div>
    <div class="bar"><a class="btn ghost" href="/admin-panel">Cancel</a><button class="btn pink" type="submit">Save changes</button></div>
  </form></div>` + FOOT;
}
function pageError(code, msg) {
  return HEAD(code === 404 ? 'Not found' : 'Error') + `<div class="wrap"><div class="card auth" style="text-align:center"><h1>${code}</h1><p class="muted">${msg}</p><a class="btn ghost" href="/">Back to forums</a></div></div>` + FOOT;
}
const pageNotFound = () => pageError(404, 'The page you requested could not be found.');

// ---- account area (rendered into the public site shell via ACCOUNT_SLOT; uses the public stylesheet) ----
const A_NOTE = {
  ok: { '1': 'Your changes have been saved.', photo: 'Profile photo updated.', submitted: 'Your post was submitted and is awaiting an administrator to publish it.', published: 'Your post is now live.' },
  err: { type: 'That file is not a valid JPEG or PNG image.', size: 'That image is too large — 2 MB maximum.', none: 'No file was selected.', current: 'Your current password is incorrect.', pw: 'New password must be 8–200 characters with no control characters.', match: 'The new passwords do not match.', title: 'A title is required.' },
};
function accountNote(q = {}) {
  if (q.welcome) return `<div class="acct-note ok">Welcome — your account is ready. Add a photo and details below. Posting is enabled once an administrator approves you.</div>`;
  if (q.ok) return `<div class="acct-note ok">${A_NOTE.ok[q.ok] || 'Saved.'}</div>`;
  if (q.err) return `<div class="acct-note err">${A_NOTE.err[q.err] || 'Something went wrong.'}</div>`;
  return '';
}
function accountAnon() {
  return `<div class="page-head"><h1>Your account</h1></div>
  <div class="acct-empty"><p>You need to be signed in to view your account.</p>
  <p style="margin-top:12px"><a class="save-btn" href="/login">Log in</a> &nbsp; or &nbsp; <a href="/register">create an account</a></p></div>`;
}
function accountPanel(u, tab, q = {}) {
  if (!u) return accountAnon();
  tab = ['details', 'security', 'write'].includes(tab) ? tab : 'details';
  const post = canPost(u);
  const staff = isStaff(u);
  const postLabel = staff ? 'Can publish posts' : post ? 'Can submit for review' : 'Posting pending approval';
  const av = u.avatar || (isAdminName(u.username) ? '/owner.jpg' : '/avatar.svg');
  const since = (() => { try { return new Date(u.created).toISOString().slice(0, 10); } catch { return ''; } })();
  const roleLabel = u.role.charAt(0).toUpperCase() + u.role.slice(1);
  const tabs = [['details', 'Account details'], ['security', 'Password & security']];
  if (post) tabs.push(['write', 'Write a post']);
  const side = `<aside class="acct-side">
    <div class="grp">Your account</div>
    ${tabs.map(([k, l]) => `<a href="/account?tab=${k}" class="${tab === k ? 'on' : ''}">${l}</a>`).join('')}
    <form method="post" action="/logout" style="margin:0"><button class="acct-side-out" type="submit">Log out</button></form>
  </aside>`;
  const overview = `<div class="acct-id">
    <img class="acct-av" src="${esc(av)}" alt="Profile photo">
    <div class="acct-id-meta">
      <div class="acct-name">${esc(u.username)}</div>
      <div class="acct-chips"><span class="chip">${esc(roleLabel)}</span><span class="chip ${post ? 'chip-ok' : 'chip-wait'}">${postLabel}</span></div>
      <div class="hint">Member since ${since} &middot; ${esc(u.email)}</div>
    </div></div>`;
  let panel = '';
  if (tab === 'details') {
    panel = `
    <form class="acct-form" method="post" action="/account/avatar" enctype="multipart/form-data">
      <div class="frow"><div class="lab">Profile photo</div><div class="fld avatar-fld">
        <img class="avatar-preview" src="${esc(av)}" alt="Current photo">
        <div class="avatar-ctl">
          <input type="file" name="photo" accept="image/png,image/jpeg" required>
          <div class="avatar-btns"><button class="save-btn" type="submit">Upload photo</button></div>
          <div class="hint">JPEG or PNG only. The server verifies the content-type and the file's header bytes and stores the image as base64. Maximum 2&nbsp;MB.</div>
        </div>
      </div></div>
    </form>
    ${u.avatar ? `<form method="post" action="/account/remove-avatar" style="margin:8px 0 18px"><button class="acct-link-btn" type="submit">Remove current photo</button></form>` : '<div style="height:8px"></div>'}
    <form class="acct-form" method="post" action="/account/details">
      <div class="frow"><div class="lab">Username</div><div class="fld">${esc(u.username)}</div></div>
      <div class="frow"><div class="lab">Email</div><div class="fld">${esc(u.email)}</div></div>
      <div class="frow"><div class="lab">Location</div><div class="fld"><input type="text" name="location" value="${esc(u.location)}" maxlength="120"></div></div>
      <div class="frow"><div class="lab">Website</div><div class="fld"><input type="text" name="website" value="${esc(u.website)}" maxlength="200" placeholder="https://"></div></div>
      <div class="frow"><div class="lab">About you</div><div class="fld"><textarea name="about" rows="5" maxlength="2000" placeholder="Write something about yourself…">${esc(u.about)}</textarea></div></div>
      <div class="acct-actions"><button class="save-btn" type="submit">Save changes</button></div>
    </form>`;
  } else if (tab === 'security') {
    panel = `
    <form class="acct-form" method="post" action="/account/password">
      <div class="frow"><div class="lab">Current password</div><div class="fld">${PW('current', 'autocomplete="current-password" required')}</div></div>
      <div class="frow"><div class="lab">New password</div><div class="fld">${PW('pw', 'autocomplete="new-password" required')}<div class="hint">8–200 characters.</div></div></div>
      <div class="frow"><div class="lab">Confirm password</div><div class="fld">${PW('pw2', 'autocomplete="new-password" required')}</div></div>
      <div class="acct-actions"><button class="save-btn" type="submit">Change password</button></div>
    </form>`;
  } else {
    panel = post ? `
    <form class="acct-form" method="post" action="/account/write">
      <div class="frow"><div class="lab">Title</div><div class="fld"><input type="text" name="title" required maxlength="140"></div></div>
      <div class="frow"><div class="lab">Category</div><div class="fld"><select name="category">${CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}</select></div></div>
      <div class="frow"><div class="lab">Body</div><div class="fld"><textarea name="body" rows="14" placeholder="Markdown supported…"></textarea><div class="hint">${staff ? 'You are staff — your post is published live immediately.' : 'Your post is submitted as a draft and published after an administrator reviews it.'}</div></div></div>
      <div class="acct-actions"><button class="save-btn" type="submit">Submit for review</button></div>
    </form>` : `<div class="acct-empty">You do not have posting permission yet.</div>`;
  }
  return `<div class="page-head"><h1>Your account</h1></div>
    ${accountNote(q)}
    <div class="acct-layout">${side}<div class="acct-main">${overview}${panel}</div></div>`;
}
