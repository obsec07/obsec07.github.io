// The comments / likes / visitor-stats API (api/src/index.js), run in Node with a stand-in database (test/d1.js).
// GitHub (the admin sign-in check) and the blog's search index are faked, so nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../api/src/index.js';
import { d1 } from './d1.js';

const SITE = 'https://blog.example';
const GOOD = 'github_pat_' + 'A'.repeat(40), BAD = 'github_pat_' + 'B'.repeat(40);
const G1 = 'a'.repeat(32), G2 = 'b'.repeat(32);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MUMBAI = { country: 'IN', region: 'Maharashtra', city: 'Mumbai', latitude: '19.07', longitude: '72.87', timezone: 'Asia/Kolkata', asn: 55836, asOrganization: 'Reliance Jio' };

let env, github;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === `${SITE}/search-index.json`) return Response.json([{ url: '/posts/hello-world' }, { url: '/posts/second-post/' }]);
  if (u.startsWith('https://api.github.com/repos/me/blog/contents/')) {
    github++;
    const auth = new Headers(init.headers).get('authorization');
    return new Response('{}', { status: auth === `Bearer ${GOOD}` && init.method === 'PUT' ? 422 : 403 });
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
const comment = (slug, body, opts = {}) => call('POST', `/posts/${slug}/comments`, { ...opts, body: { guest: G1, name: 'Alice', t: 5000, ...body } });
const rows = (sql, ...a) => env.DB.sqlite.prepare(sql).all(...a);

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
});

test('page views: IP, location, device and referrer are recorded; bots are flagged', async () => {
  assert.equal((await call('POST', '/hit', { body: { path: '/posts/hello-world/?utm=x#top', ref: 'https://www.google.com/search?q=secret', title: 'Hello', guest: G1, lang: 'en-IN', screen: '390x844' } })).status, 204);
  await call('POST', '/hit', { body: { path: '/ctf/', ref: `${SITE}/`, guest: G1 } });
  await call('POST', '/hit', { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', body: { path: '/' } });
  await call('POST', '/hit', { body: { path: 'https://evil.example/' } });   // not a path: ignored
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
  await err({ body: 'hi', website: 'http://spam' }, 400, /spam/);
  await err({ body: 'hi', t: 300 }, 400, /quick/);
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
  assert.equal((await call('GET', '/admin/me', { token: GOOD })).status, 200);
  const asked = github;
  await call('GET', '/admin/stats', { token: GOOD }); await call('GET', '/admin/visits', { token: GOOD });
  assert.equal(github, asked);
  const stored = rows('SELECT hash FROM admin_tokens');
  assert.equal(stored.length, 1);
  assert.ok(!stored[0].hash.includes('AAAA'), 'only a hash of the token is kept');
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
  assert.equal((await call('GET', '/admin/stats?days=1', { token: GOOD })).data.series[0].b.length, 16);   // hourly

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

test('daily clean-up: old visits go, old comments lose their IP', async () => {
  await call('POST', '/hit', { body: { path: '/' } });
  await comment('hello-world', { body: 'old' });
  env.DB.sqlite.exec('UPDATE visits SET ts = ts - 91 * 86400000; UPDATE comments SET ts = ts - 91 * 86400000');
  await call('POST', '/hit', { body: { path: '/new' } });
  await worker.scheduled({}, env);
  assert.deepEqual(rows('SELECT path FROM visits').map((r) => r.path), ['/new']);
  assert.deepEqual(rows('SELECT body, ip FROM comments').map((r) => [r.body, r.ip]), [['old', null]]);
});
