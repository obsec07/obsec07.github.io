import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Content-Security-Policy for the static build. GitHub Pages can't send response headers, so each page gets it as its
// first <meta> tag. Scripts: only this site's own files, plus that page's inline scripts by their SHA-256 hash (so an
// injected <script> or onclick=… never runs). Connections: this site, the comments API and GitHub's API (/admin).
// Styles allow inline style attributes (the theme and charts set them); pictures in posts may come from any https site.
// frame-ancestors (clickjacking) only works as a header, so /admin hides itself when framed instead.
function contentSecurityPolicy() {
  const api = (() => { try { return new URL(process.env.PUBLIC_API_URL).origin; } catch { return ''; } })();
  const policy = (hashes) => [
    "default-src 'self'",
    `script-src 'self' ${hashes.map((h) => `'sha256-${h}'`).join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' https: data: blob:",
    "media-src 'self' https: blob:",
    `connect-src 'self' https://api.github.com${api ? ` ${api}` : ''}`,
    "frame-src https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "manifest-src 'self'",
  ].join('; ');
  const htmlFiles = async (dir) => {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await htmlFiles(p)));
      else if (e.name.endsWith('.html')) out.push(p);
    }
    return out;
  };
  return {
    name: 'content-security-policy',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        if (process.env.PUBLIC_STATIC_SITE !== 'true') return;   // the Node server sends its own headers
        const files = await htmlFiles(fileURLToPath(dir));
        for (const file of files) {
          let html = await readFile(file, 'utf8');
          const hashes = new Set();
          for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
            const attrs = m[1] || '';
            if (/\ssrc\s*=/i.test(attrs)) continue;
            const type = (/\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1];
            if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) continue;   // JSON-LD isn't run
            hashes.add(createHash('sha256').update(m[2], 'utf8').digest('base64'));
          }
          const meta = `<meta http-equiv="Content-Security-Policy" content="${policy([...hashes])}">`;
          html = /<meta charset="utf-8">/i.test(html) ? html.replace(/<meta charset="utf-8">/i, (c) => c + meta) : html.replace(/<head>/i, (h) => h + meta);
          await writeFile(file, html);
        }
        logger.info(`Content-Security-Policy added to ${files.length} pages`);
      },
    },
  };
}

// `site` is the public URL used for RSS + sitemap links. Set SITE_URL (e.g. https://tobi.sh);
// on Render it falls back to the service URL automatically.
// BASE_PATH is only for the static GitHub Pages build (e.g. '/secblog' for a project page); the Node server always serves from '/'.
export default defineConfig({
  site: process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4331',
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'ignore',
  // /account and /members are empty shells the Node server fills per visitor, /admin is the CMS — nothing for search engines
  integrations: [sitemap({ filter: (page) => !/\/(account|members|admin)\/?$/.test(new URL(page).pathname) }), contentSecurityPolicy()],
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
