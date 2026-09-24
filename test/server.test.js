// Integration tests for admin/server.js — run with `npm test` (builds the site first).
// The server runs against a throwaway copy of the project + a temp data dir, so real posts and app.db are never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { username: 't0b!', password: 'admin-test-pass' };
let tmp, server, base, ipN = 0;

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); }); });

before(async () => {
  if (!fs.existsSync(path.join(REPO, 'dist', 'index.html'))) throw new Error('dist/ missing — run `npm run build` first (npm test does this)');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secblog-test-'));
  for (const p of ['src', 'public', 'dist', 'package.json', 'astro.config.mjs', 'admin/server.js']) fs.cpSync(path.join(REPO, p), path.join(tmp, p), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(tmp, 'outside.html'), 'OUTSIDE-DIST-MARKER');   // sibling of dist/ — must never be served
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  let out = '';
  // own process group, so the post-save rebuild (npm -> astro) is killed along with the server
  server = spawn(process.execPath, ['admin/server.js'], {
    cwd: tmp, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(tmp, 'data'), TRUST_PROXY: '1', ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password, ADMIN_EMAIL: 'admin@test.local', JWT_SECRET: '' },
  });
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/login')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start:\n' + out);
});

after(() => {
  try { process.kill(-server.pid, 'SIGKILL'); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A browser-ish client with its own cookie jar. Each client appears to come from its own IP (as the proxy would report
// it: the last X-Forwarded-For entry), so per-IP rate limits don't bleed between tests.
function client(ip = `198.51.100.${++ipN}`) {
  let cookie = '';
  const c = {
    ip,
    async req(pathname, { method = 'GET', form, headers = {} } = {}) {
      const h = { 'x-forwarded-for': ip, 'user-agent': 'test-agent', ...headers };
      if (cookie) h.cookie = cookie;
      if (form) h['content-type'] = 'application/x-www-form-urlencoded';
      const res = await fetch(base + pathname, { method, headers: h, body: form && new URLSearchParams(form), redirect: 'manual' });
      for (const s of res.headers.getSetCookie()) { const m = /^token=([^;]*)/.exec(s); if (m) cookie = m[1] ? `token=${m[1]}` : ''; }
      return { status: res.status, location: res.headers.get('location') || '', headers: res.headers, text: await res.text() };
    },
    async captcha(page) {
      const { text } = await c.req(page);
      const [, a, b] = /What is (\d+) \+ (\d+)\?/.exec(text);
      return { captcha: String(+a + +b), captcha_token: /name="captcha_token" value="([^"]+)"/.exec(text)[1] };
    },
    async register(username, password = 'password123') {
      return c.req('/api/register', { method: 'POST', form: { username, email: `${username}@test.local`, password, ...(await c.captcha('/register')) } });
    },
    async login(login, password) {
      return c.req('/api/login', { method: 'POST', form: { login, password, ...(await c.captcha('/login')) } });
    },
    get loggedIn() { return !!cookie; },
  };
  return c;
}

let admin;
async function asAdmin() {
  if (!admin) { admin = client(); await admin.login(ADMIN.username, ADMIN.password); assert.ok(admin.loggedIn, 'admin login failed'); }
  return admin;
}
async function uidOf(username) {
  const { text } = await (await asAdmin()).req('/admin-panel');
  const m = new RegExp(`<tr><td><b>${username}</b></td>.*?edit-user/([\\w-]+)`, 's').exec(text);
  assert.ok(m, `no admin-panel row for ${username}`);
  return m[1];
}

test('encoded ../ cannot read .html files outside dist/', async () => {
  const r = await client().req('/..%2foutside.html');
  assert.equal(r.status, 404);
  assert.ok(!r.text.includes('OUTSIDE-DIST-MARKER'));
});

test('malformed URLs get a 400 without a stack trace', async () => {
  const r = await client().req('/%E0%A4%A');
  assert.equal(r.status, 400);
  assert.ok(!/URIError|node_modules|\.js:\d+/.test(r.text), 'stack trace leaked');
});

test('security headers are set and X-Powered-By is gone', async () => {
  const { headers } = await client().req('/');
  assert.equal(headers.get('x-powered-by'), null);
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.match(headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('client-supplied X-Forwarded-For entries are not trusted', async () => {
  // what a proxy forwards when a client sends "X-Forwarded-For: 6.6.6.6": the client's value, then the real address
  const c = client('6.6.6.6, 203.0.113.77');
  await c.register('xff_user');
  const { text } = await (await asAdmin()).req('/admin-panel');
  assert.ok(text.includes('203.0.113.77'), 'real client IP should be logged');
  assert.ok(!text.includes('6.6.6.6'), 'spoofed IP must not be logged');
});

test('rate-limit blocks are per IP, not shared by everyone with the same User-Agent', async () => {
  const ua = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36' };
  const attacker = client();
  let last;
  for (let i = 0; i < 14; i++) last = await attacker.req('/api/login', { method: 'POST', form: { login: 'nobody', password: 'x' }, headers: ua });
  assert.equal(last.status, 429, 'attacker should be blocked');
  const victim = await client().req('/api/login', { method: 'POST', form: { login: 'nobody', password: 'x' }, headers: ua });
  assert.notEqual(victim.status, 429, 'a different IP with the same UA must not be blocked');
});

test('suspending a user ends their session immediately', async () => {
  const u = client();
  await u.register('susp_user');
  assert.ok(u.loggedIn);
  await (await asAdmin()).req('/admin-panel/suspend/' + await uidOf('susp_user'), { method: 'POST' });
  const r = await u.req('/posts/ctf-web-walkthrough/comment', { method: 'POST', form: { body: 'posted-after-suspension' } });
  assert.equal(r.location, '/login');
  assert.ok(!(await client().req('/posts/ctf-web-walkthrough')).text.includes('posted-after-suspension'));
});

test('demoting an admin revokes panel access immediately', async () => {
  const a = await asAdmin();
  await a.req('/admin-panel/add-user', { method: 'POST', form: { username: 'second_admin', email: 'second@test.local', password: 'password123', role: 'admin' } });
  const u = client();
  await u.login('second_admin', 'password123');
  assert.equal((await u.req('/admin-panel')).status, 200);
  await a.req('/admin-panel/role/' + await uidOf('second_admin'), { method: 'POST', form: { role: 'user' } });
  assert.equal((await u.req('/admin-panel')).status, 404);
});

test('"$" patterns in a comment are rendered literally', async () => {
  const u = client();
  await u.register('dollar_user');
  await u.req('/posts/ctf-web-walkthrough/comment', { method: 'POST', form: { body: "A$`B$'C$&D" } });
  const { text } = await client().req('/posts/ctf-web-walkthrough');
  assert.ok(text.includes("A$`B$'C$&amp;D"), 'comment should appear verbatim');
  assert.equal(text.match(/<!doctype html>/gi).length, 1, 'page HTML was spliced into the comment');
});

test('comments on posts that do not exist are rejected', async () => {
  const u = client();
  await u.register('ghost_user');
  const r = await u.req('/posts/no-such-post/comment', { method: 'POST', form: { body: 'ghost-comment' } });
  assert.equal(r.status, 404);
  assert.ok(!(await (await asAdmin()).req('/admin-panel')).text.includes('ghost-comment'));
});

test('password change enforces the same 200-char cap as login', async () => {
  const u = client();
  await u.register('longpw_user');
  const long = 'a'.repeat(500);
  const r = await u.req('/account/password', { method: 'POST', form: { current: 'password123', pw: long, pw2: long } });
  assert.match(r.location, /err=pw/);
  const again = client();
  await again.login('longpw_user', 'password123');
  assert.ok(again.loggedIn, 'old password should still work');
});

test('admin add-user validates the username', async () => {
  const r = await (await asAdmin()).req('/admin-panel/add-user', { method: 'POST', form: { username: 'bad"name', email: 'bad@test.local', password: 'password123', role: 'user' } });
  assert.match(r.location, /msg=add_user/);
});

// keep last: saving a post triggers a background site rebuild
test("an approved user's draft never overwrites an existing post", async () => {
  const file = path.join(tmp, 'src/content/posts/ctf-web-walkthrough.md');
  const original = fs.readFileSync(file, 'utf8');
  const u = client();
  await u.register('writer_user');
  await (await asAdmin()).req('/admin-panel/approve/' + await uidOf('writer_user'), { method: 'POST' });
  const r = await u.req('/account/write', { method: 'POST', form: { title: 'CTF web walkthrough', category: 'ctf', body: 'replacement body' } });
  assert.match(r.location, /ok=submitted/);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'existing post was overwritten');
  assert.match(fs.readFileSync(path.join(tmp, 'src/content/posts/ctf-web-walkthrough-2.md'), 'utf8'), /draft: true[\s\S]*replacement body/);
});
