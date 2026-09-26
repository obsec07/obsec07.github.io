// Shared post helpers: published posts in order, reading time, neighbours and related posts.
import { getCollection, type CollectionEntry } from 'astro:content';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type Post = CollectionEntry<'posts'>;

// the moment this build started: scheduled posts whose time hasn't come are left out of it
const BUILT = Date.now();
/** On the site: not a draft, and not scheduled for later. */
export const isLive = ({ data }: { data: Post['data'] }) => !data.draft && !(data.publishAt && data.publishAt.getTime() > BUILT);

/** Published posts, newest first. */
export async function publishedPosts(): Promise<Post[]> {
  return (await getCollection('posts', isLive)).sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

/** A blog's list order: pinned (sticky) posts first, then newest first. */
export const pinnedFirst = (posts: Post[]) => [...posts].sort((a, b) => Number(b.data.pinned) - Number(a.data.pinned) || b.data.date.valueOf() - a.data.date.valueOf());

/** Rough reading time at ~200 words a minute (code counts as words too; it reads slower anyway). */
export const readingMinutes = (body = '') => Math.max(1, Math.round(body.split(/\s+/).filter(Boolean).length / 200));

/** The post before (older) and after (newer) this one. */
export function neighbours(all: Post[], id: string) {
  const i = all.findIndex((p) => p.id === id);
  return { newer: i > 0 ? all[i - 1] : null, older: i >= 0 && i < all.length - 1 ? all[i + 1] : null };
}

/** Up to `n` other posts that share tags (2 points each) or the blog (1 point), best match first, then newest. */
export function related(all: Post[], post: Post, n = 3): Post[] {
  const tags = new Set(post.data.tags.map((t) => t.toLowerCase()));
  return all
    .filter((p) => p.id !== post.id)
    .map((p) => ({ p, score: p.data.tags.filter((t) => tags.has(t.toLowerCase())).length * 2 + (p.data.category === post.data.category ? 1 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.p.data.date.valueOf() - a.p.data.date.valueOf())
    .slice(0, n)
    .map((x) => x.p);
}

/** Tag page address. */
export const tagHref = (base: string, tag: string) => `${base}/tags/${encodeURIComponent(tag)}/`;

// a post's text outside code blocks; inline code kept as its text (keep = false: dropped, for the picture search)
const prose = (body = '', keep = true) =>
  body.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm, '').replace(/`([^`\n]*)`/g, keep ? '$1' : '');

/** A plain-text summary for search engines and link previews: the description, else the start of the post. */
export function summary(post: Post, max = 160): string {
  if (post.data.description.trim()) return post.data.description.trim();
  const text = prose(post.body)
    .replace(/<[^>]*>/g, ' ')                                  // HTML tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')                     // pictures
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                    // links: their text
    .split(/\n\s*\n/)                                           // blocks; a heading ends with a full stop
    .map((b) => b.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '').replace(/[*_~|#>]+/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((b) => (/[.!?:]$/.test(b) ? b : b + '.'))
    .join(' ');
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6)).replace(/[\s,;:.-]+$/, '') + '…';
}

/** The post's first picture outside code, for link previews: a web address, or a file of this site that exists. */
export function firstImage(post: Post): string | undefined {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const re = /!\[[^\]]*\]\(\s*<?([^\s)>]+)|<img\b[^>]*?\bsrc=["']([^"']+)/gi;
  for (const m of prose(post.body, false).matchAll(re)) {
    const u = m[1] || m[2];
    if (/^https:\/\//i.test(u)) return u;
    if (!u.startsWith('/') || u.startsWith('//')) continue;
    const local = decodeURI(u.split(/[?#]/)[0]).slice(base && u.startsWith(base + '/') ? base.length : 0);
    if (!local.includes('..') && existsSync(path.join(process.cwd(), 'public', local))) return u;
  }
  return undefined;
}
