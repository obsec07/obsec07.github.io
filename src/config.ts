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

// ---- Static-only build (GitHub Pages): built with PUBLIC_STATIC_SITE=true ----
// There's no server behind it, so accounts, comments, likes, member pages and uploaded avatars are left out.
export const STATIC_SITE = import.meta.env.PUBLIC_STATIC_SITE === 'true';
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
// the server's per-user photo, or the default silhouette on the static site
export const avatarUrl = (name: string) => (STATIC_SITE ? `${BASE}/avatar.svg` : `/avatar/${encodeURIComponent(name)}`);
// hover-card / member-page hook; only the server renders the cards it opens
export const profileAttrs = (name: string) => (STATIC_SITE ? {} : { 'data-uprofile': name });

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
