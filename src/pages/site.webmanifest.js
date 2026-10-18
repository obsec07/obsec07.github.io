// The web app manifest: name and icons when someone adds the site to their home screen.
import { SITE } from '../config';

export function GET() {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return new Response(JSON.stringify({
    name: SITE.title, short_name: SITE.handle, description: SITE.description,
    start_url: `${base}/`, scope: `${base}/`, display: 'standalone', background_color: '#faf6f1', theme_color: '#faf6f1',
    icons: [
      { src: `${base}/icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${base}/icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${base}/favicon.svg`, sizes: 'any', type: 'image/svg+xml' },
    ],
  }, null, 2), { headers: { 'content-type': 'application/manifest+json' } });
}
