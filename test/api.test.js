// The comments / likes / visitor-stats API (api/src/index.js), run in Node with a stand-in database (test/d1.js).
// GitHub (the admin sign-in check) and the blog's search index are faked, so nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../api/src/index.js';
import { d1 } from './d1.js';

const SITE = 'https://blog.example';
const GOOD = 'github_pat_' + 'A'.repeat(40), BAD = 'github_pat_' + 'B'.repeat(40);
const READER = 'ghp_' + 'R'.repeat(36);   // someone else's valid token: GitHub lets it read the public repo, not push
const FINE = 'github_pat_' + 'F'.repeat(40);   // the owner's token, with GitHub leaving out the permissions field
const G1 = 'a'.repeat(32), G2 = 'b'.repeat(32);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MUMBAI = { country: 'IN', region: 'Maharashtra', city: 'Mumbai', latitude: '19.07', longitude: '72.87', timezone: 'Asia/Kolkata', asn: 55836, asOrganization: 'Reliance Jio' };

let env, github;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === `${SITE}/search-index.json`) return Response.json([{ url: '/posts/hello-world' }, { url: '/posts/second-post/' }]);
  if (u.startsWith('https://api.github.com/repos/me/blog')) {
    github++;
    const auth = new Headers(init.headers).get('authorization');
    if (u === 'https://api.github.com/repos/me/blog') {   // the repo, with what this token's user may do
      if (auth === `Bearer ${BAD}`) return new Response('{"message":"Bad credentials"}', { status: 401 });
      if (auth === `Bearer ${FINE}`) return Response.json({ full_name: 'me/blog' });
      return Response.json({ full_name: 'me/blog', permissions: { admin: auth === `Bearer ${GOOD}`, push: auth === `Bearer ${GOOD}`, pull: true } });
    }
    // the write check. READER also gets 422 here, as if GitHub looked at the body before the permissions: the
    // push-rights check above still keeps it out
    return new Response('{}', { status: [`Bearer ${GOOD}`, `Bearer ${READER}`, `Bearer ${FINE}`].includes(auth) && init.method === 'PUT' ? 422 : 403 });
  }
  return realFetch(url, init);
};
beforeEach(() => { env = { DB: d1(), SITE_URL: SITE, GITHUB_REPO: 'me/blog', OWNER_NAME: 'tobi', API_VERSION: 'v-test' }; github = 0; });

async function call(method, path, { body, ip = '203.0.113.7', ua = IPHONE, cf = MUMBAI, origin = SITE, token, headers = {} } = {}) {
  const req = new Request('https://api.example' + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'cf-connecting-ip': ip, 'user-agent': ua, ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  Object.defineProperty(req, 'cf', { value: cf });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
}
const rows = (sql, ...a) => env.DB.sqlite.prepare(sql).all(...a);
// a form token like GET /posts/:slug hands out, made `age` ms ago (signed with the key the Worker stored)
async function form(slug, age = 5000) {
  if (!rows("SELECT name FROM sqlite_master WHERE name = 'meta'").length) await call('GET', '/health');
  const key = Buffer.from(rows("SELECT v FROM meta WHERE k = 'form_key'")[0].v, 'hex'), ts = Date.now() - age;
  return `${ts}.${createHmac('sha256', key).update(`${slug}.${ts}`).digest('base64url')}`;
}
const comment = async (slug, body, opts = {}) => call('POST', `/posts/${slug}/comments`, { ...opts, body: { guest: G1, name: 'Alice', form: await form(slug), ...body } });

test('health + CORS: the blog may call it, other sites may not write', async () => {
  const h = await call('GET', '/health');
  assert.equal(h.status, 200);
  assert.deepEqual(h.data, { ok: true, version: 'v-test' });
  assert.equal(h.headers.get('access-control-allow-origin'), SITE);
  const pre = await worker.fetch(new Request('https://api.example/admin/stats', { method: 'OPTIONS', headers: { origin: SITE } }), env);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  const evil = await call('POST', '/posts/hello-world/like', { origin: 'https://evil.example', body: { guest: G1, like: true } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal(rows('SELECT * FROM likes').length, 0);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/posts/%E0%A4%A')).status, 400);   // broken %-encoding: a 400, not a crash
  // no site configured: no other site may write
  env.SITE_URL = ''; env.ALLOWED_ORIGINS = '';
  assert.equal((await call('POST', '/posts/hello-world/like', { body: { guest: G1, like: true } })).status, 403);
});

test('page views: IP, location, device and referrer are recorded; bots are flagged', async () => {
  assert.equal((await call('POST', '/hit', { body: { path: '/posts/hello-world/?utm=x#top', ref: 'https://www.google.com/search?q=secret', title: 'Hello', guest: G1, lang: 'en-IN', screen: '390x844' } })).status, 204);
  await call('POST', '/hit', { body: { path: '/ctf/', ref: `${SITE}/`, guest: G1 } });
  await call('POST', '/hit', { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', body: { path: '/' } });
  // not a path on this site: ignored. Browsers read '/\\x' and '/<tab>/x' as //x, another site
  for (const path of ['https://evil.example/', '//evil.example/', '/\\evil.example/login', '/\t/evil.example', '/\n/evil.example', '/ /evil.example']) await call('POST', '/hit', { body: { path } });
  const v = rows('SELECT * FROM visits ORDER BY id');
  assert.equal(v.length, 3);
  assert.equal(v[0].path, '/posts/hello-world/');
  assert.equal(v[0].ip, '203.0.113.7');
  assert.deepEqual([v[0].country, v[0].region, v[0].city, v[0].org, v[0].asn, v[0].timezone], ['IN', 'Maharashtra', 'Mumbai', 'Reliance Jio', 55836, 'Asia/Kolkata']);
  assert.deepEqual([v[0].browser, v[0].os, v[0].device, v[0].bot], ['Safari', 'iOS', 'Mobile', 0]);
  assert.equal(v[0].referrer, 'www.google.com/search');   // no query string
  assert.equal(v[0].ref_host, 'google.com');
  assert.equal(v[0].guest, G1);
  assert.equal(v[1].referrer, null);                      // a click inside the blog isn't a referrer
  assert.equal(v[2].bot, 1);
});

test('page views are capped per IP', async () => {
  for (let i = 0; i < 125; i++) await call('POST', '/hit', { body: { path: '/' } });
  assert.equal(rows('SELECT COUNT(*) n FROM visits')[0].n, 120);
});

test('guest comments: posted, listed, never showing IPs or other guests\' ids', async () => {
  const c = await comment('hello-world', { body: '  Great writeup!\n\n\n\nThanks  ' });
  assert.equal(c.status, 201);
  assert.equal(c.data.comment.body, 'Great writeup!\n\nThanks');
  assert.equal(c.data.comment.mine, true);
  const mine = await call('GET', `/posts/hello-world?g=${G1}`), theirs = await call('GET', `/posts/hello-world?g=${G2}`);
  assert.equal(mine.data.comments.length, 1);
  assert.equal(mine.data.comments[0].mine, true);
  assert.equal(theirs.data.comments[0].mine, false);
  const json = JSON.stringify(theirs.data);
  assert.ok(!json.includes('203.0.113.7') && !json.includes(G1) && !json.includes('Mumbai'), json);
  assert.equal(rows('SELECT ip, city FROM comments')[0].ip, '203.0.113.7');   // kept for the admin only
});

test('comment checks: name, body, spam trap, speed, owner name, links, real posts only', async () => {
  const err = async (body, status, re, opts) => { const r = await comment('hello-world', body, opts); assert.equal(r.status, status, JSON.stringify(r.data)); assert.match(r.data.error, re); };
  await err({ name: '' }, 400, /name/i);
  await err({ body: '   ' }, 400, /Write something/);
  await err({ body: 'x'.repeat(2001) }, 400, /at most 2000/);
  await err({ body: 'hi', trap: 'http://spam' }, 400, /spam/);
  await err({ body: 'hi', form: undefined }, 400, /Reload/);                          // no form token: posted without the page
  await err({ body: 'hi', form: await form('hello-world', 500) }, 400, /quick/);       // under 3 seconds after loading
  await err({ body: 'hi', form: await form('second-post') }, 400, /Reload/);           // a token for another post
  const flip = (t, i) => t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1);
  const good = await form('hello-world'), dot = good.indexOf('.');
  await err({ body: 'hi', form: flip(good, dot + 10) }, 400, /Reload/);                // tampered signature
  await err({ body: 'hi', form: flip(good, dot - 1) }, 400, /Reload/);                 // tampered time
  // same signature bytes, other spelling: the last character's lowest bit is spare in 43-character base64
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const respelled = good.slice(0, -1) + B64[B64.indexOf(good.at(-1)) ^ 1];
  assert.deepEqual(Buffer.from(respelled.slice(dot + 1), 'base64url'), Buffer.from(good.slice(dot + 1), 'base64url'));
  await err({ body: 'hi', form: respelled }, 400, /Reload/);
  await err({ body: 'hi', form: await form('hello-world', 25 * 3600e3) }, 400, /long time/);
  await err({ body: 'hi', name: 'TOBI' }, 400, /site owner/);
  await err({ body: 'hi', name: 'buy at www.x.com' }, 400, /links/);
  await err({ body: 'a http://1 http://2 http://3 http://4' }, 400, /links/);
  await err({ body: 'hi', guest: 'nope' }, 400, /Reload/);
  const nopost = await comment('no-such-post', { body: 'hi' });
  assert.equal(nopost.status, 404);
  assert.equal((await comment('second-post', { body: 'hi' })).status, 201);   // listed as /posts/second-post/
  assert.equal(rows('SELECT COUNT(*) n FROM comments')[0].n, 1);
});

test('comment limits: 3 per 2 minutes, duplicates, blocked IPs', async () => {
  for (const b of ['one', 'two', 'three']) assert.equal((await comment('hello-world', { body: b })).status, 201);
  assert.equal((await comment('hello-world', { body: 'four' })).status, 429);
  assert.equal((await comment('hello-world', { body: 'four', guest: G2 })).status, 429);   // same IP, new cookie
  env.DB.sqlite.exec('UPDATE comments SET ts = ts - 600000');
  assert.equal((await comment('hello-world', { body: 'five' }, { ip: '198.51.100.1' })).status, 201);
  assert.equal((await comment('hello-world', { body: 'five' }, { ip: '198.51.100.2' })).status, 409);
  env.DB.sqlite.prepare('INSERT INTO blocks (ip, ts) VALUES (?, ?)').run('192.0.2.9', Date.now());
  const b = await comment('hello-world', { body: 'hi' }, { ip: '192.0.2.9' });
  assert.equal(b.status, 403);
  assert.equal((await call('POST', '/posts/hello-world/like', { ip: '192.0.2.9', body: { guest: G2, like: true } })).status, 403);
});

test('deleting: your own comment yes, someone else\'s no, the owner any', async () => {
  const a = (await comment('hello-world', { body: 'mine' })).data.comment;
  const b = (await comment('hello-world', { body: 'theirs', guest: G2, name: 'Bob' }, { ip: '198.51.100.3' })).data.comment;
  assert.equal((await call('POST', `/posts/hello-world/comments/${b.id}/delete`, { body: { guest: G1 } })).status, 403);
  assert.equal((await call('POST', `/posts/hello-world/comments/${b.id}/delete`, { body: { guest: G1 }, token: BAD })).status, 403);
  assert.equal((await call('POST', `/posts/hello-world/comments/${a.id}/delete`, { body: { guest: G1 } })).status, 200);
  assert.equal((await call('POST', `/posts/hello-world/comments/${b.id}/delete`, { body: {}, token: GOOD })).status, 200);
  assert.equal(rows('SELECT COUNT(*) n FROM comments')[0].n, 0);
  assert.equal((await call('POST', `/posts/hello-world/comments/${a.id}/delete`, { body: { guest: G1 } })).status, 404);
});

test('likes: one per guest, toggles, counted per post', async () => {
  const like = (guest, on, opts = {}) => call('POST', '/posts/hello-world/like', { ...opts, body: { guest, like: on } });
  assert.deepEqual((await like(G1, true)).data, { likes: 1, liked: true });
  assert.deepEqual((await like(G1, true)).data, { likes: 1, liked: true });   // twice = still one
  assert.deepEqual((await like(G2, true)).data, { likes: 2, liked: true });
  assert.deepEqual((await like(G1, false)).data, { likes: 1, liked: false });
  assert.equal((await like('x', true)).status, 400);
  assert.equal((await call('POST', '/posts/nope/like', { body: { guest: G1, like: true } })).status, 404);
  const g = await call('GET', `/posts/hello-world?g=${G2}`);
  assert.equal(g.data.likes, 1);
  assert.equal(g.data.liked, true);
  await comment('hello-world', { body: 'hi' });
  const c = await call('GET', '/counts?posts=hello-world,second-post,bad%20slug');
  assert.deepEqual(c.data, { 'hello-world': { comments: 1, likes: 1 }, 'second-post': { comments: 0, likes: 0 } });
});

test('the owner (signed in to /admin) comments as the owner, without guest limits', async () => {
  const r = await comment('hello-world', { name: 'tobi', body: 'Thanks for reading!', guest: undefined, t: 0 }, { token: GOOD });
  assert.equal(r.status, 201);
  assert.equal(r.data.comment.owner, true);
  assert.equal(r.data.comment.name, 'tobi');
  const expired = await comment('hello-world', { name: 'tobi', body: 'I am the owner' }, { token: BAD });
  assert.equal(expired.status, 401);   // a token GitHub no longer accepts
  assert.match(expired.data.error, /sign-in has expired/);
  assert.equal((await comment('hello-world', { name: 'tobi', body: 'I am the owner' })).status, 400);   // guests can't use the owner's name
});

test('admin: needs a GitHub token that can write to the repo; checked once, then remembered', async () => {
  assert.equal((await call('GET', '/admin/stats')).status, 401);
  assert.equal((await call('GET', '/admin/stats', { token: 'hello' })).status, 401);
  assert.equal(github, 0);   // not even asked: doesn't look like a GitHub token
  assert.equal((await call('GET', '/admin/stats', { token: BAD })).status, 401);
  assert.equal((await call('GET', '/admin/stats', { token: READER })).status, 401);   // a real token, but its user can't push
  assert.equal((await call('GET', '/admin/me', { token: FINE })).status, 200);         // no permissions field: the write check decides
  assert.equal((await call('GET', '/admin/me', { token: GOOD })).status, 200);
  const asked = github;
  await call('GET', '/admin/stats', { token: GOOD }); await call('GET', '/admin/visits', { token: GOOD });
  assert.equal(github, asked);
  const stored = rows('SELECT hash FROM admin_tokens');
  assert.equal(stored.length, 2);   // GOOD and FINE
  assert.ok(stored.every((r) => /^[0-9a-f]{64}$/.test(r.hash) && !r.hash.includes('AAAA')), 'only a hash of the token is kept');
});

test('admin analytics: totals, daily series, top lists, visitors with IP + location', async () => {
  await call('POST', '/hit', { body: { path: '/', guest: G1, ref: 'https://t.co/abc' } });
  await call('POST', '/hit', { body: { path: '/posts/hello-world/', title: 'Hello', guest: G1 } });
  await call('POST', '/hit', { ip: '198.51.100.20', ua: WIN_CHROME, cf: { country: 'US', region: 'California', city: 'San Jose', asOrganization: 'Comcast' }, body: { path: '/posts/hello-world/', guest: G2 } });
  await call('POST', '/hit', { ip: '198.51.100.21', ua: 'curl/8.0', cf: {}, body: { path: '/' } });   // a bot
  await comment('hello-world', { body: 'hi' });
  await call('POST', '/posts/hello-world/like', { body: { guest: G2, like: true } });

  const s = (await call('GET', '/admin/stats?days=7&tzo=330', { token: GOOD })).data;
  assert.equal(s.views, 3);
  assert.equal(s.visitors, 2);
  assert.equal(s.live, 2);
  assert.equal(s.bots, 1);
  assert.equal(s.comments, 1);
  assert.equal(s.likes, 1);
  assert.equal(s.series.length, 1);
  assert.match(s.series[0].b, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(s.pages[0], { path: '/posts/hello-world/', title: 'Hello', views: 2, visitors: 2 });
  assert.deepEqual(s.countries.map((c) => c.country).sort(), ['IN', 'US']);
  assert.deepEqual(s.cities.map((c) => c.city).sort(), ['Mumbai', 'San Jose']);
  assert.deepEqual(s.referrers, [{ ref_host: 't.co', views: 1, visitors: 1 }]);
  assert.deepEqual(s.devices.map((d) => d.device).sort(), ['Desktop', 'Mobile']);
  const hourly = (await call('GET', '/admin/stats?days=1', { token: GOOD })).data.series;
  assert.equal(hourly[0].b, Math.floor(Date.now() / 3600e3));   // by UTC hour; the page labels it in local time

  const v = (await call('GET', '/admin/visits?limit=10', { token: GOOD })).data.visits;
  assert.equal(v.length, 3);                                   // bots hidden
  assert.equal(v[0].ip, '198.51.100.20');
  assert.equal(v[0].city, 'San Jose');
  assert.equal(v[2].name, 'Alice');                            // the name they commented with
  assert.equal((await call('GET', '/admin/visits?bots=1', { token: GOOD })).data.visits.length, 4);
  assert.equal((await call('GET', `/admin/visits?guest=${G2}`, { token: GOOD })).data.visits.length, 1);
  assert.equal((await call('GET', `/admin/visits?before=${v[1].id}`, { token: GOOD })).data.visits.length, 1);

  const who = (await call('GET', '/admin/visitors?days=30', { token: GOOD })).data.visitors;
  assert.equal(who.length, 2);
  const alice = who.find((w) => w.guest === G1);
  assert.deepEqual([alice.views, alice.pages, alice.name, alice.comments, alice.likes, alice.ip, alice.city], [2, 2, 'Alice', 1, 0, '203.0.113.7', 'Mumbai']);
  assert.equal(who.find((w) => w.guest === G2).likes, 1);
});

test('admin moderation: list comments with IPs, delete, block (and remove) an IP, unblock', async () => {
  await comment('hello-world', { body: 'spam 1' }, { ip: '192.0.2.50' });
  await comment('hello-world', { body: 'spam 2', guest: G2 }, { ip: '192.0.2.50' });
  const ok = (await comment('hello-world', { body: 'nice post' }, { ip: '198.51.100.9' })).data.comment;
  const list = (await call('GET', '/admin/comments', { token: GOOD })).data;
  assert.equal(list.total, 3);
  assert.equal(list.comments[0].ip, '198.51.100.9');
  assert.equal(list.comments[0].city, 'Mumbai');
  const b = await call('POST', '/admin/blocks', { token: GOOD, body: { ip: '192.0.2.50', note: 'spam', purge: true } });
  assert.deepEqual(b.data, { ok: true, removedComments: 2 });
  assert.equal((await call('POST', '/admin/blocks', { token: GOOD, body: { ip: 'not an ip!' } })).status, 400);
  const blocks = (await call('GET', '/admin/blocks', { token: GOOD })).data.blocks;
  assert.deepEqual(blocks.map((x) => [x.ip, x.note]), [['192.0.2.50', 'spam']]);
  assert.equal((await comment('hello-world', { body: 'again' }, { ip: '192.0.2.50' })).status, 403);
  await call('POST', '/admin/blocks/delete', { token: GOOD, body: { ip: '192.0.2.50' } });
  assert.equal((await comment('hello-world', { body: 'again' }, { ip: '192.0.2.50' })).status, 201);
  assert.equal((await call('POST', `/admin/comments/${ok.id}/delete`, { token: GOOD })).status, 200);
  assert.equal((await call('POST', '/admin/blocks', { body: { ip: '1.2.3.4' } })).status, 401);   // not signed in
  assert.deepEqual(rows('SELECT body FROM comments').map((r) => r.body), ['again']);
});

test('daily clean-up: old visits go; old replies and likes lose their IP and location', async () => {
  await call('POST', '/hit', { body: { path: '/' } });
  await comment('hello-world', { body: 'old' });
  await call('POST', '/posts/hello-world/like', { body: { guest: G1, like: true } });
  env.DB.sqlite.exec('UPDATE visits SET ts = ts - 91 * 86400000; UPDATE comments SET ts = ts - 91 * 86400000; UPDATE likes SET ts = ts - 91 * 86400000');
  await call('POST', '/hit', { body: { path: '/new' } });
  await comment('hello-world', { body: 'new' }, { ip: '198.51.100.77' });
  await worker.scheduled({}, env);
  assert.deepEqual(rows('SELECT path FROM visits').map((r) => r.path), ['/new']);
  assert.deepEqual(rows('SELECT body, ip, country, region, city FROM comments ORDER BY id').map((r) => Object.values(r)),
    [['old', null, null, null, null], ['new', '198.51.100.77', 'IN', 'Maharashtra', 'Mumbai']]);
  assert.deepEqual(rows('SELECT guest, ip FROM likes').map((r) => [r.guest, r.ip]), [[G1, null]]);   // the like itself stays
});

test('a post with more than 500 replies shows the newest 500 (and says how many there are)', async () => {
  await call('GET', '/health');
  const ins = env.DB.sqlite.prepare("INSERT INTO comments (post, name, body, ts) VALUES ('hello-world', 'x', ?, ?)");
  for (let i = 1; i <= 505; i++) ins.run(`reply ${i}`, 1e12 + i);
  const d = (await call('GET', '/posts/hello-world')).data;
  assert.equal(d.total, 505);
  assert.equal(d.comments.length, 500);
  assert.deepEqual([d.comments[0].body, d.comments[499].body], ['reply 6', 'reply 505']);
  assert.match(d.form, /^\d{13}\.[\w-]{43}$/);
});

test('likes and deletes are capped in short bursts per IP', async () => {
  let last;
  for (let i = 0; i < 31; i++) last = await call('POST', '/posts/hello-world/like', { ip: '198.51.100.99', body: { guest: G2, like: i % 2 === 0 } });
  assert.equal(last.status, 429);
  assert.equal((await call('POST', '/posts/hello-world/like', { ip: '198.51.100.98', body: { guest: G2, like: true } })).status, 200);   // other IPs aren't affected
});

test('daily chart: days follow the admin\'s clock across a daylight-saving change', async () => {
  const d0 = new Date(Date.now() - 3 * 864e5), T = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate(), 23);   // 23:00 UTC, 3 days ago
  await call('GET', '/health');
  const ins = env.DB.sqlite.prepare("INSERT INTO visits (ts, path, guest, bot) VALUES (?, '/', ?, 0)");
  ins.run(T - 600e3, G1);   // 22:50 UTC: local 22:50 (UTC+0 until T)
  ins.run(T + 600e3, G2);   // 23:10 UTC: local 00:10 the next day (UTC+1 from T)
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const one = (await call('GET', '/admin/stats?days=7&tzo=0', { token: GOOD })).data.series;
  assert.deepEqual(one.map((r) => [r.b, r.views]), [[day(T), 2]]);
  const two = (await call('GET', `/admin/stats?days=7&tz=${T - 30 * 864e5}:0,${T}:60`, { token: GOOD })).data.series;
  assert.deepEqual(two.map((r) => [r.b, r.views]), [[day(T), 1], [day(T + 864e5), 1]]);
  assert.equal((await call('GET', '/admin/stats?days=7&tz=1;DROP TABLE visits:0', { token: GOOD })).status, 200);   // junk is ignored
  assert.equal(rows('SELECT COUNT(*) n FROM visits')[0].n, 2);
});
