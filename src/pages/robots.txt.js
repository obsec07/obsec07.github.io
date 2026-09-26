// robots.txt: everything but the admin panel and the account page, and where the sitemap is
export function GET(context) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const body = [
    'User-agent: *',
    `Disallow: ${base}/admin`,
    `Disallow: ${base}/account`,
    '',
    `Sitemap: ${new URL(`${base}/sitemap-index.xml`, context.site).href}`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
