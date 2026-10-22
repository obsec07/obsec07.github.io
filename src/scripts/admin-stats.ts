// /admin → Analytics and Comments tabs: visitor stats, visitors with IP address + location, and reply moderation,
// from the comments API (api/). Every request carries the GitHub token /admin signed in with; the API checks it.
// All text from the API (names, replies, page titles, referrers) goes in with textContent, never as HTML.

type Opts = { api: string; token: () => string | null; handle: string; base: string };
type Row = Record<string, any>;

const DAY = 864e5;
const regionName = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
export const flag = (cc?: string | null) => (cc && /^[A-Z]{2}$/.test(cc) && cc !== 'XX' && cc !== 'T1' ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🌐');
export const country = (cc?: string | null) => (!cc || cc === 'XX' ? 'Unknown' : cc === 'T1' ? 'Tor network' : (regionName && regionName.of(cc)) || cc);
const place = (r: Row) => [r.city, r.region && r.region !== r.city ? r.region : null, country(r.country)].filter(Boolean).join(', ');
const num = (n: number) => (n ?? 0).toLocaleString('en-US');
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function ago(ts: number) {
  const s = (ts - Date.now()) / 1000, a = Math.abs(s);
  if (a < 45) return 'just now';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 30 * 86400) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
const when = (ts: number) => new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

// tiny DOM builder: h('div', { class: 'x' }, 'text', child…); strings become text nodes
function h(tag: string, attrs: Row | null = null, ...kids: any[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'dataset') Object.assign(e.dataset, v); else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
const svg = (tag: string, attrs: Row = {}) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };

export function initStats(o: Opts) {
  const $ = (id: string) => document.getElementById(id)!;
  let onlyReported = false, days = 7, visitsCursor = 0, commentsCursor = 0;
  let titles: Record<string, string> | null = null;

  async function api(path: string, body?: object) {
    const token = o.token();
    const r = await fetch(o.api + path, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 ? 'The stats server didn\'t accept your sign-in. Log out and log in again.' : data.error || `The stats server answered ${r.status}.`);
    return data;
  }
  const fail = (box: string, x: unknown) => { const e = $(box); e.textContent = (x as Error).message || "Couldn't reach the stats server. Check your connection and press Refresh."; e.hidden = false; };
  async function postTitles() {
    if (titles) return titles;
    try { const list = await (await fetch(`${o.base}/search-index.json`, { cache: 'no-store' })).json(); titles = Object.fromEntries(list.map((p: Row) => [String(p.url).replace(/\/+$/, '').split('/').pop(), p.title])); }
    catch { titles = {}; }
    return titles!;
  }
  // Each list is loaded by the newest request only: a tab switch, Refresh or Block while one is running used to
  // append the same rows twice. fresh loads bump the counter; "Show more" checks it didn't move meanwhile.
  const seq = { stats: 0, visitors: 0, visits: 0, comments: 0, posts: 0 };
  // the admin's UTC offset for each stretch of [from, to] ("start:offset,…"), so a daylight-saving change mid-range
  // doesn't shift the days before it
  function tzSegments(from: number, to: number) {
    const off = (t: number) => -new Date(t).getTimezoneOffset();
    const segs: [number, number][] = [[from, off(from)]];
    for (let t = from + 3600e3; t <= to + 3600e3; t += 3600e3) {
      const cur = segs[segs.length - 1][1];
      if (off(t) === cur) continue;
      let lo = t - 3600e3, hi = t;   // narrow it down to the minute
      while (hi - lo > 60e3) { const mid = lo + Math.floor((hi - lo) / 120e3) * 60e3; if (off(mid) === cur) lo = mid; else hi = mid; }
      segs.push([hi, off(hi)]);
    }
    return segs.map(([t, o]) => `${Math.round(t)}:${o}`).join(',');
  }
  const cleanTitle = (t: string | null, path: string) => (t ? t.replace(new RegExp(`\\s·\\s${o.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '') : path);

  // ---------- filters: click a country, city, page, source or device and every number below follows ----------
  // Each chip is one filter (kind: what was clicked); a newer chip of the same kind replaces the old one.
  type Chip = { kind: string; label: string; params: Record<string, string> };
  let chips: Chip[] = [];
  const params = () => Object.assign({}, ...chips.map((c) => c.params)) as Record<string, string>;
  const KINDS: Record<string, string> = { country: 'country', city: 'place', path: 'page', source: 'came from', device: 'device', model: 'model', browser: 'browser', os: 'system', visitor: 'visitor' };
  function addFilter(c: Chip) {
    // a city in another country than the country chip: the country chip goes (they'd never match together)
    chips = chips.filter((x) => x.kind !== c.kind && !(c.kind === 'city' && x.kind === 'country' && x.params.country !== c.params.country)
      && !(c.kind === 'country' && x.kind === 'city' && x.params.country !== c.params.country));
    chips.push(c); filtersChanged();
    $('st-pane').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function removeFilter(kind?: string) { chips = kind ? chips.filter((x) => x.kind !== kind) : []; filtersChanged(); }
  function renderChips() {
    $('st-chips').replaceChildren(...(chips.length ? [
      h('span', { class: 'st-chips-label' }, 'Showing only:'),
      ...chips.map((c) => h('button', { type: 'button', class: 'st-chip', title: `Remove this filter (${KINDS[c.kind] || c.kind})`, onclick: () => removeFilter(c.kind) }, c.label, h('span', { 'aria-hidden': 'true' }, ' ×'))),
      ...(chips.length > 1 ? [h('button', { type: 'button', class: 'st-chip st-chip-clear', onclick: () => removeFilter() }, 'Clear all')] : []),
    ] : [h('span', { class: 'st-chips-label' }, 'Tip: tap any country, city, page, source or device to see only those visitors.')]));
  }
  function filtersChanged() { renderChips(); loadStats(); loadPostStats(); loadVisitors(true); loadVisits(true); }
  // the query for the API: period, the admin's time zone (for the daily chart) and the filters
  const query = (extra: Record<string, string> = {}) => new URLSearchParams({ days: String(days), ...params(), ...extra }).toString();
  const placeName = (r: Row) => [r.city, r.region && r.region !== r.city ? r.region : null].filter(Boolean).join(', ') || 'Unknown place';
  const chipFor = {
    country: (r: Row): Chip => ({ kind: 'country', label: `${flag(r.country)} ${country(r.country)}`, params: { country: r.country || '-' } }),
    city: (r: Row): Chip => ({ kind: 'city', label: `${flag(r.country)} ${placeName(r)}`, params: { country: r.country || '-', region: r.region || '-', city: r.city || '-' } }),
    page: (r: Row): Chip => ({ kind: 'path', label: `Page: ${cleanTitle(r.title, r.path)}`, params: { path: r.path } }),
    source: (r: Row): Chip => ({ kind: 'source', label: r.source ? `From ${r.source}` : 'Direct visits', params: { source: r.source || '-' } }),
    model: (r: Row): Chip => ({ kind: 'model', label: r.model || 'Unknown model', params: { model: r.model || '-' } }),
    device: (r: Row): Chip => ({ kind: 'device', label: r.device || 'Unknown device', params: { device: r.device || '-' } }),
    browser: (r: Row): Chip => ({ kind: 'browser', label: r.browser || 'Unknown browser', params: { browser: r.browser || '-' } }),
    os: (r: Row): Chip => ({ kind: 'os', label: r.os || 'Unknown system', params: { os: r.os || '-' } }),
    visitor: (v: Row): Chip => ({ kind: 'visitor', label: `Visitor: ${who(v)}`, params: visitorKey(v) }),
  };
  // a visitor is an IP address and the device on it: the phone model when the browser reports one, else its system
  const deviceName = (v: Row) => v.model || [v.os, v.device].filter(Boolean).join(' ') || 'Unknown device';
  const who = (v: Row) => `${deviceName(v)} · ${v.ip || 'no IP'}`;
  const visitorKey = (v: Row): Record<string, string> => ({ ip: v.ip || '-', model: v.model || '-', ...(v.model ? {} : { os: v.os || '-' }) });
  const isOnline = (ts: number) => Date.now() - ts < 5 * 60e3;

  // ---------- overview ----------
  async function loadStats() {
    const body = $('st-body'), my = ++seq.stats; body.classList.add('st-loading'); $('st-err').hidden = true;
    try {
      const s = await api(`/admin/stats?${query({ tz: tzSegments(Date.now() - (days + 1) * DAY, Date.now()) })}`);
      if (my !== seq.stats) return;
      renderKpis(s); renderChart(s); renderTops(s); renderMap(s.places || []);
      $('st-bots').textContent = s.bots ? `${num(s.bots)} visit${s.bots === 1 ? '' : 's'} by bots and crawlers left out.` : '';
    } catch (x) { if (my === seq.stats) fail('st-err', x); }
    finally { if (my === seq.stats) body.classList.remove('st-loading'); }
  }
  function renderKpis(s: Row) {
    const per = days === 1 ? 'last 24 hours' : `last ${days} days`;
    const tile = (label: string, value: number, note: string, id = '', onclick: ((e: Event) => void) | null = null) =>
      h(onclick ? 'button' : 'div', { class: `st-kpi${onclick ? ' st-kpi-btn' : ''}`, type: onclick ? 'button' : null, onclick },
        h('div', { class: 'st-kpi-label' }, label), h('div', { class: 'st-kpi-value', id: id || null }, num(value)), h('div', { class: 'st-kpi-note' }, note));
    $('st-kpis').replaceChildren(
      tile('Visitors', s.visitors, per), tile('Page views', s.views, per),
      tile('Online now', s.live, 'tap to see who', 'st-live', () => { setWho('online'); $('st-visitors-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); }),
      tile('Replies', s.comments, per), tile('Likes', s.likes, per),
    );
  }

  // views + visitors over time: two lines on one axis (same unit), crosshair tooltip, table view
  let lastSeries: { key: string; label: string; views: number; visitors: number }[] = [];
  function buckets(s: Row) {
    const byKey = new Map((s.series as Row[]).map((r) => [String(r.b), r]));
    const pad = (n: number) => String(n).padStart(2, '0');
    const out = [];
    if (days === 1) {   // the API counts by UTC hour; each is labelled in local time here
      for (let hr = Math.floor((Date.now() - DAY) / 3600e3); hr <= Math.floor(Date.now() / 3600e3); hr++) {
        const r = byKey.get(String(hr)) || {};
        out.push({ key: String(hr), label: `${pad(new Date(hr * 3600e3).getHours())}:00`, views: r.views || 0, visitors: r.visitors || 0 });
      }
      return out;
    }
    const t = new Date(Date.now() - days * DAY); t.setHours(0, 0, 0, 0);
    for (; t.getTime() <= Date.now(); t.setDate(t.getDate() + 1)) {   // local days (the API used the same offsets)
      const key = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`, r = byKey.get(key) || {};
      out.push({ key, label: t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), views: r.views || 0, visitors: r.visitors || 0 });
    }
    return out;
  }
  // y-axis step: 1, 2 or 5 × 10ⁿ (whole numbers: these are counts), about 4 gridlines
  function niceStep(v: number) {
    const raw = v / 4, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
    return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p);
  }
  function renderChart(s: Row) {
    lastSeries = buckets(s);
    drawChart();
    const rows = lastSeries.map((b) => h('tr', null, h('td', null, b.label), h('td', null, num(b.visitors)), h('td', null, num(b.views))));
    $('st-table').replaceChildren(h('thead', null, h('tr', null, h('th', null, days === 1 ? 'Hour' : 'Day'), h('th', null, 'Visitors'), h('th', null, 'Page views'))), h('tbody', null, rows));
  }
  function drawChart() {
    const box = $('st-chart'), data = lastSeries;
    const W = Math.max(280, box.clientWidth || 600), H = 220, L = 40, R = 64, T = 12, B = 28;
    const pw = W - L - R, ph = H - T - B;
    const top = Math.max(1, ...data.map((d) => Math.max(d.views, d.visitors))), step = niceStep(top), max = step * Math.ceil(top / step);
    const x = (i: number) => L + (data.length === 1 ? pw / 2 : (i * pw) / (data.length - 1)), y = (v: number) => T + ph - (v / max) * ph;
    const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Visitors and page views, ${days === 1 ? 'hourly' : 'daily'}. Use the arrow keys to read values.`, tabindex: 0, class: 'st-svg' });
    for (let v = 0; v <= max; v += step) {
      g.append(svg('line', { x1: L, x2: L + pw, y1: y(v), y2: y(v), class: 'st-gl' }));
      const t = svg('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'st-tick' }); t.textContent = num(v); g.append(t);
    }
    // x labels: every n-th point so they fit (~70px each), always the last one, none crowding it
    const last = data.length - 1, every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(pw / 70))));
    data.forEach((d, i) => {
      if (i !== last && (i % every !== 0 || last - i < every * 0.6)) return;
      const t = svg('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 && last > 0 ? 'start' : i === last && last > 0 ? 'end' : 'middle', class: 'st-tick' }); t.textContent = d.label; g.append(t);
    });
    const series = [{ k: 'views', label: 'Page views', cls: 's2' }, { k: 'visitors', label: 'Visitors', cls: 's1' }] as const;
    for (const s of series) g.append(svg('path', { d: data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[s.k]).toFixed(1)}`).join(''), class: `st-line ${s.cls}` }));
    // end dots + direct labels (dropped when they'd collide; the legend and tooltip still name them)
    const ends = series.map((s) => ({ ...s, v: data[last][s.k], yy: y(data[last][s.k]) }));
    for (const e of ends) g.append(svg('circle', { cx: x(last), cy: e.yy, r: 4, class: `st-dot ${e.cls}` }));
    if (Math.abs(ends[0].yy - ends[1].yy) >= 16) for (const e of ends) { const t = svg('text', { x: x(last) + 9, y: e.yy + 4, class: 'st-end' }); t.textContent = num(e.v); g.append(t); }
    // hover / keyboard: crosshair snaps to the nearest point, one tooltip lists both series
    const cross = svg('line', { y1: T, y2: T + ph, class: 'st-cross', visibility: 'hidden' });
    const hov = series.map((s) => svg('circle', { r: 4, class: `st-dot ${s.cls}`, visibility: 'hidden' }));
    g.append(cross, ...hov);
    const hit = svg('rect', { x: L, y: 0, width: pw, height: H, fill: 'transparent' }); g.append(hit);
    const tip = $('st-tip');
    let at = -1;
    function show(i: number) {
      at = Math.max(0, Math.min(last, i));
      const d = data[at], cx = x(at);
      cross.setAttribute('x1', String(cx)); cross.setAttribute('x2', String(cx)); cross.setAttribute('visibility', 'visible');
      series.forEach((s, j) => { hov[j].setAttribute('cx', String(cx)); hov[j].setAttribute('cy', String(y(d[s.k]))); hov[j].setAttribute('visibility', 'visible'); });
      tip.replaceChildren(h('div', { class: 'st-tip-h' }, d.label), ...[...series].reverse().map((s) => h('div', { class: 'st-tip-r' }, h('span', { class: `st-key ${s.cls}` }), h('b', null, num(d[s.k])), ' ', s.label.toLowerCase())));
      tip.hidden = false;
      const left = (cx / W) * box.clientWidth;
      tip.style.left = `${Math.min(Math.max(left, 70), box.clientWidth - 70)}px`;
    }
    function hide() { at = -1; cross.setAttribute('visibility', 'hidden'); hov.forEach((c) => c.setAttribute('visibility', 'hidden')); tip.hidden = true; }
    const nearest = (ev: PointerEvent) => { const r = g.getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * W; return data.length === 1 ? 0 : Math.round(((px - L) / pw) * last); };
    g.addEventListener('pointermove', (ev) => show(nearest(ev)));
    g.addEventListener('pointerdown', (ev) => show(nearest(ev)));
    g.addEventListener('pointerleave', hide);
    g.addEventListener('blur', hide);
    g.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); show(at < 0 ? last : at + (ev.key === 'ArrowRight' ? 1 : -1)); }
      if (ev.key === 'Escape') hide();
    });
    box.replaceChildren(g);
  }
  let resizeT = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = window.setTimeout(() => { if (lastSeries.length && !$('st-chart').closest('[hidden]')) drawChart(); }, 150); });

  // ---------- top lists: one bar per row, one colour (magnitude); the whole row is a button that filters ----------
  const SHOW = 8;   // rows before "Show all"
  function bars(id: string, rows: Row[], o2: { label: (r: Row) => (Node | string)[]; value?: (r: Row) => number; chip?: (r: Row) => Chip; open?: (r: Row) => string | null; empty?: string; unit?: string }) {
    const value = o2.value || ((r: Row) => r.visitors), max = Math.max(1, ...rows.map(value)), unit = o2.unit || 'visitors';
    const box = $(id);
    if (!rows.length) { box.replaceChildren(h('p', { class: 'st-empty' }, o2.empty || 'Nothing yet.')); return; }
    const active = new Set(chips.map((c) => JSON.stringify(c.params)));
    const li = (r: Row, i: number) => {
      const c = o2.chip ? o2.chip(r) : null, on = c && active.has(JSON.stringify(c.params));
      const inner = [h('span', { class: 'st-bar-top' }, h('span', { class: 'st-bar-label' }, ...o2.label(r)), h('span', { class: 'st-bar-n' }, num(value(r)))),
        h('span', { class: 'st-bar-track' }, h('span', { class: 'st-bar', style: `width:${Math.max(2, (value(r) / max) * 100)}%` }))];
      const title = `${num(r.visitors)} visitor${r.visitors === 1 ? '' : 's'} · ${num(r.views)} page view${r.views === 1 ? '' : 's'}${c && !on ? ' · tap to see only these' : ''}`;
      const href = o2.open ? o2.open(r) : null;
      return h('li', { class: i >= SHOW ? 'st-more-row' : null, hidden: i >= SHOW },
        c ? h('button', { type: 'button', class: `st-row${on ? ' on' : ''}`, title, 'aria-pressed': on ? 'true' : 'false', onclick: () => (on ? removeFilter(c.kind) : addFilter(c)) }, ...inner)
          : h('div', { class: 'st-row', title }, ...inner),
        href ? h('a', { class: 'st-open', href, target: '_blank', rel: 'noopener', title: 'Open the page', 'aria-label': 'Open the page' }, '↗') : null);
    };
    const list = h('ol', { class: 'st-bars' }, rows.map(li));
    const more = rows.length > SHOW ? h('button', { type: 'button', class: 'st-link', onclick: (e: Event) => {
      const open = list.classList.toggle('st-all');
      list.querySelectorAll<HTMLElement>('.st-more-row').forEach((x) => { x.hidden = !open; });
      (e.currentTarget as HTMLElement).textContent = open ? 'Show fewer' : `Show all ${rows.length}`;
    } }, `Show all ${rows.length}`) : null;
    box.replaceChildren(h('div', { class: 'st-list-head' }, h('span', null, ''), h('span', { class: 'st-unit' }, unit)), list, more || '');
  }
  const sitePath = (path: string) => { try { const u = new URL(path, location.origin); return u.origin === location.origin ? u.pathname : null; } catch { return null; } };
  function renderTops(s: Row) {
    bars('st-pages', s.pages, { label: (r) => [cleanTitle(r.title, r.path), h('span', { class: 'st-sub' }, r.path)], value: (r) => r.views, unit: 'page views', chip: chipFor.page, open: (r) => sitePath(r.path) });
    bars('st-refs', s.sources || [], { label: (r) => [r.source || 'Direct or unknown', r.source ? null : h('span', { class: 'st-sub' }, 'typed in, a bookmark, or an app that hides it')], chip: chipFor.source, empty: 'No visits yet.' });
    bars('st-models', s.models || [], { label: (r) => [r.model || 'Unknown', r.model ? null : h('span', { class: 'st-sub' }, 'iPhones and some browsers keep it private')], chip: chipFor.model });
    bars('st-countries', s.countries, { label: (r) => [`${flag(r.country)} ${country(r.country)}`], chip: chipFor.country });
    bars('st-cities', s.cities, { label: (r) => [`${flag(r.country)} ${placeName(r)}`, h('span', { class: 'st-sub' }, country(r.country))], chip: chipFor.city });
    bars('st-devices', s.devices, { label: (r) => [r.device || 'Unknown'], chip: chipFor.device });
    bars('st-browsers', s.browsers, { label: (r) => [r.browser || 'Unknown'], chip: chipFor.browser });
    bars('st-os', s.os, { label: (r) => [r.os || 'Unknown'], chip: chipFor.os });
  }

  // ---------- the map: OpenStreetMap tiles (Leaflet, loaded only here), one circle per place ----------
  type LeafletNS = typeof import('leaflet');
  let L: LeafletNS | null = null, map: import('leaflet').Map | null = null, pins: import('leaflet').LayerGroup | null = null, lastPlaces: Row[] = [];
  async function leaflet() {
    if (!L) { const [m] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]); L = (m as any).default || m; }
    return L!;
  }
  const cssVar = (n: string, d: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;
  function tiles(Lf: LeafletNS) {
    return Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' });
  }
  async function renderMap(places: Row[]) {
    lastPlaces = places;
    const box = $('st-map');
    if (box.closest('[hidden]')) return;   // drawn when its tab opens
    let Lf: LeafletNS;
    try { Lf = await leaflet(); } catch { box.replaceChildren(h('p', { class: 'st-empty' }, "The map couldn't load. The Countries and Cities tabs have the same places.")); return; }
    if (!map) {
      map = Lf.map(box, { worldCopyJump: true, scrollWheelZoom: false, zoomSnap: 0.5 }).setView([20, 10], 1.5);
      tiles(Lf).addTo(map); pins = Lf.layerGroup().addTo(map);
    }
    map.invalidateSize();
    pins!.clearLayers();
    const max = Math.max(1, ...places.map((p) => p.visitors)), fill = cssVar('--viz-1', '#2a6fdb'), ring = cssVar('--card', '#fff');
    // biggest first, so small places stay on top and clickable
    for (const p of [...places].sort((a, b) => b.visitors - a.visitors)) {
      const m = Lf.circleMarker([p.lat, p.lon], { radius: 6 + 14 * Math.sqrt(p.visitors / max), color: ring, weight: 2, fillColor: fill, fillOpacity: 0.78 });
      m.bindTooltip(h('div', { class: 'st-pin-tip' }, h('b', null, `${flag(p.country)} ${placeName(p)}`), h('div', null, country(p.country)),
        h('div', null, `${num(p.visitors)} visitor${p.visitors === 1 ? '' : 's'} · ${num(p.views)} page view${p.views === 1 ? '' : 's'}`)), { direction: 'top', offset: [0, -6] });
      m.on('click', () => addFilter(chipFor.city(p)));
      pins!.addLayer(m);
    }
    if (places.length) map.fitBounds(Lf.latLngBounds(places.map((p) => [p.lat, p.lon] as [number, number])).pad(0.4), { maxZoom: chips.some((c) => c.kind === 'city') ? 9 : 5 });
    else map.setView([20, 10], 1.5);
  }
  // tabs inside a card (Map / Countries / Cities, Top pages / Your posts, …)
  document.querySelectorAll<HTMLElement>('#st-pane .st-tabs').forEach((tabs) => tabs.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-show]'); if (!b) return;
    tabs.querySelectorAll<HTMLButtonElement>('button[data-show]').forEach((x) => { x.setAttribute('aria-selected', String(x === b)); $(x.dataset.show!).hidden = x !== b; });
    if (b.dataset.show === 'st-map-box') renderMap(lastPlaces);
  }));

  // ---------- your posts: all-time views, and this period's visitors, likes and replies ----------
  async function loadPostStats() {
    const my = ++seq.posts;
    try {
      const [{ posts }, t] = await Promise.all([api(`/admin/posts?${query()}`), postTitles()]);
      if (my !== seq.posts) return;
      const list = posts.filter((p: Row) => t[p.post]);   // posts still on the site
      const per = days === 1 ? '24 hours' : `${days} days`;
      bars('st-posts', list, {
        label: (p) => [t[p.post], h('span', { class: 'st-sub' }, `${num(p.visitors)} visitor${p.visitors === 1 ? '' : 's'} in ${per} · ${num(p.likes)} like${p.likes === 1 ? '' : 's'} · ${num(p.replies)} repl${p.replies === 1 ? 'y' : 'ies'}`)],
        value: (p) => p.views, unit: 'views, all time', empty: 'No post views yet.',
        chip: (p) => ({ kind: 'path', label: `Page: ${t[p.post]}`, params: { path: `${o.base}/posts/${p.post}/` } }), open: (p) => `${o.base}/posts/${p.post}/`,
      });
    } catch (x) { if (my === seq.posts) $('st-posts').replaceChildren(h('p', { class: 'st-empty' }, (x as Error).message)); }
  }

  // ---------- visitors (one row per IP address and device): compact rows; tap one for everything about them ----------
  let whoMode: 'all' | 'online' = 'all', visitorRows: Row[] = [], visitorsShown = 0;
  function setWho(m: 'all' | 'online') {
    whoMode = m;
    document.querySelectorAll('#st-visitors-card [data-who]').forEach((x) => x.setAttribute('aria-selected', String((x as HTMLElement).dataset.who === m)));
    loadVisitors(true);
  }
  async function loadVisitors(fresh = true) {
    const my = ++seq.visitors; $('st-visitors-err').hidden = true;
    try {
      const { visitors } = await api(`/admin/visitors?${query({ limit: '300', ...(whoMode === 'online' ? { online: '1' } : {}) })}`);
      if (my !== seq.visitors) return;
      visitorRows = visitors; visitorsShown = 0;
      $('st-visitors-n').textContent = visitors.length ? `${num(visitors.length)}${visitors.length >= 300 ? '+' : ''}` : '';
      $('st-visitors').replaceChildren(visitors.length ? h('ul', { class: 'st-people' }) : h('p', { class: 'st-empty' }, whoMode === 'online' ? 'Nobody in the last 5 minutes.' : 'No visitors yet.'));
      moreVisitors();
    } catch (x) { if (my === seq.visitors) fail('st-visitors-err', x); }
  }
  function moreVisitors() {
    const ul = $('st-visitors').querySelector('ul'), next = visitorRows.slice(visitorsShown, visitorsShown + 15);
    if (ul) next.forEach((v) => ul.append(h('li', null, personRow(v))));
    visitorsShown += next.length;
    $('st-visitors-more').hidden = visitorsShown >= visitorRows.length;
  }
  function personRow(v: Row) {
    return h('button', { type: 'button', class: 'st-who', onclick: () => openPanel(v) },
      h('span', { class: 'st-who-flag', 'aria-hidden': 'true' }, flag(v.country)),
      h('span', { class: 'st-who-main' },
        h('span', { class: 'st-who-name' }, h('b', null, deviceName(v)), h('code', { class: 'st-ip' }, v.ip || 'no IP'), h('span', { class: 'st-tag' }, v.source || 'direct'), isOnline(v.last) ? h('span', { class: 'st-tag ok' }, 'online') : null,
          v.name ? h('span', { class: 'st-tag' }, `replied as ${v.name}`) : null, v.blocked ? h('span', { class: 'st-tag bad' }, 'blocked') : null),
        h('span', { class: 'st-sub' }, [placeName(v), country(v.country)].join(', '), ' · ', v.org || 'unknown network', v.browser ? ` · ${v.browser}` : '')),
      h('span', { class: 'st-who-meta' }, h('span', null, h('b', null, num(v.views)), ` view${v.views === 1 ? '' : 's'}`), h('span', { class: 'st-sub', title: when(v.last) }, ago(v.last))),
      h('span', { class: 'st-chev', 'aria-hidden': 'true' }, '›'));
  }

  // ---------- recent visits (the raw log, newest first): one line each; tap for the visitor ----------
  async function loadVisits(fresh = false) {
    const my = fresh ? ++seq.visits : seq.visits, more = $('st-visits-more') as HTMLButtonElement;
    if (fresh) visitsCursor = 0; else more.disabled = true;
    $('st-visits-err').hidden = true;
    try {
      const { visits } = await api(`/admin/visits?${query({ limit: '30', ...(visitsCursor ? { before: String(visitsCursor) } : {}) })}`);
      if (my !== seq.visits) return;   // a newer load took over
      if (fresh) $('st-visits').replaceChildren();
      const list = $('st-visits').querySelector('ul') || $('st-visits').appendChild(h('ul', { class: 'st-log' }));
      visits.forEach((v: Row) => list.append(h('li', null, h('button', { type: 'button', class: 'st-hit', onclick: () => openPanel(v, v) },
        h('span', { class: 'st-hit-when', title: when(v.ts) }, ago(v.ts)),
        h('span', { class: 'st-hit-main' }, h('span', { class: 'st-hit-page' }, cleanTitle(v.title, v.path)),
          h('span', { class: 'st-sub' }, `${flag(v.country)} ${placeName(v)} · ${deviceName(v)} · ${v.ip || 'no IP'} · ${v.source ? `from ${v.source}` : 'direct'}`)),
        h('span', { class: 'st-chev', 'aria-hidden': 'true' }, '›')))));
      if (!list.children.length) $('st-visits').replaceChildren(h('p', { class: 'st-empty' }, 'No visits yet.'));
      visitsCursor = visits.length ? visits[visits.length - 1].id : visitsCursor;
      more.hidden = visits.length < 30;
    } catch (x) { if (my === seq.visits) fail('st-visits-err', x); }
    finally { more.disabled = false; }
  }

  // ---------- one visitor: where, network, device, activity, every page; filter or block from here ----------
  let panelMap: import('leaflet').Map | null = null;
  async function openPanel(row: Row, visit: Row | null = null) {
    const d = $('st-panel') as HTMLDialogElement;
    const key: Record<string, string> | null = row.ip ? visitorKey(row) : null;
    const close = h('button', { type: 'button', class: 'st-panel-x', 'aria-label': 'Close', onclick: () => d.close() }, '×');
    d.replaceChildren(h('div', { class: 'st-panel-head' }, h('h3', { id: 'st-panel-title' }, `${flag(row.country)} ${who(row)}`), close), h('p', { class: 'st-empty' }, 'Loading…'));
    if (!d.open) d.showModal();
    let v = row, hist: Row[] = [];
    try {
      if (key) {
        const [a, b] = await Promise.all([api(`/admin/visitors?${new URLSearchParams({ days: '90', limit: '1', ...key })}`), api(`/admin/visits?${new URLSearchParams({ limit: '50', ...key })}`)]);
        v = { ...row, ...(a.visitors[0] || {}) }; hist = b.visits;
      }
    } catch (x) { d.replaceChildren(h('div', { class: 'st-panel-head' }, h('h3', { id: 'st-panel-title' }, who(row)), close), h('p', { class: 'st-empty' }, (x as Error).message)); return; }
    if (!d.open) return;   // closed while loading
    const at = visit || v;   // where they were on this visit (or their latest)
    const dl = (pairs: [string, any][]) => h('dl', { class: 'st-dl' }, pairs.filter(([, x]) => x != null && x !== '').map(([k, x]) => [h('dt', null, k), h('dd', null, x)]));
    const hasXY = typeof at.lat === 'number' && typeof at.lon === 'number';
    const osm = hasXY ? `https://www.openstreetmap.org/?mlat=${at.lat}&mlon=${at.lon}#map=12/${at.lat}/${at.lon}` : null;
    let localTime = '';
    if (at.timezone) { try { localTime = new Date().toLocaleTimeString('en-US', { timeZone: at.timezone, hour: 'numeric', minute: '2-digit' }); } catch {} }
    const copy = (text: string) => h('button', { type: 'button', class: 'st-link', onclick: async (e: Event) => { const b = e.currentTarget as HTMLElement; try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; } } }, 'Copy');
    d.replaceChildren(
      h('div', { class: 'st-panel-head' },
        h('h3', { id: 'st-panel-title' }, `${flag(at.country)} ${who(v)}`, isOnline(v.last) ? h('span', { class: 'st-tag ok' }, 'online now') : null, v.blocked ? h('span', { class: 'st-tag bad' }, 'blocked') : null),
        close),
      h('section', null, h('h4', null, visit ? 'Where they were on this visit' : 'Where they are'),
        hasXY ? h('div', { class: 'st-panel-map', id: 'st-panel-map' }) : null,
        dl([
          ['Place', [at.city, at.region && at.region !== at.city ? at.region : null, at.postal].filter(Boolean).join(', ') || 'Unknown'],
          ['Country', `${flag(at.country)} ${country(at.country)}`],
          ['Coordinates', hasXY ? [h('code', null, `${at.lat.toFixed(4)}, ${at.lon.toFixed(4)}`), ' ', h('a', { href: osm!, target: '_blank', rel: 'noopener' }, 'Open map ↗')] : null],
          ['Time zone', at.timezone ? `${at.timezone}${localTime ? ` (their time now: ${localTime})` : ''}` : null],
        ]),
        h('p', { class: 'st-note' }, "From the IP address: usually the right city or postal area, not a street. VPNs and mobile networks can show a nearby city instead.")),
      h('section', null, h('h4', null, 'Network'), dl([
        ['IP address', at.ip ? [h('code', { class: 'st-ip' }, at.ip), ' ', copy(at.ip)] : 'Not recorded'],
        ['Provider', at.org ? `${at.org}${at.asn ? ` (AS${at.asn})` : ''}` : at.asn ? `AS${at.asn}` : null],
      ])),
      h('section', null, h('h4', null, 'Device'), dl([
        ['Model', at.model || 'Not reported (iPhones and some browsers keep it private)'], ['Type', at.device], ['System', at.os], ['Browser', at.browser], ['Screen', at.screen], ['Language', at.lang],
      ])),
      h('section', null, h('h4', null, 'Activity'), dl([
        ['First seen', v.first ? `${when(v.first)} (${ago(v.first)})` : null], ['Last seen', v.last ? `${when(v.last)} (${ago(v.last)})` : null],
        ['Page views', v.views != null ? `${num(v.views)} on ${num(v.pages)} page${v.pages === 1 ? '' : 's'} (last 90 days)` : null],
        ['Came from', [v.source || (visit && visit.source) || 'Direct or unknown', (v.referrer || (visit && visit.referrer)) ? h('span', { class: 'st-sub' }, ` (${v.referrer || visit!.referrer})`) : null]],
        ['Replies', v.comments ? `${num(v.comments)}${v.name ? ` as “${v.name}”` : ''}` : null], ['Likes', v.likes ? num(v.likes) : null],
      ])),
      h('section', null, h('h4', null, `Pages they read${hist.length >= 50 ? ' (latest 50)' : ''}`),
        hist.length ? h('ol', { class: 'st-trail' }, hist.map((x) => h('li', null, h('span', { class: 'st-sub', title: when(x.ts) }, ago(x.ts)), ' ',
          sitePath(x.path) ? h('a', { href: sitePath(x.path)!, target: '_blank', rel: 'noopener' }, cleanTitle(x.title, x.path)) : cleanTitle(x.title, x.path),
          x.source ? h('span', { class: 'st-sub' }, ` · from ${x.source}`) : null, x.city && x.city !== at.city ? h('span', { class: 'st-sub' }, ` · ${flag(x.country)} ${x.city}`) : null)))
          : h('p', { class: 'st-empty' }, 'No visits recorded.')),
      h('div', { class: 'st-acts' },
        key ? h('button', { type: 'button', class: 'st-btn', onclick: () => { d.close(); addFilter(chipFor.visitor(v)); } }, 'Show only this visitor') : null,
        at.ip ? blockButton(at.ip, !!v.blocked, () => d.close()) : null));
    if (hasXY) {
      try {
        const Lf = await leaflet();
        if (!d.open) return;
        panelMap?.remove();
        panelMap = Lf.map($('st-panel-map'), { scrollWheelZoom: false, zoomControl: true, attributionControl: true }).setView([at.lat, at.lon], 10);
        tiles(Lf).addTo(panelMap);
        // a circle, not a pin: the place is an area (about 5 km around Cloudflare's point)
        Lf.circle([at.lat, at.lon], { radius: 5000, color: cssVar('--viz-1', '#2a6fdb'), weight: 2, fillOpacity: 0.15 }).addTo(panelMap);
        Lf.circleMarker([at.lat, at.lon], { radius: 5, color: cssVar('--card', '#fff'), weight: 2, fillColor: cssVar('--viz-1', '#2a6fdb'), fillOpacity: 1 }).addTo(panelMap);
      } catch { $('st-panel-map').replaceChildren(h('p', { class: 'st-empty' }, "The map couldn't load.")); }
    }
  }
  ($('st-panel') as HTMLDialogElement).addEventListener('close', () => { panelMap?.remove(); panelMap = null; });
  // a tap on the dimmed area outside the panel closes it
  $('st-panel').addEventListener('click', (e) => { if (e.target === e.currentTarget) ($('st-panel') as HTMLDialogElement).close(); });

  // ---------- blocking ----------
  function blockButton(ip: string, blocked: boolean, after: (() => void) | null = null) {
    return h('button', { type: 'button', class: `st-btn${blocked ? '' : ' danger'}`, onclick: async (e: Event) => {
      const b = e.currentTarget as HTMLButtonElement;
      try {
        if (blocked) { if (!confirm(`Unblock ${ip}?`)) return; b.disabled = true; await api('/admin/blocks/delete', { ip }); }
        else {
          if (!confirm(`Block ${ip}? Guests from this address won't be able to reply or like any more.`)) return;
          const purge = confirm(`Also delete every reply sent from ${ip}?`);
          b.disabled = true; await api('/admin/blocks', { ip, purge });
        }
        if (after) after();
        refreshAll();
      } catch (x) { alert((x as Error).message); b.disabled = false; }
    } }, blocked ? 'Unblock IP' : 'Block IP');
  }

  // ---------- comments (moderation) ----------
  async function loadComments(fresh = false) {
    const my = fresh ? ++seq.comments : seq.comments, more = $('cm-more') as HTMLButtonElement;
    if (fresh) commentsCursor = 0; else more.disabled = true;
    $('cm-err').hidden = true;
    try {
      const [d, t, bl] = await Promise.all([api(`/admin/comments?limit=30${commentsCursor ? `&before=${commentsCursor}` : ''}${onlyReported ? '&reported=1' : ''}`), postTitles(), fresh ? api('/admin/blocks') : null]);
      if (my !== seq.comments) return;   // a newer load took over
      if (fresh) $('cm-list').replaceChildren();
      $('cm-count').textContent = `Replies (${num(d.total)})`;
      $('cm-reported-n').textContent = d.reported ? `(${num(d.reported)})` : '';
      const list = $('cm-list').querySelector('ul') || $('cm-list').appendChild(h('ul', { class: 'st-log' }));
      d.comments.forEach((c: Row) => list.append(h('li', { class: 'st-visit cm-item', id: `cm-${c.id}` },
        h('div', { class: 'st-person-top' },
          h('b', null, c.owner ? o.handle : c.name), h('span', { class: 'st-tag' }, c.owner ? 'author' : 'reader'), c.blocked ? h('span', { class: 'st-tag bad' }, 'blocked') : null,
          c.reports ? h('span', { class: 'st-tag bad' }, `⚑ reported ${c.reports}×`) : null,
          h('span', { class: 'st-when', title: when(c.ts) }, ago(c.ts))),
        h('div', { class: 'st-line2' }, c.parent ? `answer to ${c.parent_name || 'a reply'} on ` : 'on ', h('a', { href: `${o.base}/posts/${c.post}/#comment-${c.id}`, target: '_blank', rel: 'noopener' }, t[c.post] || c.post),
          c.likes ? ` · ♥ ${num(c.likes)}` : ''),
        h('div', { class: 'cm-body' }, c.body),
        c.reasons ? h('div', { class: 'st-line2 cm-reasons' }, 'Reported because: ', c.reasons) : null,
        c.owner ? null : h('div', { class: 'st-line2' }, h('code', { class: 'st-ip' }, c.ip || 'IP removed (older than 90 days)'), c.country ? ` · ${flag(c.country)} ${place(c)}` : ''),
        h('div', { class: 'st-acts' },
          h('button', { type: 'button', class: 'st-btn danger', onclick: async (e: Event) => {
            if (!confirm('Delete this reply?')) return;
            const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
            try { await api(`/admin/comments/${c.id}/delete`, {}); $(`cm-${c.id}`).remove(); } catch (x) { alert((x as Error).message); b.disabled = false; }
          } }, 'Delete'),
          c.reports ? h('button', { type: 'button', class: 'st-btn', onclick: async (e: Event) => {
            const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
            try { await api(`/admin/comments/${c.id}/dismiss`, {}); loadComments(true); } catch (x) { alert((x as Error).message); b.disabled = false; }
          } }, 'Keep it (dismiss reports)') : null,
          !c.owner && c.ip ? blockButton(c.ip, c.blocked) : null))));
      if (!list.children.length) $('cm-list').replaceChildren(h('p', { class: 'st-empty' }, onlyReported ? 'No reported replies.' : 'No replies yet. They show up here as soon as someone replies to a post.'));
      commentsCursor = d.comments.length ? d.comments[d.comments.length - 1].id : commentsCursor;
      more.hidden = d.comments.length < 30;
      if (bl) $('cm-blocks').replaceChildren(bl.blocks.length
        ? h('ul', { class: 'st-log' }, bl.blocks.map((b: Row) => h('li', { class: 'st-visit' }, h('div', { class: 'st-person-top' }, h('code', { class: 'st-ip' }, b.ip), b.note ? h('span', { class: 'st-sub' }, b.note) : null, h('span', { class: 'st-when', title: when(b.ts) }, `blocked ${ago(b.ts)}`)), h('div', { class: 'st-acts' }, blockButton(b.ip, true)))))
        : h('p', { class: 'st-empty' }, 'Nobody is blocked.'));
    } catch (x) { if (my === seq.comments) fail('cm-err', x); }
    finally { more.disabled = false; }
  }

  function refreshAll() {
    if (!$('st-pane').hidden) { renderChips(); loadStats(); loadPostStats(); loadVisitors(true); loadVisits(true); }
    if (!$('cm-pane').hidden) loadComments(true);
  }

  // ---------- wiring ----------
  document.querySelectorAll<HTMLButtonElement>('#st-range [data-days]').forEach((b) => b.addEventListener('click', () => {
    days = Number(b.dataset.days);
    document.querySelectorAll('#st-range [data-days]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadStats(); loadPostStats(); loadVisitors(true); loadVisits(true);
  }));
  $('st-refresh').addEventListener('click', refreshAll);
  // the period's visits as a CSV file (the download needs the sign-in header, so it's fetched, then saved)
  $('st-csv').addEventListener('click', async (e) => {
    const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
    try {
      const r = await fetch(`${o.api}/admin/visits.csv?${query()}`, { cache: 'no-store', headers: { Authorization: `Bearer ${o.token()}` } });
      if (!r.ok) throw new Error(r.status === 401 ? "The stats server didn't accept your sign-in. Log out and log in again." : `The stats server answered ${r.status}.`);
      const url = URL.createObjectURL(await r.blob());
      const a = h('a', { href: url, download: `visits-${days === 1 ? '24h' : `${days}d`}-${new Date().toISOString().slice(0, 10)}.csv` }) as HTMLAnchorElement;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60e3);
    } catch (x) { fail('st-err', x); }
    finally { b.disabled = false; }
  });
  // "Online now" keeps itself current while you look at it
  setInterval(async () => {
    if ($('st-pane').hidden || document.visibilityState !== 'visible' || !document.getElementById('st-live')) return;
    try { const { live } = await api(`/admin/live?${query()}`); const el = document.getElementById('st-live'); if (el) el.textContent = num(live); } catch {}
  }, 30e3);
  $('st-visits-more').addEventListener('click', () => loadVisits());
  $('st-visitors-more').addEventListener('click', moreVisitors);
  document.querySelectorAll<HTMLButtonElement>('#st-visitors-card [data-who]').forEach((b) => b.addEventListener('click', () => setWho(b.dataset.who as 'all' | 'online')));
  $('cm-more').addEventListener('click', () => loadComments());
  $('cm-refresh').addEventListener('click', () => loadComments(true));
  document.querySelectorAll<HTMLButtonElement>('#cm-show [data-show]').forEach((b) => b.addEventListener('click', () => {
    onlyReported = b.dataset.show === 'reported';
    document.querySelectorAll('#cm-show [data-show]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadComments(true);
  }));
  // ---------- "Comments 3": replies from guests you haven't seen here yet (remembered on this device) ----------
  const SEEN = 'adm-replies-seen';
  const seen = () => { try { return Number(localStorage.getItem(SEEN)) || 0; } catch { return 0; } };
  function setBadge(n: number) {
    const tab = document.querySelector('.adm-tabs [data-tab="comments"]');
    if (!tab) return;
    tab.querySelector('.adm-badge')?.remove();
    if (n > 0) tab.append(h('span', { class: 'adm-badge', title: `${n} new repl${n === 1 ? 'y' : 'ies'}` }, n >= 30 ? '30+' : String(n)));
  }
  async function badge() {
    try {
      const { comments, reported } = await api('/admin/comments?limit=30');
      setBadge($('cm-pane').hidden ? comments.filter((c: Row) => !c.owner && c.id > seen()).length + (reported || 0) : 0);
    } catch {}
  }
  setInterval(() => { if (document.visibilityState === 'visible' && o.token()) badge(); }, 120e3);
  const markSeen = async () => {
    try { const { comments } = await api('/admin/comments?limit=1'); if (comments[0]) localStorage.setItem(SEEN, String(comments[0].id)); } catch {}
    setBadge(0);
  };
  return {
    // called when a tab opens
    show(tab: string) {
      if (tab === 'stats') { renderChips(); loadStats(); loadPostStats(); loadVisitors(true); loadVisits(true); }
      if (tab === 'comments') { loadComments(true); markSeen(); }
    },
    badge,
  };
}
