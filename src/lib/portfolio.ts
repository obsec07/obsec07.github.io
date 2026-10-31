// Portfolio (src/data/portfolio.json): the intro, achievements, skills and resume at the top of the home page.
// Edited from /admin → Portfolio. Like settings.ts, one set of rules for both sides: the admin form checks them before
// saving and the build cleans whatever is in the file with them (a bad entry is dropped, never breaks the site).

export const ACHIEVEMENT_KINDS = [
  { key: 'bounty', label: 'Bug bounty' },
  { key: 'hof', label: 'Hall of Fame' },
  { key: 'cert', label: 'Certification' },
  { key: 'cve', label: 'CVE' },
  { key: 'ctf', label: 'CTF' },
  { key: 'award', label: 'Award' },
  { key: 'other', label: 'Other' },
] as const;
export type AchievementKind = (typeof ACHIEVEMENT_KINDS)[number]['key'];

export interface Achievement {
  kind: AchievementKind;
  title: string;
  org: string;      // who gave it: NASA, a program, the certifying body…
  date: string;     // YYYY-MM or YYYY-MM-DD, or '' when it doesn't matter
  amount: string;   // a bounty in US dollars (digits), or ''
  link: string;     // https://… or a page on this site (/posts/…), or ''
  detail: string;
}
export interface SkillGroup { group: string; items: string[] }
export interface Job { role: string; org: string; from: string; to: string; detail: string }

export interface Portfolio {
  name: string;
  headline: string;
  roles: string[];        // typed one after another under the name
  intro: string;
  location: string;
  status: string;         // "Open to opportunities"; '' hides the badge
  achievements: Achievement[];
  skills: SkillGroup[];
  experience: Job[];
  github: string;         // GitHub user whose public repositories show as projects; '' hides them
  resume: { version: string; updated: string };   // version '' = no resume uploaded (public/resume.pdf)
}

export const LIMITS = { name: 60, headline: 120, role: 40, roles: 6, intro: 600, location: 60, status: 60, title: 100, org: 60, detail: 300, achievements: 40, group: 30, skill: 40, skills: 12, jobs: 12 } as const;
export const RESUME_FILE = 'public/resume.pdf';
export const RESUME_MAX = 5e6;

const KIND_KEYS = new Set<string>(ACHIEVEMENT_KINDS.map((k) => k.key));
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;
const LINK_RE = /^(https?:\/\/[^\s<>"']+|\/[^\s<>"']*)$/i;
const GH_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const oneLine = (v: unknown) => str(v).replace(/\s+/g, ' ');
const list = (v: unknown) => (Array.isArray(v) ? v : []);

export const DEFAULTS: Portfolio = {
  name: '', headline: '', roles: [], intro: '', location: '', status: '',
  achievements: [], skills: [], experience: [], github: '', resume: { version: '', updated: '' },
};

/** Problems, keyed by field ("name", "achievements.2.title", …). */
export function validate(p: any): Record<string, string> {
  const e: Record<string, string> = {};
  const len = (k: string, v: unknown, max: number, required = false) => {
    const t = str(v);
    if (required && !t) e[k] = 'Required.';
    else if (t.length > max) e[k] = `At most ${max} characters.`;
  };
  len('name', p?.name, LIMITS.name);
  len('headline', p?.headline, LIMITS.headline);
  len('intro', p?.intro, LIMITS.intro);
  len('location', p?.location, LIMITS.location);
  len('status', p?.status, LIMITS.status);
  const roles = list(p?.roles).map(str).filter(Boolean);
  if (roles.length > LIMITS.roles) e.roles = `At most ${LIMITS.roles} lines.`;
  else if (roles.some((r) => r.length > LIMITS.role)) e.roles = `Each line at most ${LIMITS.role} characters.`;
  if (str(p?.github) && !GH_RE.test(str(p.github))) e.github = 'A GitHub username (letters, numbers, dashes).';
  const ach = list(p?.achievements);
  if (ach.length > LIMITS.achievements) e.achievements = `At most ${LIMITS.achievements}.`;
  ach.forEach((a: any, i: number) => {
    const k = `achievements.${i}`;
    if (!KIND_KEYS.has(str(a?.kind))) e[`${k}.kind`] = 'Pick a kind.';
    len(`${k}.title`, a?.title, LIMITS.title, true);
    len(`${k}.org`, a?.org, LIMITS.org);
    len(`${k}.detail`, a?.detail, LIMITS.detail);
    if (str(a?.date) && !MONTH_RE.test(str(a.date))) e[`${k}.date`] = 'YYYY-MM, or empty.';
    if (str(a?.amount) && !/^\d{1,9}$/.test(str(a.amount).replace(/[$,\s]/g, ''))) e[`${k}.amount`] = 'Whole dollars, or empty.';
    if (str(a?.link) && !LINK_RE.test(str(a.link))) e[`${k}.link`] = 'https://… or /posts/…';
  });
  const skills = list(p?.skills);
  if (skills.length > LIMITS.skills) e.skills = `At most ${LIMITS.skills} groups.`;
  skills.forEach((g: any, i: number) => {
    len(`skills.${i}.group`, g?.group, LIMITS.group, true);
    if (list(g?.items).some((s: unknown) => str(s).length > LIMITS.skill)) e[`skills.${i}.items`] = `Each skill at most ${LIMITS.skill} characters.`;
  });
  const jobs = list(p?.experience);
  if (jobs.length > LIMITS.jobs) e.experience = `At most ${LIMITS.jobs}.`;
  jobs.forEach((j: any, i: number) => {
    len(`experience.${i}.role`, j?.role, LIMITS.title, true);
    len(`experience.${i}.org`, j?.org, LIMITS.org);
    len(`experience.${i}.detail`, j?.detail, LIMITS.detail);
    if (str(j?.from) && !MONTH_RE.test(str(j.from))) e[`experience.${i}.from`] = 'YYYY-MM, or empty.';
    if (str(j?.to) && !MONTH_RE.test(str(j.to))) e[`experience.${i}.to`] = 'YYYY-MM, or empty for "now".';
  });
  return e;
}

/** A complete, safe Portfolio: invalid fields fall back to empty, invalid list entries are dropped. */
export function clean(raw: any): Portfolio {
  const bad = validate(raw);
  const ok = (k: string) => !(k in bad);
  const badEntry = (prefix: string) => Object.keys(bad).some((k) => k.startsWith(prefix + '.'));
  const pick = (k: string, v: string) => (ok(k) ? v : '');
  return {
    name: pick('name', oneLine(raw?.name)),
    headline: pick('headline', oneLine(raw?.headline)),
    roles: ok('roles') ? list(raw?.roles).map(oneLine).filter(Boolean) : [],
    intro: pick('intro', str(raw?.intro)),
    location: pick('location', oneLine(raw?.location)),
    status: pick('status', oneLine(raw?.status)),
    github: pick('github', str(raw?.github)),
    achievements: list(raw?.achievements).slice(0, LIMITS.achievements).flatMap((a: any, i: number) => badEntry(`achievements.${i}`) ? [] : [{
      kind: str(a.kind) as AchievementKind, title: oneLine(a.title), org: oneLine(a.org), date: str(a.date),
      amount: str(a.amount).replace(/[$,\s]/g, '').replace(/^0+(?=\d)/, ''), link: str(a.link), detail: str(a.detail),
    }]),
    skills: list(raw?.skills).slice(0, LIMITS.skills).flatMap((g: any, i: number) => badEntry(`skills.${i}`) ? [] : [{
      group: oneLine(g.group), items: list(g.items).map(oneLine).filter(Boolean),
    }]),
    experience: list(raw?.experience).slice(0, LIMITS.jobs).flatMap((j: any, i: number) => badEntry(`experience.${i}`) ? [] : [{
      role: oneLine(j.role), org: oneLine(j.org), from: str(j.from), to: str(j.to), detail: str(j.detail),
    }]),
    resume: { version: str(raw?.resume?.version).replace(/[^\w.-]/g, '').slice(0, 40), updated: /^\d{4}-\d{2}-\d{2}$/.test(str(raw?.resume?.updated)) ? str(raw.resume.updated) : '' },
  };
}

/** "Aug 2026" from "2026-08" / "2026-08-29"; '' stays ''. */
export function fmtMonth(d: string) {
  if (!d) return '';
  const [y, m] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
