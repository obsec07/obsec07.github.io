import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// `site` is the public URL used for RSS + sitemap links. Set SITE_URL (e.g. https://tobi.sh);
// on Render it falls back to the service URL automatically.
// BASE_PATH is only for the static GitHub Pages build (e.g. '/secblog' for a project page); the Node server always serves from '/'.
export default defineConfig({
  site: process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4331',
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'ignore',
  // /account and /members are empty shells the Node server fills per visitor — nothing for search engines
  integrations: [sitemap({ filter: (page) => !/\/(account|members)\/?$/.test(new URL(page).pathname) })],
  markdown: {
    shikiConfig: { theme: 'github-light', wrap: true },
  },
});
