import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// `site` is the public URL used for RSS + sitemap links. Set SITE_URL (e.g. https://tobi.sh);
// on Render it falls back to the service URL automatically. The Node server always serves from the root, so base stays '/'.
export default defineConfig({
  site: process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4331',
  base: '/',
  trailingSlash: 'ignore',
  integrations: [sitemap()],
  markdown: {
    shikiConfig: { theme: 'github-light', wrap: true },
  },
});
