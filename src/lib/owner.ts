// Owner stats for the static site's hover card, author card and profile page.
// Trophies are earned from published posts and points are their sum. Messages and Reaction score start from what the
// build knows (posts, no reactions); with the comments API the page adds your replies and the likes you received
// (Base.astro, from /site-stats). A number typed in /admin → Profile replaces the automatic one.
import { publishedPosts } from './posts';
import { OWNER_PROFILE, SETTINGS } from '../config';
import type { StatKey } from './settings';

const TROPHIES = [
  { at: 1, points: 1, title: 'First post', desc: 'Published a first post.' },
  { at: 10, points: 2, title: 'Getting started', desc: 'Ten posts published.' },
  { at: 30, points: 5, title: 'Regular', desc: 'Thirty posts published.' },
  { at: 100, points: 10, title: 'Veteran', desc: 'A hundred posts published.' },
];

export const num = (n: number) => n.toLocaleString('en-US');
export const fmtDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export async function ownerStats() {
  // same order as every other list on the site (newest first, same tie-break), reversed to oldest first here
  const newest = await publishedPosts();
  const posts = [...newest].reverse();
  // newest trophy first, dated by the post that earned it
  const trophies = TROPHIES.filter((t) => posts.length >= t.at)
    .map((t) => ({ ...t, date: posts[t.at - 1].data.date }))
    .reverse();
  const auto = { messages: posts.length, reactions: OWNER_PROFILE.reactions, points: trophies.reduce((n, t) => n + t.points, 0) };
  const fixed = (k: StatKey) => (SETTINGS.stats[k] === '' ? null : Number(SETTINGS.stats[k]));
  return {
    posts: newest,                          // newest first
    messages: fixed('messages') ?? auto.messages,
    reactions: fixed('reactions') ?? auto.reactions,
    points: fixed('points') ?? auto.points,
    live: { messages: fixed('messages') === null, reactions: fixed('reactions') === null },
    trophies,
    latest: newest[0] ?? null,
    joined: fmtDate(new Date(OWNER_PROFILE.joined)),
  };
}

// attributes for a Messages / Reaction score number: an automatic one is topped up live on the page
export const statAttrs = (s: Awaited<ReturnType<typeof ownerStats>>, k: 'messages' | 'reactions') =>
  s.live[k] ? { 'data-ostat': k, 'data-base': String(s[k]) } : {};
