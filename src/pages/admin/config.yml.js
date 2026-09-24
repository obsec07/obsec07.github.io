// Sveltia CMS config for /admin. Generated at build time so the repo name and URL paths follow the deployment:
// GitHub Actions sets GITHUB_REPOSITORY (it tracks a repo rename); other builds fall back to this repo.
// Fields mirror the `posts` schema in src/content.config.ts.
import { CATEGORIES } from '../../content.config';

export function GET(context) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const repo = process.env.GITHUB_REPOSITORY || 'obsec07/secblog';
  const yml = `backend:
  name: github
  repo: ${repo}
  branch: main
site_url: ${new URL(import.meta.env.BASE_URL, context.site).href}
media_folder: public/images
public_folder: ${base}/images
collections:
  - name: posts
    label: Posts
    label_singular: Post
    folder: src/content/posts
    extension: md
    format: frontmatter
    create: true
    slug: '{{slug}}'
    sortable_fields: [date, title, category]
    fields:
      - { name: title, label: Title, widget: string }
      - { name: date, label: Date, widget: datetime, time_format: false, format: 'YYYY-MM-DD' }
      - { name: category, label: Category, widget: select, options: [${CATEGORIES.map((c) => `'${c}'`).join(', ')}] }
      - { name: description, label: Description, widget: string, required: false, hint: 'One-liner shown on the post list' }
      - { name: tags, label: Tags, widget: list, required: false }
      - { name: draft, label: Draft, widget: boolean, default: false, required: false, hint: 'Drafts are saved but not published' }
      - { name: body, label: Body, widget: markdown }
`;
  return new Response(yml, { headers: { 'content-type': 'application/yaml' } });
}
