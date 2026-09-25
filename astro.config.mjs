import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// `site` is the public URL used for RSS + sitemap links. Set SITE_URL (e.g. https://tobi.sh);
// on Render it falls back to the service URL automatically.
// BASE_PATH is only for the static GitHub Pages build (e.g. '/secblog' for a project page); the Node server always serves from '/'.
export default defineConfig({
  site: process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4331',
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'ignore',
  // /account and /members are empty shells the Node server fills per visitor, /admin is the CMS — nothing for search engines
  integrations: [sitemap({ filter: (page) => !/\/(account|members|admin)\/?$/.test(new URL(page).pathname) })],
  markdown: {
    // long code lines scroll sideways instead of wrapping (a wrapped `charset=utf-` / `8` misreads as two lines).
    // The <code> inside each block is what scrolls (see .prose pre code), so the "Code:" bar on the <pre> stays put;
    // it also takes the keyboard focus stop, so arrow keys scroll it.
    shikiConfig: {
      themes: { light: 'github-light-default', dark: 'github-dark-default' },   // dark mode swaps to the dark palette (global.css)
      wrap: false,
      transformers: [{
        pre(node) { delete node.properties.tabindex; },
        code(node) { node.properties.tabindex = '0'; },
      }],
    },
  },
});
