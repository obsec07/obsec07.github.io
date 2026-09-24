// Site + profile settings (src/data/settings.json), edited from /admin → Profile / Site.
// One set of rules for both sides: the admin form checks them before saving, and the build cleans whatever is in the
// file with them (a bad or missing value falls back to the default instead of breaking the site).
import { SOCIAL_NETWORKS } from './socials';

// the blogs (post categories); their keys are the URLs (/0day, /ctf, …) so only titles/descriptions are editable
export const CATEGORIES = ['0day', 'ctf', 'infosec', 'tools'] as const;
export type Category = (typeof CATEGORIES)[number];
export type SocialKey = (typeof SOCIAL_NETWORKS)[number]['key'];

export interface Settings {
  handle: string;
  siteTitle: string;
  siteDescription: string;
  banner: string;
  email: string;
  role: string;
  joined: string;
  about: string;
  avatarVersion: string;
  socials: Record<SocialKey, string>;
  blogs: Record<Category, { title: string; description: string }>;
}

export const LIMITS = { siteTitle: 80, siteDescription: 200, banner: 200, role: 40, about: 600, blogTitle: 40, blogDescription: 160 } as const;
export const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const URL_RE = /^https?:\/\/[^\s<>"']+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

export const DEFAULTS: Settings = {
  handle: 'tobi',
  siteTitle: 'tobi // security research',
  siteDescription: 'Vulnerability research, CTF writeups, infosec notes and tool releases.',
  banner: '',
  email: '',
  role: 'Administrator',
  joined: '2026-08-06',
  about: '',
  avatarVersion: '1',
  socials: Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n.key, ''])) as Record<SocialKey, string>,
  blogs: {
    '0day': { title: '0day Blog', description: "All about my 0day findings & cve's." },
    ctf: { title: 'CTF Writeups', description: 'My CTF writeups for challenges which i considered interesting/enjoyable.' },
    infosec: { title: 'InfoSec Blog', description: 'InfoSec related Blog.' },
    tools: { title: 'Tools', description: 'InfoSec related tools.' },
  },
};

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const oneLine = (v: unknown) => str(v).replace(/\s+/g, ' ');

/** Problems with a settings object, keyed by field ("handle", "socials.github", "blogs.ctf.title", …). */
export function validate(s: any): Record<string, string> {
  const e: Record<string, string> = {};
  const len = (k: string, v: unknown, max: number, required = false) => {
    const t = str(v);
    if (required && !t) e[k] = 'Required.';
    else if (t.length > max) e[k] = `At most ${max} characters.`;
  };
  if (!HANDLE_RE.test(str(s?.handle))) e.handle = '2–32 letters, numbers, dots, dashes or underscores (start with a letter or number).';
  len('siteTitle', s?.siteTitle, LIMITS.siteTitle, true);
  len('siteDescription', s?.siteDescription, LIMITS.siteDescription);
  len('banner', s?.banner, LIMITS.banner);
  len('role', s?.role, LIMITS.role, true);
  len('about', s?.about, LIMITS.about);
  if (str(s?.email) && !EMAIL_RE.test(str(s.email))) e.email = 'Not an email address.';
  if (!isDate(str(s?.joined))) e.joined = 'Pick a date.';
  for (const n of SOCIAL_NETWORKS) {
    const v = str(s?.socials?.[n.key]);
    if (v && !URL_RE.test(v)) e[`socials.${n.key}`] = 'A full link starting with https://';
  }
  for (const c of CATEGORIES) {
    len(`blogs.${c}.title`, s?.blogs?.[c]?.title, LIMITS.blogTitle, true);
    len(`blogs.${c}.description`, s?.blogs?.[c]?.description, LIMITS.blogDescription);
  }
  return e;
}

/** A complete, safe Settings object: each invalid or missing value falls back to its default. */
export function clean(raw: any): Settings {
  const bad = validate(raw);
  const pick = <T>(k: string, v: T, d: T): T => (k in bad ? d : v);
  const out: Settings = {
    handle: pick('handle', str(raw?.handle), DEFAULTS.handle),
    siteTitle: pick('siteTitle', oneLine(raw?.siteTitle), DEFAULTS.siteTitle),
    siteDescription: pick('siteDescription', oneLine(raw?.siteDescription), DEFAULTS.siteDescription),
    banner: pick('banner', oneLine(raw?.banner), ''),
    email: pick('email', str(raw?.email), ''),
    role: pick('role', oneLine(raw?.role), DEFAULTS.role),
    joined: pick('joined', str(raw?.joined), DEFAULTS.joined),
    about: pick('about', str(raw?.about), ''),
    avatarVersion: str(raw?.avatarVersion).replace(/[^\w.-]/g, '').slice(0, 40),
    socials: { ...DEFAULTS.socials },
    blogs: structuredClone(DEFAULTS.blogs),
  };
  for (const n of SOCIAL_NETWORKS) out.socials[n.key] = pick(`socials.${n.key}`, str(raw?.socials?.[n.key]), '');
  for (const c of CATEGORIES) {
    out.blogs[c] = {
      title: pick(`blogs.${c}.title`, oneLine(raw?.blogs?.[c]?.title), DEFAULTS.blogs[c].title),
      description: pick(`blogs.${c}.description`, oneLine(raw?.blogs?.[c]?.description), DEFAULTS.blogs[c].description),
    };
  }
  return out;
}
