// Owner stats for the static site's hover card, author card and profile page.
// There are no reactions on a static site, so trophies are earned from published posts and points are their sum.
import { publishedPosts } from './posts';
import { OWNER_PROFILE } from '../config';

const TROPHIES = [
  { at: 1, points: 1, title: 'First post', desc: 'Published a first post.' },
  { at: 10, points: 2, title: 'Getting started', desc: 'Ten posts published.' },
  { at: 30, points: 5, title: 'Regular', desc: 'Thirty posts published.' },
  { at: 100, points: 10, title: 'Veteran', desc: 'A hundred posts published.' },
];

export const fmtDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export async function ownerStats() {
  // same order as every other list on the site (newest first, same tie-break), reversed to oldest first here
  const newest = await publishedPosts();
  const posts = [...newest].reverse();
  // newest trophy first, dated by the post that earned it
  const trophies = TROPHIES.filter((t) => posts.length >= t.at)
    .map((t) => ({ ...t, date: posts[t.at - 1].data.date }))
    .reverse();
  return {
    posts: newest,                          // newest first
    messages: posts.length,
    reactions: OWNER_PROFILE.reactions,
    points: trophies.reduce((n, t) => n + t.points, 0),
    trophies,
    latest: newest[0] ?? null,
    joined: fmtDate(new Date(OWNER_PROFILE.joined)),
  };
}
