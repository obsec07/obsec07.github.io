// security.txt (RFC 9116): where to report a vulnerability in this site. Expires a year after each build; the site is
// rebuilt on every change, so it stays current while the blog is in use.
import { SITE } from '../../config';

export function GET(context) {
  const site = new URL(import.meta.env.BASE_URL, context.site);
  const repo = process.env.GITHUB_REPOSITORY || 'obsec07/obsec07.github.io';
  const lines = [
    `# How to report a security problem in ${site.host}. Please read the policy first.`,
    ...(SITE.email ? [`Contact: mailto:${SITE.email}`] : []),
    `Contact: https://github.com/${repo}/security/advisories/new`,
    `Expires: ${new Date(Date.now() + 365 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z')}`,
    'Preferred-Languages: en',
    `Canonical: ${new URL('.well-known/security.txt', site).href}`,
    `Policy: ${new URL('security/', site).href}`,
    '',
  ];
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
