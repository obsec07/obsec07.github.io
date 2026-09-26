// scripts/due.mjs: does the hourly run deploy? Only when a scheduled post is due and the live site lacks it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'due-test-'));
let live = [], server, base;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/blog/search-index.json' && live !== null) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(live.map((s) => ({ url: `/blog/posts/${s}` })))); }
    res.writeHead(500).end();
  }).listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}/blog/`;
});
after(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); });

function posts(files) {
  const dir = mkdtempSync(path.join(tmp, 'posts-'));
  for (const [name, fm] of Object.entries(files)) writeFileSync(path.join(dir, `${name}.md`), `---\n${fm}\n---\n\nbody\n`);
  return dir;
}
function due(dir) {
  const out = path.join(tmp, `out-${Math.random()}`);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/due.mjs')], { env: { PATH: process.env.PATH, POSTS_DIR: dir, SITE_URL: base, GITHUB_OUTPUT: out } });
  let log = ''; child.stdout.on('data', (d) => (log += d));
  return new Promise((resolve) => child.on('close', () => resolve({ run: existsSync(out) ? readFileSync(out, 'utf8').trim() : '', log })));
}
const past = new Date(Date.now() - 3600e3).toISOString(), future = new Date(Date.now() + 86400e3).toISOString();

test('nothing scheduled, or only in the future: no deploy', async () => {
  live = ['a'];
  assert.equal((await due(posts({ a: 'title: A\ndate: 2026-01-01' }))).run, 'run=false');
  assert.equal((await due(posts({ b: `title: B\npublishAt: '${future}'` }))).run, 'run=false');
});

test('a scheduled post that is due and not live yet: deploy; once live: no deploy', async () => {
  live = ['a'];
  const dir = posts({ a: 'title: A', b: `title: B\ndate: '2026-09-26'\npublishAt: ${past}` });
  const r = await due(dir);
  assert.equal(r.run, 'run=true');
  assert.match(r.log, /Due now: b/);
  live = ['a', 'b'];
  assert.equal((await due(dir)).run, 'run=false');
});

test('drafts never count; an unreadable live site means deploy to be safe', async () => {
  live = [];
  assert.equal((await due(posts({ d: `title: D\npublishAt: '${past}'\ndraft: true` }))).run, 'run=false');
  live = null;
  assert.equal((await due(posts({ e: `title: E\npublishAt: '${past}'` }))).run, 'run=true');
});
