// Shared post helpers: published posts in order, reading time, neighbours and related posts.
import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

/** Published posts, newest first. */
export async function publishedPosts(): Promise<Post[]> {
  return (await getCollection('posts', ({ data }) => !data.draft)).sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

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
