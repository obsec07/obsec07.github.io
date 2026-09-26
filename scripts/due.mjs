// Hourly check for scheduled posts (pages.yml, on: schedule). Deploys only when a post's publishAt has passed and the
// live site doesn't have it yet, so the hourly run is a no-op the rest of the time. Pushes and manual runs always
// deploy and don't use this. Output (GITHUB_OUTPUT): run=true|false.
// Env: SITE_URL (the live blog), POSTS_DIR (default src/content/posts).
import { readdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.POSTS_DIR || 'src/content/posts', now = Date.now();
const output = (k, v) => (process.env.GITHUB_OUTPUT ? appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`) : console.log(`${k}=${v}`));

const due = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path.join(dir, f), 'utf8'));
  if (!fm) continue;
  const at = /^publishAt:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(fm[1]);
  if (at && !/^draft:\s*true\s*$/m.test(fm[1]) && Date.parse(at[1]) <= now) due.push(f.replace(/\.md$/, ''));
}

let run = false;
if (due.length) {
  try {
    const r = await fetch(new URL('search-index.json', String(process.env.SITE_URL).replace(/\/*$/, '/')), { signal: AbortSignal.timeout(20e3), headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) throw new Error(`search-index.json: ${r.status}`);
    const live = new Set((await r.json()).map((p) => String(p.url).replace(/\/+$/, '').split('/').pop()));
    const waiting = due.filter((s) => !live.has(s));
    run = waiting.length > 0;
    console.log(run ? `Due now: ${waiting.join(', ')}. Deploying.` : 'Every scheduled post that is due is already live.');
  } catch (e) {
    run = true;   // can't tell: deploy (harmless) rather than leave a post unpublished
    console.log(`Couldn't read the live site (${e.message}); deploying to be safe.`);
  }
} else console.log('No scheduled post is due.');
output('run', String(run));
