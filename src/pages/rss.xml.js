import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { isLive, summary } from '../lib/posts';
import { SITE } from '../config';

export async function GET(context) {
  const posts = (await getCollection('posts', isLive))
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
  return rss({
    title: SITE.title,
    description: SITE.description,
    site: new URL(import.meta.env.BASE_URL, context.site).href,
    items: posts.map((p) => ({
      title: p.data.title,
      description: summary(p, 300),
      pubDate: p.data.date,
      categories: [p.data.category, ...p.data.tags],
      link: `${import.meta.env.BASE_URL.replace(/\/$/, '')}/posts/${p.id}/`,
    })),
  });
}
