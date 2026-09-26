// Deploys the comments / likes / visitor-stats API (a Cloudflare Worker + D1 database) and hands its URL to the site
// build. Run by .github/workflows/pages.yml before every build:
//   - no CLOUDFLARE_API_TOKEN secret: does nothing; the site builds without comments, likes and stats
//   - otherwise: finds the Cloudflare account and its workers.dev subdomain (registers one if the account has none),
//     and redeploys only when the API's code or settings changed (the running version is asked first).
//     The D1 database is created on the first deploy; its tables are created by the Worker itself.
// Outputs (GITHUB_OUTPUT): url = the API's address, or empty; state = off | ok | error.
// If an update fails, or Cloudflare can't be reached, the version already running stays in use (its address is read
// from the live site if need be), so the site keeps its comments.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const env = process.env;
const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(HERE, '..');
const CF = (env.CF_API || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
const NAME = 'secblog-api', DB_NAME = 'secblog';
const URL_TEMPLATE = env.WORKERS_DEV_URL || 'https://{name}.{sub}.workers.dev';   // tests point this at a local server
const WRANGLER = env.WRANGLER_CMD || 'npx --yes wrangler@4';
const token = env.CLOUDFLARE_API_TOKEN;

const output = (k, v) => (env.GITHUB_OUTPUT ? appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`) : console.log(`${k}=${v}`));
const summary = (md) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cloudflare API call; timeouts, 5xx and 429 are retried twice (2s, then 4s later)
async function cf(p, init = {}) {
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(CF + p, { ...init, signal: AbortSignal.timeout(20e3), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
      if (r.status < 500 && r.status !== 429) break;
      if (attempt >= 2) break;
    } catch (e) { if (attempt >= 2) throw new Error(`Couldn't reach Cloudflare (${e.message}).`); }
    await sleep((Number(env.RETRY_MS) || 2000) * 2 ** attempt);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const why = (j.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw Object.assign(new Error(`Cloudflare said ${r.status} to ${init.method || 'GET'} ${p.replace(/\/accounts\/[^/]+/, '/accounts/…')}${why ? ` (${why})` : ''}`), { status: r.status, codes: (j.errors || []).map((e) => e.code) });
  }
  return j.result;
}
// the API address the live site is using right now (<body data-api="…">), for when Cloudflare can't tell us
async function liveUrl() {
  try {
    const html = await (await fetch(env.SITE_URL, { signal: AbortSignal.timeout(15e3), headers: { 'cache-control': 'no-cache' } })).text();
    const m = /<body[^>]*\sdata-api="(https?:\/\/[^"]+)"/.exec(html);
    return m ? m[1] : '';
  } catch { return ''; }
}
async function health(url) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10e3), headers: { 'cache-control': 'no-cache' } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function account() {
  if (env.CLOUDFLARE_ACCOUNT_ID) return env.CLOUDFLARE_ACCOUNT_ID;
  const list = await cf('/accounts?per_page=50');
  if (!list || !list.length) throw new Error("The Cloudflare token can't see any account. Create it from the \"Edit Cloudflare Workers\" template.");
  if (list.length > 1) console.log(`::warning::The token can reach ${list.length} Cloudflare accounts; using "${list[0].name}". Set the CLOUDFLARE_ACCOUNT_ID secret to pick another.`);
  return list[0].id;
}
// every account needs a <name>.workers.dev subdomain before it can run Workers; new accounts don't have one yet
async function subdomain(acc) {
  try { const r = await cf(`/accounts/${acc}/workers/subdomain`); if (r && r.subdomain) return r.subdomain; } catch (e) { if (e.status !== 404 && !(e.codes || []).includes(10007)) throw e; }
  const owner = String(env.GITHUB_REPOSITORY_OWNER || 'blog').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'blog';
  for (const name of [owner, `${owner}-blog`, `${owner}-${randomBytes(3).toString('hex')}`]) {
    try { const r = await cf(`/accounts/${acc}/workers/subdomain`, { method: 'PUT', body: JSON.stringify({ subdomain: name }) }); console.log(`Registered ${name}.workers.dev`); return r.subdomain || name; }
    catch (e) { console.log(`${name}.workers.dev: ${e.message}`); }
  }
  throw new Error('Could not register a workers.dev subdomain. Open Cloudflare → Workers & Pages once to pick one, then run this again.');
}
async function database(acc) {
  const found = ((await cf(`/accounts/${acc}/d1/database?name=${DB_NAME}&per_page=100`)) || []).find((d) => d.name === DB_NAME);
  if (found) return found.uuid;
  const made = await cf(`/accounts/${acc}/d1/database`, { method: 'POST', body: JSON.stringify({ name: DB_NAME }) });
  console.log(`Created the D1 database "${DB_NAME}".`);
  return made.uuid;
}

async function main() {
  if (!token) {
    console.log('::notice::Comments, likes and visitor stats are off: no CLOUDFLARE_API_TOKEN secret. Add it under Settings → Secrets and variables → Actions → Repository secrets (README → Comments, likes & visitor stats).');
    output('url', ''); output('state', 'off');
    return;
  }
  const toml = readFileSync(path.join(HERE, 'wrangler.toml'), 'utf8');
  const settings = JSON.parse(readFileSync(path.join(ROOT, 'src/data/settings.json'), 'utf8'));
  const vars = {
    SITE_URL: String(env.SITE_URL || '').replace(/\/+$/, ''),
    ALLOWED_ORIGINS: '',
    GITHUB_REPO: env.GITHUB_REPOSITORY || '',
    OWNER_NAME: String(settings.handle || ''),
    RETENTION_DAYS: '90',
  };
  const version = createHash('sha256').update(readFileSync(path.join(HERE, 'src/index.js'))).update(toml).update(JSON.stringify(vars)).digest('hex').slice(0, 12);

  let url = '', running = null;
  try {
    if (!vars.SITE_URL) throw new Error('SITE_URL is missing (the blog\'s address, from actions/configure-pages).');
    const acc = await account();
    url = URL_TEMPLATE.replace('{name}', NAME).replace('{sub}', await subdomain(acc));
    running = await health(url);
    if (running && running.version === version) {
      console.log(`The API at ${url} is up to date (${version}).`);
      output('url', url); output('state', 'ok');
      return;
    }
    console.log(running ? `Updating the API (${running.version} -> ${version})…` : `Deploying the API to ${url}…`);
    const dbId = await database(acc);
    const config = {
      name: NAME, main: 'src/index.js', workers_dev: true,
      compatibility_date: (/compatibility_date\s*=\s*"([^"]+)"/.exec(toml) || [])[1],
      d1_databases: [{ binding: 'DB', database_name: DB_NAME, database_id: dbId }],
      triggers: { crons: [(/crons\s*=\s*\["([^"]+)"\]/.exec(toml) || [])[1] || '17 3 * * *'] },
      vars: { ...vars, API_VERSION: version },
    };
    const file = path.join(HERE, 'wrangler.deploy.json');
    writeFileSync(file, JSON.stringify(config, null, 2));
    const run = spawnSync(`${WRANGLER} deploy --config "${file}"`, { shell: true, stdio: 'inherit', cwd: HERE, env: { ...env, CLOUDFLARE_ACCOUNT_ID: acc } });
    rmSync(file, { force: true });
    if (run.status !== 0) throw new Error('wrangler deploy failed (see above). Does the token have Workers Scripts: Edit and D1: Edit?');
    // a brand-new workers.dev address can take a little while to answer
    for (let i = 0; i < 24; i++) { const h = await health(url); if (h && h.version === version) { running = h; break; } await sleep(Number(env.HEALTH_WAIT_MS) || 5000); }
    if (!running || running.version !== version) console.log(`::warning::Deployed, but ${url} isn't answering yet. It usually does within a few minutes.`);
    console.log(`The API is live at ${url}`);
    summary(`**Comments & stats API:** ${url} (version ${version})`);
    output('url', url); output('state', 'ok');
  } catch (e) {
    console.log(`::error::Comments & stats API: ${e.message}`);
    summary(`**Comments & stats API failed:** ${e.message}`);
    if (!url && vars.SITE_URL) url = await liveUrl();          // Cloudflare down before we learned the address
    const keep = url && (running || (await health(url)));   // the version already running keeps working
    if (keep) console.log(`Keeping the API that's running at ${url}.`);
    output('url', keep ? url : ''); output('state', keep ? 'ok' : 'error');
  }
}
await main();
