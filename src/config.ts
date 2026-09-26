// ---- Site config ----
// Everything here comes from src/data/settings.json, which /admin edits (Profile / Site tabs). clean() keeps the site
// building even if a value in the file is missing or invalid.
import rawSettings from './data/settings.json';
import { clean } from './lib/settings';
import { SOCIAL_NETWORKS } from './lib/socials';

export const SETTINGS = clean(rawSettings);
const S = SETTINGS;

export const SITE = {
  handle: S.handle,
  title: S.siteTitle,
  description: S.siteDescription,
  author: S.handle,
  email: S.email,
  socials: S.socials,
  banner: S.banner,
};

// Owner profile on the static site (hover card, author card, /members/<handle>). The Node server uses live account data.
export const OWNER_PROFILE = {
  role: S.role,
  joined: S.joined,
  about: S.about,
  reactions: 0,
};

// the social links that are filled in, in display order, with their icons
export const SOCIAL_LINKS = SOCIAL_NETWORKS.filter((n) => S.socials[n.key]).map((n) => ({ ...n, url: S.socials[n.key] }));
// "github.com/obsec07" style label for a link
export const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');

// ---- Static-only build (GitHub Pages): built with PUBLIC_STATIC_SITE=true ----
// There's no server behind it, so accounts, comments, likes and uploaded avatars are left out.
export const STATIC_SITE = import.meta.env.PUBLIC_STATIC_SITE === 'true';
// Guest comments, likes and visitor stats come from a small API (api/, a Cloudflare Worker). The Pages workflow sets
// its address at build time once the CLOUDFLARE_API_TOKEN secret is added; without it those features stay hidden.
// API_STATE: off (no secret) | ok | error (the deploy failed; /admin says so).
export const API_URL = STATIC_SITE ? String(import.meta.env.PUBLIC_API_URL || '').replace(/\/+$/, '') : '';
export const API_STATE = API_URL ? 'ok' : STATIC_SITE && import.meta.env.PUBLIC_API_STATE === 'error' ? 'error' : 'off';
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
// the server's per-user photo; on the static site the owner's photo (public/owner.jpg), anyone else the default silhouette
// (?v= changes when a new photo is uploaded from /admin, so nobody keeps seeing the old one from their cache)
const OWNER_PHOTO = `${BASE}/owner.jpg${S.avatarVersion ? `?v=${S.avatarVersion}` : ''}`;
export const avatarUrl = (name: string) =>
  STATIC_SITE ? (name.toLowerCase() === SITE.handle.toLowerCase() ? OWNER_PHOTO : `${BASE}/avatar.svg`) : `/avatar/${encodeURIComponent(name)}`;
// hover-card hook: the server renders cards for its members, the static site renders the owner's (Base.astro)
export const profileAttrs = (name: string) => ({ 'data-uprofile': name });
// the owner's profile page
export const profileUrl = (name: string) => `${BASE}/members/${encodeURIComponent(name.toLowerCase())}/`;

const B = S.blogs;
export const NAV = [
  { label: 'Home', href: '/' },
  {
    label: 'Forums', href: '/', caret: true,
    menu: [
      { label: B['0day'].title, href: '/0day' },
      { label: B.ctf.title, href: '/ctf' },
      { label: B.infosec.title, href: '/infosec' },
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

// anchor of a home-page section (#blogs, #tobi-releases), used by the breadcrumbs
export const sectionId = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const SECTIONS = [
  {
    title: 'Blogs',
    items: [
      { key: 'whoami', title: 'Who Am I', desc: `Who is ${S.handle}?`, href: '/whoami', page: true },
      { key: '0day', title: B['0day'].title, desc: B['0day'].description },
      { key: 'ctf', title: B.ctf.title, desc: B.ctf.description },
      { key: 'infosec', title: B.infosec.title, desc: B.infosec.description },
    ],
  },
  {
    title: `${S.handle} Releases`,
    subtitle: `${S.handle} tool & research releases.`,
    items: [
      { key: 'tools', title: B.tools.title, desc: B.tools.description },
    ],
  },
];

export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(Object.entries(B).map(([k, v]) => [k, v.title]));
export const CATEGORY_DESCRIPTIONS: Record<string, string> = Object.fromEntries(Object.entries(B).map(([k, v]) => [k, v.description]));
