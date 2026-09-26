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
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
const svg = (tag: string, attrs: Row = {}) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };

export function initStats(o: Opts) {
  const $ = (id: string) => document.getElementById(id)!;
  let days = 7, visitsCursor = 0, visitsFilter: { guest?: string; ip?: string; label?: string } = {}, commentsCursor = 0;
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
  const cleanTitle = (t: string | null, path: string) => (t ? t.replace(new RegExp(`\\s·\\s${o.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '') : path);

  // ---------- overview ----------
  async function loadStats() {
    const body = $('st-body'); body.classList.add('st-loading'); $('st-err').hidden = true;
    try {
      const s = await api(`/admin/stats?days=${days}&tzo=${-new Date().getTimezoneOffset()}`);
      renderKpis(s); renderChart(s); renderTops(s);
      $('st-bots').textContent = s.bots ? `${num(s.bots)} visit${s.bots === 1 ? '' : 's'} by bots and crawlers left out.` : '';
    } catch (x) { fail('st-err', x); }
    finally { body.classList.remove('st-loading'); }
  }
  function renderKpis(s: Row) {
    const tile = (label: string, value: number, note = '') => h('div', { class: 'st-kpi' }, h('div', { class: 'st-kpi-label' }, label), h('div', { class: 'st-kpi-value' }, num(value)), note ? h('div', { class: 'st-kpi-note' }, note) : null);
    const per = days === 1 ? 'last 24 hours' : `last ${days} days`;
    $('st-kpis').replaceChildren(
      tile('Visitors', s.visitors, per), tile('Page views', s.views, per),
      tile('Online now', s.live, 'last 5 minutes'), tile('Replies', s.comments, 'from guests'), tile('Likes', s.likes, per),
    );
  }

  // views + visitors over time: two lines on one axis (same unit), crosshair tooltip, table view
  let lastSeries: { key: string; label: string; views: number; visitors: number }[] = [];
  function buckets(s: Row) {
    const byKey = new Map((s.series as Row[]).map((r) => [r.b, r]));
    const pad = (n: number) => String(n).padStart(2, '0');
    const out = [];
    const start = new Date(Date.now() - days * DAY);
    if (days === 1) start.setMinutes(0, 0, 0); else start.setHours(0, 0, 0, 0);
    for (let t = new Date(start); t.getTime() <= Date.now(); days === 1 ? t.setHours(t.getHours() + 1) : t.setDate(t.getDate() + 1)) {
      const d = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`, key = days === 1 ? `${d} ${pad(t.getHours())}:00` : d;
      const r = byKey.get(key) || {};
      out.push({ key, label: days === 1 ? `${pad(t.getHours())}:00` : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), views: r.views || 0, visitors: r.visitors || 0 });
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

  // top lists: one bar per row, one colour (it's magnitude, not identity); value in text next to it
  function bars(id: string, rows: Row[], label: (r: Row) => (Node | string)[], value = (r: Row) => r.visitors, empty = 'Nothing yet.') {
    const max = Math.max(1, ...rows.map(value));
    $(id).replaceChildren(rows.length
      ? h('ol', { class: 'st-bars' }, rows.map((r) => h('li', { title: `${num(r.visitors)} visitor${r.visitors === 1 ? '' : 's'} · ${num(r.views)} page view${r.views === 1 ? '' : 's'}` },
          h('div', { class: 'st-bar-top' }, h('span', { class: 'st-bar-label' }, ...label(r)), h('span', { class: 'st-bar-n' }, num(value(r)))),
          h('div', { class: 'st-bar-track' }, h('span', { class: 'st-bar', style: `width:${Math.max(2, (value(r) / max) * 100)}%` })))))
      : h('p', { class: 'st-empty' }, empty));
  }
  function renderTops(s: Row) {
    bars('st-pages', s.pages, (r) => [h('a', { href: r.path, target: '_blank', rel: 'noopener' }, cleanTitle(r.title, r.path)), h('span', { class: 'st-sub' }, r.path)], (r) => r.views);
    bars('st-refs', s.referrers, (r) => [r.ref_host], undefined, 'No visits from other sites yet.');
    bars('st-countries', s.countries, (r) => [`${flag(r.country)} ${country(r.country)}`]);
    bars('st-cities', s.cities, (r) => [`${flag(r.country)} ${[r.city, r.region && r.region !== r.city ? r.region : null].filter(Boolean).join(', ')}`, h('span', { class: 'st-sub' }, country(r.country))]);
    bars('st-devices', s.devices, (r) => [r.device || 'Unknown']);
    bars('st-browsers', s.browsers, (r) => [r.browser || 'Unknown']);
    bars('st-os', s.os, (r) => [r.os || 'Unknown']);
  }

  // ---------- visitors (one row per guest cookie) ----------
  async function loadVisitors() {
    $('st-visitors-err').hidden = true;
    try {
      const { visitors } = await api(`/admin/visitors?days=${Math.max(days, 7)}`);
      $('st-visitors').replaceChildren(visitors.length ? h('ul', { class: 'st-people' }, visitors.map(person)) : h('p', { class: 'st-empty' }, 'No visitors yet.'));
    } catch (x) { fail('st-visitors-err', x); }
  }
  function person(v: Row) {
    const name = v.name || (v.guest ? `Guest ${v.guest.slice(0, 6)}` : 'No cookie');
    return h('li', { class: 'st-person' },
      h('div', { class: 'st-person-top' },
        h('b', null, name), v.name ? h('span', { class: 'st-tag' }, 'replied') : null, v.blocked ? h('span', { class: 'st-tag bad' }, 'blocked') : null,
        h('span', { class: 'st-when', title: when(v.last) }, `last seen ${ago(v.last)}`)),
      h('div', { class: 'st-line1' }, `${flag(v.country)} ${place(v)}`),
      h('div', { class: 'st-line2' }, h('code', { class: 'st-ip' }, v.ip || 'no IP'), v.org ? ` · ${v.org}` : '', ` · ${[v.device, v.os, v.browser].filter(Boolean).join(' · ')}`),
      h('div', { class: 'st-line2' }, `${num(v.views)} page view${v.views === 1 ? '' : 's'} · ${num(v.pages)} page${v.pages === 1 ? '' : 's'} · first seen ${ago(v.first)}`,
        v.comments ? ` · ${v.comments} repl${v.comments === 1 ? 'y' : 'ies'}` : '', v.likes ? ` · ${v.likes} like${v.likes === 1 ? '' : 's'}` : ''),
      h('div', { class: 'st-acts' },
        h('button', { type: 'button', class: 'st-btn', onclick: () => filterVisits(v.guest ? { guest: v.guest, label: name } : { ip: v.ip, label: v.ip }) }, 'Their visits'),
        v.ip ? blockButton(v.ip, v.blocked) : null));
  }

  // ---------- recent visits (the raw log, newest first) ----------
  function filterVisits(f: typeof visitsFilter) {
    visitsFilter = f; loadVisits(true);
    $('st-visits-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function loadVisits(fresh = false) {
    if (fresh) { visitsCursor = 0; $('st-visits').replaceChildren(); }
    $('st-visits-err').hidden = true;
    const f = visitsFilter, q = new URLSearchParams({ limit: '40' });
    if (visitsCursor) q.set('before', String(visitsCursor));
    if (f.guest) q.set('guest', f.guest); if (f.ip) q.set('ip', f.ip);
    $('st-visits-filter').replaceChildren(f.label ? h('button', { type: 'button', class: 'st-chip', onclick: () => { visitsFilter = {}; loadVisits(true); } }, `Only ${f.label} ×`) : '');
    try {
      const { visits } = await api(`/admin/visits?${q}`);
      const list = $('st-visits').querySelector('ul') || $('st-visits').appendChild(h('ul', { class: 'st-log' }));
      visits.forEach((v: Row) => list.append(h('li', { class: 'st-visit' },
        h('div', { class: 'st-person-top' },
          h('a', { href: v.path, target: '_blank', rel: 'noopener', class: 'st-page' }, cleanTitle(v.title, v.path)),
          h('span', { class: 'st-when', title: when(v.ts) }, ago(v.ts))),
        h('div', { class: 'st-line1' }, `${flag(v.country)} ${place(v)}`, v.timezone ? h('span', { class: 'st-sub' }, ` · ${v.timezone}`) : ''),
        h('div', { class: 'st-line2' }, h('code', { class: 'st-ip' }, v.ip || 'no IP'), v.org ? ` · ${v.org}` : '', v.asn ? ` (AS${v.asn})` : '', ` · ${[v.device, v.os, v.browser].filter(Boolean).join(' · ')}`, v.screen ? ` · ${v.screen}` : '', v.lang ? ` · ${v.lang}` : ''),
        h('div', { class: 'st-line2' }, v.name ? h('b', null, v.name) : `Guest ${v.guest ? v.guest.slice(0, 6) : '(no cookie)'}`, v.referrer ? ` · came from ${v.referrer}` : '', v.blocked ? h('span', { class: 'st-tag bad' }, 'blocked') : ''),
        h('div', { class: 'st-acts' },
          !f.label && (v.guest || v.ip) ? h('button', { type: 'button', class: 'st-btn', onclick: () => filterVisits(v.guest ? { guest: v.guest, label: v.name || `Guest ${v.guest.slice(0, 6)}` } : { ip: v.ip, label: v.ip }) }, 'Their visits') : null,
          v.ip ? blockButton(v.ip, v.blocked) : null))));
      if (!list.children.length) $('st-visits').replaceChildren(h('p', { class: 'st-empty' }, 'No visits yet.'));
      visitsCursor = visits.length ? visits[visits.length - 1].id : visitsCursor;
      $('st-visits-more').hidden = visits.length < 40;
    } catch (x) { fail('st-visits-err', x); }
  }

  // ---------- blocking ----------
  function blockButton(ip: string, blocked: boolean) {
    return h('button', { type: 'button', class: `st-btn${blocked ? '' : ' danger'}`, onclick: async (e: Event) => {
      const b = e.currentTarget as HTMLButtonElement;
      try {
        if (blocked) { if (!confirm(`Unblock ${ip}?`)) return; b.disabled = true; await api('/admin/blocks/delete', { ip }); }
        else {
          if (!confirm(`Block ${ip}? Guests from this address won't be able to reply or like any more.`)) return;
          const purge = confirm(`Also delete every reply sent from ${ip}?`);
          b.disabled = true; await api('/admin/blocks', { ip, purge });
        }
        refreshAll();
      } catch (x) { alert((x as Error).message); b.disabled = false; }
    } }, blocked ? 'Unblock IP' : 'Block IP');
  }

  // ---------- comments (moderation) ----------
  async function loadComments(fresh = false) {
    if (fresh) { commentsCursor = 0; $('cm-list').replaceChildren(); }
    $('cm-err').hidden = true;
    try {
      const [d, t, bl] = await Promise.all([api(`/admin/comments?limit=30${commentsCursor ? `&before=${commentsCursor}` : ''}`), postTitles(), fresh ? api('/admin/blocks') : null]);
      $('cm-count').textContent = `Replies (${num(d.total)})`;
      const list = $('cm-list').querySelector('ul') || $('cm-list').appendChild(h('ul', { class: 'st-log' }));
      d.comments.forEach((c: Row) => list.append(h('li', { class: 'st-visit cm-item', id: `cm-${c.id}` },
        h('div', { class: 'st-person-top' },
          h('b', null, c.owner ? o.handle : c.name), h('span', { class: 'st-tag' }, c.owner ? 'author' : 'guest'), c.blocked ? h('span', { class: 'st-tag bad' }, 'blocked') : null,
          h('span', { class: 'st-when', title: when(c.ts) }, ago(c.ts))),
        h('div', { class: 'st-line2' }, 'on ', h('a', { href: `${o.base}/posts/${c.post}/#comment-${c.id}`, target: '_blank', rel: 'noopener' }, t[c.post] || c.post)),
        h('div', { class: 'cm-body' }, c.body),
        c.owner ? null : h('div', { class: 'st-line2' }, h('code', { class: 'st-ip' }, c.ip || 'IP removed (older than 90 days)'), c.country ? ` · ${flag(c.country)} ${place(c)}` : ''),
        h('div', { class: 'st-acts' },
          h('button', { type: 'button', class: 'st-btn danger', onclick: async (e: Event) => {
            if (!confirm('Delete this reply?')) return;
            const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
            try { await api(`/admin/comments/${c.id}/delete`, {}); $(`cm-${c.id}`).remove(); } catch (x) { alert((x as Error).message); b.disabled = false; }
          } }, 'Delete'),
          !c.owner && c.ip ? blockButton(c.ip, c.blocked) : null))));
      if (!list.children.length) $('cm-list').replaceChildren(h('p', { class: 'st-empty' }, 'No replies yet. They show up here as soon as someone replies to a post.'));
      commentsCursor = d.comments.length ? d.comments[d.comments.length - 1].id : commentsCursor;
      $('cm-more').hidden = d.comments.length < 30;
      if (bl) $('cm-blocks').replaceChildren(bl.blocks.length
        ? h('ul', { class: 'st-log' }, bl.blocks.map((b: Row) => h('li', { class: 'st-visit' }, h('div', { class: 'st-person-top' }, h('code', { class: 'st-ip' }, b.ip), b.note ? h('span', { class: 'st-sub' }, b.note) : null, h('span', { class: 'st-when', title: when(b.ts) }, `blocked ${ago(b.ts)}`)), h('div', { class: 'st-acts' }, blockButton(b.ip, true)))))
        : h('p', { class: 'st-empty' }, 'Nobody is blocked.'));
    } catch (x) { fail('cm-err', x); }
  }

  function refreshAll() {
    if (!$('st-pane').hidden) { loadStats(); loadVisitors(); loadVisits(true); }
    if (!$('cm-pane').hidden) loadComments(true);
  }

  // ---------- wiring ----------
  document.querySelectorAll<HTMLButtonElement>('#st-range [data-days]').forEach((b) => b.addEventListener('click', () => {
    days = Number(b.dataset.days);
    document.querySelectorAll('#st-range [data-days]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadStats(); loadVisitors();
  }));
  $('st-refresh').addEventListener('click', refreshAll);
  $('st-visits-more').addEventListener('click', () => loadVisits());
  $('cm-more').addEventListener('click', () => loadComments());
  $('cm-refresh').addEventListener('click', () => loadComments(true));
  return {
    // called when a tab opens
    show(tab: string) {
      if (tab === 'stats') { loadStats(); loadVisitors(); loadVisits(true); }
      if (tab === 'comments') loadComments(true);
    },
  };
}
