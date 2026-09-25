import { getCollection } from 'astro:content';
import { CATEGORY_LABELS } from '../config';
import { readingMinutes } from '../lib/posts';

export async function GET() {
  const posts = (await getCollection('posts', ({ data }) => !data.draft))
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const items = posts.map((p) => ({
    title: p.data.title,
    url: (base + '/posts/' + p.id).replace(/\/{2,}/g, '/'),
    category: CATEGORY_LABELS[p.data.category] ?? p.data.category,
    key: p.data.category,             // the blog (/0day, /ctf, …); the category pages' Filters use it
    minutes: readingMinutes(p.body),
    date: p.data.date.toISOString().slice(0, 10),
    description: p.data.description,
    tags: p.data.tags,
  }));
  return new Response(JSON.stringify(items), { headers: { 'content-type': 'application/json' } });
}
