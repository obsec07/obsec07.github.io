import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Categories mirror the 0x90.sh sections.
export const CATEGORIES = ['0day', 'ctf', 'infosec', 'tools'] as const;

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    category: z.enum(CATEGORIES),
    description: z.string().default(''),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
