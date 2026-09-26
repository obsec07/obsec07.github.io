import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { CATEGORIES } from './lib/settings';

// Categories mirror the 0x90.sh sections (their titles/descriptions are in src/data/settings.json).
export { CATEGORIES };

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    category: z.enum(CATEGORIES),
    description: z.string().default(''),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    publishAt: z.coerce.date().optional(),   // scheduled: hidden until then (an hourly job in pages.yml publishes it)
    pinned: z.boolean().default(false),      // sticky: first on its blog's list
    updated: z.coerce.date().optional(),     // "Last edited", set by /admin when a published post changes
  }),
});

export const collections = { posts };
