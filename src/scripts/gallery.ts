// Picture viewer for posts, like the forum's: tap a picture to open it with every picture of the post. Counter at the
// top left; zoom, open in a new tab, full screen, slideshow, download, thumbnails and close at the top right; arrows,
// swipe or ← → to move; the picture's name and "author · date" under it; the thumbnails along the bottom.

const ICONS: Record<string, string> = {
  zoom: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  unzoom: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  unfull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  down: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  prev: '<path d="m15 5-7 7 7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
};
const svg = (k: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
const nameOf = (img: HTMLImageElement) => {
  if (img.alt.trim()) return img.alt.trim();
  try { return decodeURIComponent(new URL(img.currentSrc || img.src).pathname.split('/').pop() || 'picture'); } catch { return 'picture'; }
};

export function initGallery(root: HTMLElement) {
  const imgs = [...root.querySelectorAll<HTMLImageElement>('img')].filter((i) => !i.closest('a'));   // a picture that is a link keeps its link
  if (!imgs.length) return;
  const by = root.dataset.gxBy || '', date = root.dataset.gxDate || '';
  imgs.forEach((img, i) => {
    img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', `View picture: ${nameOf(img)}`);
    img.addEventListener('click', () => open(i, img));
    img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(i, img); } });
  });

  function open(start: number, from: HTMLElement) {
    let at = start, zoomed = false, timer = 0;
    const many = imgs.length > 1;
    const box = document.createElement('div');
    box.className = 'gx'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Picture viewer');
    const btn = (k: string, label: string, tag = 'button') => `<${tag} class="gx-btn gx-${k}" ${tag === 'a' ? 'href="#"' : 'type="button"'} title="${label}" aria-label="${label}">${svg(k)}</${tag}>`;
    box.innerHTML = `
      <div class="gx-bar"><span class="gx-count" aria-live="polite"></span><div class="gx-tools">
        ${btn('zoom', 'Zoom')}${btn('open', 'Open in a new tab', 'a')}${document.fullscreenEnabled ? btn('full', 'Full screen') : ''}
        ${many ? btn('play', 'Slideshow') : ''}${btn('down', 'Download', 'a')}${many ? btn('grid', 'Thumbnails') : ''}${btn('close', 'Close')}</div></div>
      <div class="gx-main">
        ${many ? `<button class="gx-nav gx-prev" type="button" aria-label="Previous picture">${svg('prev')}</button>` : ''}
        <div class="gx-stage"><img class="gx-img" alt="" draggable="false" /></div>
        ${many ? `<button class="gx-nav gx-next" type="button" aria-label="Next picture">${svg('next')}</button>` : ''}
      </div>
      <div class="gx-cap"><b class="gx-title"></b><span class="gx-meta">${[by, date].filter(Boolean).join(' · ')}</span></div>
      ${many ? `<div class="gx-thumbs">${imgs.map((im, i) => `<button type="button" class="gx-th" data-i="${i}" aria-label="Picture ${i + 1}"><img alt="" loading="lazy" /></button>`).join('')}</div>` : ''}`;
    const $ = <T extends Element>(s: string) => box.querySelector(s) as T;
    const stage = $<HTMLDivElement>('.gx-stage'), big = $<HTMLImageElement>('.gx-img');
    box.querySelectorAll<HTMLImageElement>('.gx-th img').forEach((t, i) => { t.src = imgs[i].currentSrc || imgs[i].src; });
    const src = (i: number) => imgs[i].currentSrc || imgs[i].src;

    function show(i: number) {
      at = (i + imgs.length) % imgs.length; setZoom(false);
      big.src = src(at); big.alt = imgs[at].alt;
      $('.gx-count').textContent = `${at + 1} / ${imgs.length}`;
      $('.gx-title').textContent = nameOf(imgs[at]);
      const o = $<HTMLAnchorElement>('.gx-open'); o.href = src(at); o.target = '_blank'; o.rel = 'noopener';
      const d = $<HTMLAnchorElement>('.gx-down'); d.href = src(at); d.download = nameOf(imgs[at]).replace(/[^\w.-]+/g, '-');
      box.querySelectorAll('.gx-th').forEach((t, j) => { t.classList.toggle('on', j === at); if (j === at) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current'); });
      { const th = box.querySelector<HTMLElement>('.gx-th.on'), strip = th?.parentElement; if (th && strip) strip.scrollLeft = th.offsetLeft - (strip.clientWidth - th.offsetWidth) / 2; }   // only the strip scrolls (scrollIntoView can move the page on phones)
      if (many) [at + 1, at - 1].forEach((j) => { const p = new Image(); p.src = src((j + imgs.length) % imgs.length); });
    }
    function setZoom(on: boolean, x?: number, y?: number) {
      if (on && big.naturalWidth <= stage.clientWidth && big.naturalHeight <= stage.clientHeight) on = false;   // already shown whole at full size
      zoomed = on; box.classList.toggle('gx-zoomed', on);
      const z = $('.gx-zoom'); z.innerHTML = svg(on ? 'unzoom' : 'zoom'); z.setAttribute('aria-label', on ? 'Zoom out' : 'Zoom'); z.setAttribute('title', on ? 'Zoom out' : 'Zoom');
      if (on) {   // keep the spot that was tapped under the pointer
        const fx = x === undefined ? .5 : x, fy = y === undefined ? .5 : y;
        stage.scrollLeft = big.naturalWidth * fx - stage.clientWidth / 2; stage.scrollTop = big.naturalHeight * fy - stage.clientHeight / 2;
      }
    }
    function play(on: boolean) {
      clearInterval(timer); timer = 0;
      const b = box.querySelector('.gx-play'); if (!b) return;
      if (on) timer = window.setInterval(() => show(at + 1), 3500);
      b.innerHTML = svg(on ? 'pause' : 'play'); b.setAttribute('aria-label', on ? 'Stop slideshow' : 'Slideshow'); b.setAttribute('title', on ? 'Stop slideshow' : 'Slideshow');
    }
    function close() {
      play(false); if (document.fullscreenElement === box) document.exitFullscreen().catch(() => {});
      box.remove(); document.removeEventListener('keydown', key); document.removeEventListener('fullscreenchange', fsIcon);
      (imgs[at] || from).focus({ preventScroll: true });
    }
    function fsIcon() { const f = box.querySelector('.gx-full'); if (f) { const on = document.fullscreenElement === box; f.innerHTML = svg(on ? 'unfull' : 'full'); f.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen'); } }
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft' && many) { play(false); show(at - 1); }
      else if (e.key === 'ArrowRight' && many) { play(false); show(at + 1); }
      else if (e.key === 'Tab') {   // keep the keyboard inside the viewer
        const f = [...box.querySelectorAll<HTMLElement>('button, a[href]')].filter((el) => el.offsetParent);
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    }

    box.addEventListener('click', (e) => {
      const t = e.target as HTMLElement, b = t.closest<HTMLElement>('button, a');
      if (b) {
        if (b.classList.contains('gx-close')) close();
        else if (b.classList.contains('gx-prev')) { play(false); show(at - 1); }
        else if (b.classList.contains('gx-next')) { play(false); show(at + 1); }
        else if (b.classList.contains('gx-zoom')) setZoom(!zoomed);
        else if (b.classList.contains('gx-play')) play(!timer);
        else if (b.classList.contains('gx-grid')) box.classList.toggle('gx-nothumbs');
        else if (b.classList.contains('gx-th')) { play(false); show(Number(b.dataset.i)); }
        else if (b.classList.contains('gx-full')) { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else box.requestFullscreen().catch(() => {}); }
        return;
      }
      if (t === big) { if (!moved) { const r = big.getBoundingClientRect(); setZoom(!zoomed, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); } }
      else if (!zoomed && (t === stage || t.classList.contains('gx-main'))) close();   // the dark area around the picture
    });
    // drag to look around a zoomed picture; swipe to move between pictures
    let sx = 0, sy = 0, sl = 0, st = 0, down = false, moved = false;
    stage.addEventListener('pointerdown', (e) => { down = true; moved = false; sx = e.clientX; sy = e.clientY; sl = stage.scrollLeft; st = stage.scrollTop; if (zoomed && e.pointerType === 'mouse') stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', (e) => {
      if (!down) return;
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 6) moved = true;
      if (zoomed && e.pointerType === 'mouse') { stage.scrollLeft = sl - (e.clientX - sx); stage.scrollTop = st - (e.clientY - sy); }
    });
    stage.addEventListener('pointerup', (e) => {
      if (!down) return; down = false;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!zoomed && many && Math.abs(dx) > 50 && Math.abs(dy) < 80) { play(false); show(at + (dx < 0 ? 1 : -1)); }
    });
    stage.addEventListener('pointercancel', () => { down = false; });

    document.addEventListener('keydown', key); document.addEventListener('fullscreenchange', fsIcon);
    document.body.append(box); show(start);
    $<HTMLElement>('.gx-close').focus({ preventScroll: true });
  }
}
