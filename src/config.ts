// ---- Site config ----
export const SITE = {
  handle: 'tobi',
  title: 'tobi // security research',
  description: 'Vulnerability research, CTF writeups, infosec notes and tool releases.',
  author: 'tobi',
  role: 'New member',
  email: 'you@example.com',
  socials: {
    twitter: 'https://twitter.com/your-handle',
    github: 'https://github.com/your-username',
  },
  banner: '',
};

// Owner profile on the static site (hover card, author card, /members/<handle>). The Node server uses live account data.
export const OWNER_PROFILE = {
  role: 'Administrator',
  joined: '2026-08-06',
  about: "Security researcher. I hunt for bugs in web apps, play CTFs and write up the interesting ones here.",
  reactions: 0,
};

// ---- Static-only build (GitHub Pages): built with PUBLIC_STATIC_SITE=true ----
// There's no server behind it, so accounts, comments, likes and uploaded avatars are left out.
export const STATIC_SITE = import.meta.env.PUBLIC_STATIC_SITE === 'true';
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
// the server's per-user photo; on the static site the owner is the cat, anyone else the default silhouette
export const avatarUrl = (name: string) =>
  STATIC_SITE ? `${BASE}/${name.toLowerCase() === SITE.handle.toLowerCase() ? 'cat' : 'avatar'}.svg` : `/avatar/${encodeURIComponent(name)}`;
// hover-card hook: the server renders cards for its members, the static site renders the owner's (Base.astro)
export const profileAttrs = (name: string) => ({ 'data-uprofile': name });
// the owner's profile page
export const profileUrl = (name: string) => `${BASE}/members/${encodeURIComponent(name.toLowerCase())}/`;

export const NAV = [
  { label: 'Home', href: '/' },
  {
    label: 'Forums', href: '/', caret: true,
    menu: [
      { label: '0day Blog', href: '/0day' },
      { label: 'CTF Writeups', href: '/ctf' },
      { label: 'InfoSec Blog', href: '/infosec' },
      { label: 'Releases', href: '/tools' },
      { label: 'Who Am I', href: '/whoami' },
    ],
  },
  {
    label: "What's new", href: '/whats-new', caret: true,
    menu: [
      { label: 'New posts', href: '/whats-new' },
      { label: 'Search forums', href: '/search' },
    ],
  },
];

// Account dropdown (image #4)
export const ACCOUNT_MENU = [
  { label: 'News feed', href: '/whats-new' },
  { label: 'Reactions received', href: '/account' },
  { label: 'Your content', href: '/whats-new' },
  { label: 'Account details', href: '/account' },
  { label: 'Preferences', href: '/account' },
  { label: 'Password and security', href: '/account' },
  { label: 'Following', href: '/account' },
  { label: 'Privacy', href: '/account' },
  { label: 'Ignoring', href: '/account' },
];

export const SECTIONS = [
  {
    title: 'Blogs',
    items: [
      { key: 'whoami', title: 'Who Am I', desc: 'Who is tobi?', href: '/whoami', page: true },
      { key: '0day',   title: '0day Blog',    desc: "All about my 0day findings & cve's." },
      { key: 'ctf',    title: 'CTF Writeups', desc: 'My CTF writeups for challenges which i considered interesting/enjoyable.' },
      { key: 'infosec',title: 'InfoSec Blog', desc: 'InfoSec related Blog.' },
    ],
  },
  {
    title: 'tobi Releases',
    subtitle: 'tobi tool & research releases.',
    items: [
      { key: 'tools', title: 'Tools', desc: 'InfoSec related tools.' },
    ],
  },
];

export const CATEGORY_LABELS: Record<string, string> = {
  '0day': '0day Blog',
  ctf: 'CTF Writeups',
  infosec: 'InfoSec Blog',
  tools: 'Tools',
};
