// api/deploy.mjs against a fake Cloudflare API and a fake `wrangler`, so nothing leaves the machine.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'deploy-test-'));
const LOG = path.join(tmp, 'wrangler.json');
let cf, server, base;

before(async () => {
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const ok = (result) => send(200, { success: true, result });
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    cf.calls.push(`${req.method} ${p}`);
    if (req.headers.authorization !== 'Bearer cf-token' && p.startsWith('/client/')) return send(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
    if (p === '/client/v4/accounts') return ok([{ id: 'acc1', name: 'Me' }]);
    if (p === '/client/v4/accounts/acc1/workers/subdomain') {
      if (req.method === 'PUT') { const s = JSON.parse(body).subdomain; if (cf.taken.includes(s)) return send(409, { success: false, errors: [{ code: 10036, message: 'taken' }] }); cf.sub = s; return ok({ subdomain: s }); }
      return cf.sub ? ok({ subdomain: cf.sub }) : send(404, { success: false, errors: [{ code: 10007, message: 'not found' }] });
    }
    if (p === '/client/v4/accounts/acc1/d1/database' && req.method === 'GET') return ok(cf.db ? [{ name: 'secblog', uuid: cf.db }] : []);
    if (p === '/client/v4/accounts/acc1/d1/database' && req.method === 'POST') { cf.db = 'db-uuid-1'; return ok({ uuid: cf.db, name: JSON.parse(body).name }); }
    const w = /^\/w\/secblog-api\/([^/]+)\/health$/.exec(p);
    if (w) {
      const live = existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')).vars.API_VERSION : cf.running;
      return live && w[1] === cf.sub ? send(200, { ok: true, version: live }) : send(404, {});
    }
    send(404, { success: false, errors: [{ code: 7003, message: `no route ${p}` }] });
  }).listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => { cf = { calls: [], sub: null, db: null, running: null, taken: [] }; rmSync(LOG, { force: true }); });

function deploy(extra = {}) {
  const out = path.join(tmp, `out-${Math.random()}`);
  const child = spawn(process.execPath, [path.join(ROOT, 'api/deploy.mjs')], {
    env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: 'cf-token', CF_API: `${base}/client/v4`, WORKERS_DEV_URL: `${base}/w/{name}/{sub}`,
      WRANGLER_CMD: `"${process.execPath}" "${path.join(ROOT, 'test/fake-wrangler.mjs')}"`, FAKE_WRANGLER_LOG: LOG, HEALTH_WAIT_MS: '20',
      GITHUB_OUTPUT: out, GITHUB_REPOSITORY: 'obsec07/obsec07.github.io', GITHUB_REPOSITORY_OWNER: 'Obsec07', SITE_URL: 'https://obsec07.github.io/', ...extra },
  });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  return new Promise((resolve) => child.on('close', (code) => {
    const outputs = existsSync(out) ? Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))) : {};
    resolve({ code, log, outputs });
  }));
}

test('without the Cloudflare secret it does nothing and the site builds without the API', async () => {
  const r = await deploy({ CLOUDFLARE_API_TOKEN: '' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { url: '', state: 'off' });
  assert.equal(cf.calls.length, 0);
  assert.match(r.log, /CLOUDFLARE_API_TOKEN/);
});

test('first deploy: registers a workers.dev name, creates the database, deploys with the site\'s settings', async () => {
  cf.taken = ['obsec07'];
  const r = await deploy();
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(r.outputs, { url: `${base}/w/secblog-api/obsec07-blog`, state: 'ok' });
  const cfg = JSON.parse(readFileSync(LOG, 'utf8'));
  assert.equal(cfg.d1_databases[0].database_id, 'db-uuid-1');
  assert.equal(cfg.main, 'src/index.js');
  assert.match(cfg.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(cfg.vars.SITE_URL, 'https://obsec07.github.io');
  assert.equal(cfg.vars.GITHUB_REPO, 'obsec07/obsec07.github.io');
  assert.equal(cfg.vars.OWNER_NAME, JSON.parse(readFileSync(path.join(ROOT, 'src/data/settings.json'), 'utf8')).handle);
  assert.match(cfg.vars.API_VERSION, /^[0-9a-f]{12}$/);
  assert.ok(!existsSync(path.join(ROOT, 'api/wrangler.deploy.json')), 'the generated config is removed');

  // next build: nothing changed, so no redeploy
  cf.calls = [];
  const again = await deploy();
  assert.deepEqual(again.outputs, { url: `${base}/w/secblog-api/obsec07-blog`, state: 'ok' });
  assert.ok(!cf.calls.some((c) => c.includes('/d1/') || c.startsWith('PUT')), cf.calls.join('\n'));
  assert.match(again.log, /up to date/);
});

test('a failed update keeps the version already running', async () => {
  cf.sub = 'obsec07'; cf.db = 'db-old'; cf.running = 'oldversion00';
  const r = await deploy({ FAKE_WRANGLER_FAIL: '1' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { url: `${base}/w/secblog-api/obsec07`, state: 'ok' });
  assert.match(r.log, /::error::.*wrangler deploy failed/);
});

test('a failed first deploy leaves the API off and says why', async () => {
  cf.sub = 'obsec07';
  const r = await deploy({ FAKE_WRANGLER_FAIL: '1' });
  assert.deepEqual(r.outputs, { url: '', state: 'error' });
  const bad = await deploy({ CLOUDFLARE_API_TOKEN: 'wrong' });
  assert.deepEqual(bad.outputs, { url: '', state: 'error' });
  assert.match(bad.log, /::error::.*403.*Authentication error/);
});
