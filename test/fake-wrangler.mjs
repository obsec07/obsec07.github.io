// Stands in for `wrangler deploy` in test/deploy.test.js: records the config it was given, or fails on request.
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[process.argv.indexOf('--config') + 1];
if (process.env.FAKE_WRANGLER_FAIL) { console.error('fake wrangler: deploy failed'); process.exit(1); }
writeFileSync(process.env.FAKE_WRANGLER_LOG, readFileSync(file, 'utf8'));
