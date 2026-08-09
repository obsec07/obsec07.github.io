import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// EDIT THESE TWO before deploying to GitHub Pages:
//   site  = https://<your-username>.github.io   (or your custom domain)
//   base  = '/<repo-name>'  when using a project page (e.g. '/secblog').
//           Leave base '/' for a user/org page (<username>.github.io) or a custom domain.
export default defineConfig({
  site: 'https://example.github.io',
  base: '/',
  trailingSlash: 'ignore',
  integrations: [sitemap()],
  markdown: {
    shikiConfig: { theme: 'github-light', wrap: true },
  },
});
