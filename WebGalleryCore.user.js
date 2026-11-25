// ==UserScript==
// @name         Web Gallery View (core)
// @namespace    https://violentmonkey.github.io/
// @version      3.4.0
// @description  Show a page's pictures, GIFs and videos as a media gallery with infinite scroll and a lightbox. Works best-effort on any site with a media grid; Reddit has full support (feeds, sorting, votes, comments).
// @homepageURL  https://github.com/realteamnet/RedditGallery
// @downloadURL  https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryCore.user.js
// @updateURL    https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryCore.user.js
// @match        *://*/*
// @noframes
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @connect      raw.githubusercontent.com
// @connect      v.redd.it
// @connect      api.redgifs.com
// @connect      media.redgifs.com
// ==/UserScript==

(() => {
  'use strict';

  // The Reddit-only and the any-site edition are the same code: only one of them runs.
  if (document.getElementById('wg-host') || document.getElementById('rg-host')) return;   // rg-host: editions before 2.1
  const REDDIT = /(^|\.)reddit\.com$/i.test(location.hostname);

  /* ------------------------------------------------------------------ *
   *  Settings (persisted with GM_getValue / GM_setValue)
   * ------------------------------------------------------------------ */
  const store = {
    get(k, d) { try { const v = GM_getValue(k); return v === undefined ? d : v; } catch { return d; } },
    set(k, v) { try { GM_setValue(k, v); } catch { /* ignore */ } },
  };
  // 'fill' used to be a separate toggle; carry an old setting over into the sizing list.
  if (store.get('fill', false)) { store.set('fit', 'fill'); store.set('fill', false); }
  const cfg = {
    columns: store.get('columns', 0),        // 0 = auto
    blurNsfw: store.get('blurNsfw', true),
    filter: store.get('filter', 'all'),            // all | videos | animated | gifs | pictures
    fit: store.get('fit', 'contain'),              // lightbox sizing: contain | fit | fill | width | actual
    speed: store.get('speed', 1),                  // lightbox video playback speed
    loop: store.get('loop', true),                 // lightbox video looping
    caption: store.get('caption', true),           // lightbox caption visible
    wide: store.get('wide', true),                 // let landscape items span several columns
    previews: store.get('previews', true),   // include link posts that only have a preview image
    muted: store.get('muted', true),               // global mute for every video
    autoplayAll: store.get('autoplayAll', true),   // play every visible video/GIF tile at once
    galleryAuto: store.get('galleryAuto', true),   // auto-cycle multi-image posts
    galleryMs: store.get('galleryMs', 1300),       // milliseconds between gallery images
    barUp: store.get('barUp', false),              // header collapsed to a single line
    autoScroll: store.get('autoScroll', false),    // creep down the grid on its own
    scrollSpeed: store.get('scrollSpeed', 60),     // pixels per second
    feeds: store.get('feeds', {}),           // { name: "r/pics+aww" | "user/me/m/myfeed" }
    cmtSort: store.get('cmtSort', 'confidence'),   // comment order in the comments panel ("confidence" = best)
  };

  /* ------------------------------------------------------------------ *
   *  Per-tab memory of which pages are in gallery mode.
   *  Uses sessionStorage only: it is private to this tab, is copied into tabs
   *  opened from it, and disappears when the tab closes. Nothing is written to
   *  the persistent (GM_setValue) settings.
   * ------------------------------------------------------------------ */
  const HANDOFF = '#rg-gallery';   // marker on links opened in a new tab from the gallery
  const IGNORED_PARAMS = /^(rdt|utm_.+|ref|ref_source|ref_campaign|share_id|correlation_id|context|\$deep_link)$/i;

  function pageKey() {
    const q = new URLSearchParams(location.search);
    for (const k of [...q.keys()]) if (IGNORED_PARAMS.test(k)) q.delete(k);
    const qs = q.toString();
    return location.pathname.replace(/\/+$/, '').toLowerCase() + (qs ? '?' + qs : '');
  }

  // Per tab: pages opened in a new tab from the gallery (see HANDOFF). Nothing else writes it.
  const tabPages = (() => {
    const KEY = 'rg:handoff-pages';
    let mem = new Set();   // fallback when sessionStorage is unavailable
    const read = () => {
      try { const v = sessionStorage.getItem(KEY); return new Set(v ? JSON.parse(v) : []); } catch { return mem; }
    };
    const write = (set) => {
      mem = set;
      try { sessionStorage.setItem(KEY, JSON.stringify([...set].slice(-200))); } catch { /* ignore */ }
    };
    return {
      has: (k) => read().has(k),
      add(k) { const set = read(); set.add(k); write(set); },
      del(k) { const set = read(); if (set.delete(k)) write(set); },
    };
  })();

  // A page you put in gallery view stays that way: saved for good, in every tab, until you
  // leave gallery view there. Only a deliberate open writes it (see toggle), so no page opens
  // as a gallery that was not switched to it. Subreddits and multireddits count as one page
  // under every sort. Read fresh each time, because another tab may have changed it.
  function feedKey() {
    const m = /^\/(?:(r\/[^/]+)|(?:user|u)\/([^/]+\/m\/[^/]+))(?:\/(?:hot|new|top|rising|controversial|best))?\/?$/i.exec(location.pathname);
    return m ? (m[1] || 'user/' + m[2]).toLowerCase() : '';
  }
  const memKey = () => (REDDIT ? feedKey() || pageKey() || '/' : location.host + (pageKey() || '/'));
  const pageMem = {
    list: () => store.get('galleryPages', null) || store.get('galleryFeeds', []),   // galleryFeeds: the 1.36 name
    has(k) { return this.list().includes(k); },
    add(k) { store.set('galleryPages', [...this.list().filter((x) => x !== k), k].slice(-500)); },
    del(k) { if (this.has(k)) store.set('galleryPages', this.list().filter((x) => x !== k)); },
  };


  // Sites with a Trusted Types policy reject plain strings as HTML.
  let ttPolicy;
  function trusted(html) {
    if (ttPolicy === undefined) {
      try { ttPolicy = window.trustedTypes?.createPolicy('web-gallery-view', { createHTML: (s) => s }) || null; } catch { ttPolicy = null; }
    }
    return ttPolicy ? ttPolicy.createHTML(html) : html;
  }
  const setHTML = (n, html) => { n.innerHTML = trusted(html); };

  // <web>
  /* ------------------------------------------------------------------ *
   *  Plugin: any site, part 1. Best-effort media discovery in the page itself.
   *  It sits out here because looking for a media grid happens before the
   *  gallery is started (see the end of the file).
   * ------------------------------------------------------------------ */
  const fabOff = () => store.get('fabOff', []).includes(location.host);

  const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)(?:[?#]|$)/i, VID_EXT = /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i;
  const GIF_EXT = /\.gif(?:[?#]|$)/i;
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-full', 'data-large', 'data-url'];
  const A_MEDIA = ['.jp', '.png', '.gif', '.webp', '.avif', '.mp4', '.webm'].map((x) => `a[href*="${x}" i]`).join(',');
  const PAGE_CHROME = '#wg-host,header,nav,footer,[role="navigation"],[role="banner"]';

  const abs = (u, base) => {
    if (!u) return '';                               // an empty address would resolve to the page itself
    try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
  };

  // Video sites show a still that plays a short clip on hover; the clip's address sits in a
  // data attribute of the picture, its link or the card around them.
  function previewOf(n, a, base) {
    const stop = a ? a.parentElement : null;
    for (let p = n, i = 0; p && p.nodeType === 1 && i < 4; p = p.parentElement, i++) {
      for (const at of p.attributes) if (at.name.startsWith('data-') && VID_EXT.test(at.value)) return abs(at.value, base);
      if (p === stop) break;
    }
    return '';
  }

  function biggestInSrcset(set, base) {
    let best = '', score = 0;
    for (const part of (set || '').split(/,\s+/)) {
      const [u, d] = part.trim().split(/\s+/);
      const n = parseFloat(d) || 1;                  // "640w" or "2x"
      if (u && n >= score) { score = n; best = u; }
    }
    return best ? abs(best, base) : '';
  }

  // WordPress names its thumbnails photo-300x200.jpg next to photo.jpg.
  const unsized = (u) => u.replace(/-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp|gif))(?=$|[?#])/i, '$1');

  // The items of one grid share the tags and classes of their nearest ancestors. The item's
  // own tag is left out: one grid may mix linked and unlinked pictures and videos.
  function sigOf(n) {
    const out = [];
    for (let p = n.parentElement, i = 0; p && p.nodeType === 1 && i < 3; p = p.parentElement, i++) {
      out.push(p.tagName + '.' + (p.classList[0] || '').replace(/\d+/g, '#'));
    }
    return out.join('<');
  }

  // Every picture and video in `doc` that could be gallery material, in document order.
  // `live` is the page on screen (it has a layout to measure); a fetched page has none.
  function scan(doc, base, live) {
    const items = [], taken = new Set();
    const add = (node, it) => {
      if (!it.src || taken.has(node)) return;
      taken.add(node);
      items.push({ node, sig: sigOf(node), ...it });
    };
    const size = (n) => {
      const r = live ? n.getBoundingClientRect() : { width: 0, height: 0 };
      const w = n.naturalWidth || n.videoWidth || +n.getAttribute('width') || r.width || 0;
      const h = n.naturalHeight || n.videoHeight || +n.getAttribute('height') || r.height || 0;
      return { w, h, shown: Math.min(r.width, r.height) };
    };
    const tiny = (d) => (d.w && d.h && Math.min(d.w, d.h) < 90) || (d.shown && d.shown < 60);   // icons, avatars, spacers
    const linkOf = (n) => { const a = n.closest('a[href]'); return a ? [a, abs(a.getAttribute('href'), base)] : [null, '']; };

    for (const n of doc.querySelectorAll('img')) {
      if (n.closest(PAGE_CHROME)) continue;
      const d = size(n);
      if (tiny(d)) continue;
      const lazy = LAZY_ATTRS.map((k) => n.getAttribute(k)).find(Boolean);
      const big = biggestInSrcset(n.getAttribute('srcset') || n.getAttribute('data-srcset'), base);
      const thumb = abs(lazy || n.currentSrc || n.getAttribute('src') || '', base) || big;
      const [a, href] = linkOf(n);
      const direct = IMG_EXT.test(href) || VID_EXT.test(href) ? href : '';
      const preview = direct ? '' : previewOf(n, a, base);
      const src = direct || preview || big || unsized(thumb);
      if (!src || /\.svg(?:[?#]|$)/i.test(src)) continue;
      const video = VID_EXT.test(src);
      add(a || n, {
        type: video ? 'video' : 'image', src, thumb: thumb || (video ? '' : src), w: d.w, h: d.h, known: !!(d.w && d.h),
        link: direct ? '' : href, tile: preview, animated: GIF_EXT.test(src), gif: GIF_EXT.test(src),
        title: n.getAttribute('alt') || n.getAttribute('title') || a?.getAttribute('title') || a?.getAttribute('aria-label') || '',
      });
    }

    for (const n of doc.querySelectorAll('video')) {
      if (n.closest(PAGE_CHROME)) continue;
      const d = size(n);
      if (d.shown && d.shown < 60) continue;
      const src = abs(n.currentSrc || n.getAttribute('src') || n.querySelector('source[src]')?.getAttribute('src') || '', base);
      const poster = abs(n.getAttribute('poster') || '', base);
      const [, href] = linkOf(n);
      const title = n.getAttribute('title') || n.getAttribute('aria-label') || '';
      if (src) add(n, { type: 'video', src, thumb: poster, w: d.w, h: d.h, known: !!(d.w && d.h), link: href, title });
      // A streamed video has no file to play here (its address is a blob:), only its poster.
      else if (poster) add(n, { type: 'image', src: poster, thumb: poster, w: d.w, h: d.h, known: !!(d.w && d.h), link: href || base, external: true, title });
    }

    // Links straight to a media file whose thumbnail is a CSS background, not an <img>.
    for (const a of doc.querySelectorAll(A_MEDIA)) {
      if (a.closest(PAGE_CHROME) || a.querySelector('img,video')) continue;
      const href = abs(a.getAttribute('href'), base);
      const video = VID_EXT.test(href);
      if (!video && !IMG_EXT.test(href)) continue;
      const styled = a.matches('[style*="background-image"]') ? a : a.querySelector('[style*="background-image"]');
      const bg = /url\(["']?([^"')]+)/.exec(styled?.getAttribute('style') || '')?.[1];
      const d = size(a);
      if (!bg && !(d.shown >= 60)) continue;         // a text link, not a tile
      add(a, {
        type: video ? 'video' : 'image', src: href, thumb: bg ? abs(bg, base) : (video ? '' : href), w: d.w, h: d.h, known: !!(d.w && d.h),
        link: '', animated: GIF_EXT.test(href), gif: GIF_EXT.test(href), title: a.getAttribute('title') || a.textContent.trim().slice(0, 120),
      });
    }

    items.sort((x, y) => (x.node.compareDocumentPosition(y.node) & 2 ? 1 : -1));   // 2: y comes first
    const groups = new Map();
    for (const c of items) groups.set(c.sig, (groups.get(c.sig) || 0) + 1);
    return { items, groups, top: Math.max(0, ...groups.values()) };
  }

  // The candidates that belong to the page's media grid. `sigs` collects the grid's
  // signatures, so later scans and fetched pages recognise more of the same.
  function pickGrid(found, sigs = new Set()) {
    if (found.top >= 6) for (const [sig, n] of found.groups) if (n >= 4) sigs.add(sig);
    const grid = found.items.filter((c) => sigs.has(c.sig));
    // No repeating structure: the large pictures (an article's photos, a single-image page).
    return grid.length ? grid : found.items.filter((c) => c.known && Math.min(c.w, c.h) >= 200);
  }

  // </web>

  // main() is the gallery itself: the shared base, then one plugin per kind of site. It is
  // only run when it is needed: at once on Reddit, and on other sites when the page is
  // remembered, has a media grid, or you ask. (Its body is not indented a second level.)
  function main() {
  const SITES = {};                // filled in by the plugin sections further down
  /* ------------------------------------------------------------------ *
   *  Update check: on entering gallery mode, ask the update URL what
   *  version it is serving and offer it if it is newer than this one.
   * ------------------------------------------------------------------ */
  const INFO = typeof GM_info !== 'undefined' ? GM_info : {};
  const metaKey = (text, key) => new RegExp(`^//\\s*@${key}\\s+(\\S+)`, 'm').exec(text || '')?.[1];
  const UPDATE_URL = metaKey(INFO.scriptMetaStr, 'updateURL') || metaKey(INFO.scriptMetaStr, 'downloadURL') || '';
  const CHECK_MS = 15 * 60 * 1000;     // at most one request this often
  const VERSION = INFO.script?.version || '0';
  // Under the loader (WebGalleryView.user.js) this is the gallery's version, and INFO.loader the loader's.
  const ABOUT = `Web Gallery View ${VERSION}` + (INFO.loader ? ` (loader ${INFO.loader})` : '');

  const newerThan = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  };

  const openUpdate = () => { try { window.open(UPDATE_URL, '_blank', 'noopener'); } catch { /* ignore */ } };

  // A newer version is offered in a small bar at the top of the page, wherever the gallery
  // or its button is present. Nothing opens until you ask; "Later" hides the bar for that
  // version, and the header button stays.
  function offerUpdate(v) {
    const b = $('#update');
    b.textContent = `Update to ${v}`;
    b.hidden = false;
    store.set('newVersion', v);                      // so the next page can offer it without asking the server
    if (store.get('offered', '') === v || $('.upd')) return;
    const bar = el('div', 'upd'), go = el('button', 'go', 'Update'), no = el('button', 'no', 'Later');
    bar.setAttribute('role', 'status');
    bar.append(el('span', '', `Gallery View ${v} is available`), go, no);
    go.onclick = () => { bar.remove(); openUpdate(); };
    no.onclick = () => { bar.remove(); store.set('offered', v); };
    root.append(bar);                                // after .app, so it shows over an open gallery too
  }

  function checkUpdate(force) {
    if (!UPDATE_URL || typeof GM_xmlhttpRequest !== 'function') return;
    const now = Date.now();
    if (!force && now - store.get('lastCheck', 0) < CHECK_MS) return;
    store.set('lastCheck', now);
    try {
      GM_xmlhttpRequest({
        method: 'GET',
        url: UPDATE_URL + '?t=' + now,
        headers: { 'Cache-Control': 'no-cache' },
        timeout: 8000,
        onload: (r) => {
          const v = metaKey(r.responseText, 'version');
          if (v && newerThan(v, VERSION)) offerUpdate(v);
        },
      });
    } catch { /* the server is not reachable from here */ }
  }

  // Which item the lightbox was showing on each page, so a reload picks it up again.
  const tabFocus = (() => {
    const KEY = 'rg:gallery-focus';
    let mem = {};
    const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch { return mem; } };
    const write = (o) => { mem = o; try { sessionStorage.setItem(KEY, JSON.stringify(o)); } catch { /* ignore */ } };
    return {
      get: (k) => read()[k] || null,
      set(k, v) {
        const o = read();
        delete o[k];                                   // re-insert so the oldest entry is dropped first
        o[k] = v;
        for (const old of Object.keys(o).slice(0, -50)) delete o[old];
        write(o);
      },
      del(k) { const o = read(); if (k in o) { delete o[k]; write(o); } },
    };
  })();

  const SORTS = ['hot', 'new', 'top', 'rising', 'controversial', 'best'];

  /* ------------------------------------------------------------------ *
   *  State
   * ------------------------------------------------------------------ */
  const S = {
    path: '',                       // e.g. "/r/pics/top" or "/user/me/m/myfeed"; '' = front page
    query: new URLSearchParams(),
    after: null,
    loading: false,
    done: false,
    gen: 0,                         // bumps on every reset so stale fetches are ignored
    seen: new Set(),
    media: new Set(),               // signatures of the media already shown, so reposts appear once
    dupes: 0,
    all: [],                        // every post that has media, before the type filter is applied
    tiles: [],
    slides: [],                     // flat list of every viewable item (galleries expand here)
    emptyStreak: 0,
    href: null,
    restore: null,                  // { id, pos } the lightbox should reopen on after a reload
    restoreTries: 0,
  };
  let colN = 0;      // current column count
  let colW = 0;      // current column width in px
  let colH = [];     // running height of each column
  let lbIdx = -1;
  let galleryTimer = null;
  let scoreEl = null;   // the score between the vote arrows in the lightbox

  /* ------------------------------------------------------------------ *
   *  Small helpers
   * ------------------------------------------------------------------ */
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // r/… and u/… load that feed in the gallery; a modified click opens it on Reddit instead.
  function goFeed(src) {
    if (lb.classList.contains('open')) closeLb();
    goSource(src);
  }
  function feedSpan(text, src, inTile) {
    const n = el(inTile ? 'span' : 'a', 'go', text);
    if (!inTile) {
      n.href = location.origin + '/' + src;
      n.target = '_blank';
      n.rel = 'noopener noreferrer';
    }
    n.title = 'Show ' + text + ' in the gallery';
    n.setAttribute('role', 'link');
    n.addEventListener('click', (e) => {
      if (e.button || e.ctrlKey || e.metaKey || e.shiftKey) return;   // let it open on Reddit
      e.preventDefault();
      e.stopPropagation();
      goFeed(src);
    });
    return n;
  }
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n ?? 0));
  const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;

  function ago(sec) {
    const m = (Date.now() / 1000 - sec) / 60;
    return m < 60 ? Math.max(1, m | 0) + 'm' : m < 1440 ? ((m / 60) | 0) + 'h' : m < 43200 ? ((m / 1440) | 0) + 'd'
      : m < 525600 ? ((m / 43200) | 0) + 'mo' : ((m / 525600) | 0) + 'y';
  }

  // Award icons (up to five) and the total; null when the post or comment has none.
  function awardsEl(d) {
    const list = (d.all_awardings || []).filter((a) => a.count > 0);
    const total = d.total_awards_received || list.reduce((s, a) => s + a.count, 0);
    if (!total) return null;
    const wrap = el('span', 'awards');
    wrap.title = list.length ? list.map((a) => a.name + (a.count > 1 ? ' ×' + a.count : '')).join(', ') : `${total} awards`;
    for (const a of list.slice(0, 5)) {
      const src = (a.resized_icons || []).find((r) => r.width >= 32)?.url || a.icon_url;
      if (!src) continue;
      const i = new Image();
      i.referrerPolicy = site.referrer;
      i.alt = a.name || '';
      i.loading = 'lazy';
      i.src = src;
      wrap.append(i);
    }
    wrap.append(el('span', '', list.length ? String(total) : `🏆 ${total}`));
    return wrap;
  }

  // Reddit's comment HTML, rebuilt from an allowlist: no attributes survive except a safe href.
  const KEEP_TAGS = /^(A|P|BR|HR|EM|STRONG|B|I|DEL|S|SUP|SUB|CODE|PRE|BLOCKQUOTE|UL|OL|LI|H[1-6]|TABLE|THEAD|TBODY|TR|TH|TD)$/;
  const DROP_TAGS = /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|TEMPLATE|NOSCRIPT|SVG|MATH|FORM|INPUT|BUTTON|SELECT|TEXTAREA)$/;
  function cleanHtml(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const out = document.createDocumentFragment();
    const copy = (from, to) => {
      for (const n of from.childNodes) {
        if (n.nodeType === 3) { to.append(n.textContent); continue; }
        if (n.nodeType !== 1 || DROP_TAGS.test(n.tagName)) continue;
        if (!KEEP_TAGS.test(n.tagName)) { copy(n, to); continue; }   // unwrap, keep the text
        const e = document.createElement(n.tagName);
        if (n.tagName === 'A') {
          try {
            const u = new URL(n.getAttribute('href') || '', location.origin);
            if (/^https?:$/.test(u.protocol)) Object.assign(e, { href: u.href, target: '_blank', rel: 'noopener noreferrer' });
          } catch { /* left as plain text */ }
        }
        copy(n, e);
        to.append(e);
      }
    };
    copy(doc.body, out);
    return out;
  }

  // A repost or crosspost carries the same file, so the address (without its query string)
  // identifies it. A re-upload of the same picture gets a new address and is not caught.
  function mediaKey(items) {
    return items.map((it) => {
      let u = it.src || '';
      try { const p = new URL(u); u = p.host.replace(/^www\./, '') + p.pathname; } catch { /* keep as is */ }
      return u.toLowerCase().replace(/\.(jpe?g|png|webp|avif|gifv?|mp4)$/, '');
    }).sort().join('|');
  }

  /* ------------------------------------------------------------------ *
   *  DOM: shadow root so Reddit's CSS can't touch us
   * ------------------------------------------------------------------ */
  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
[hidden]{display:none!important}
.app:not(.reddit) .rd{display:none!important}
button,select,input{font:inherit;color:inherit}
.fab,.app{z-index:2147483647}
.fab{position:fixed;left:50%;top:0;translate:-50% 0;font:600 13px/1 "Avenir Next","Segoe UI Variable",system-ui,sans-serif;color:#1c1d20;background:#e9b44c;border:0;border-radius:0 0 14px 14px;padding:7px 18px 9px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35);opacity:.92;transition:opacity .15s,padding .15s;touch-action:none;user-select:none;-webkit-user-select:none}
.fab:hover{opacity:1;padding-top:10px}
.fab.free{border-radius:999px;padding:10px 16px;box-shadow:0 6px 22px rgba(0,0,0,.4)}
.fab.drag{cursor:grabbing;transition:none;opacity:1}
.upd{position:fixed;z-index:2147483647;top:44px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:calc(100vw - 24px);padding:7px 7px 7px 16px;border-radius:999px;background:#1f2024;color:#ece9e3;border:1px solid #393c42;box-shadow:0 10px 30px rgba(0,0,0,.5);font:13px/1.3 "Avenir Next","Segoe UI Variable",system-ui,sans-serif;white-space:nowrap;color-scheme:dark}
.upd span{overflow:hidden;text-overflow:ellipsis}
.upd button{height:30px;padding:0 14px;border-radius:999px;cursor:pointer;font:inherit}
.upd .go{background:#e9b44c;color:#1c1d20;border:0;font-weight:600}
.upd .no{background:transparent;color:#9a9ca3;border:1px solid #393c42}
.app{--bg:#17181b;--panel:#1f2024;--ctl:#2a2c31;--ctl-h:#34373d;--line:#393c42;--text:#ece9e3;--mute:#9a9ca3;--faint:#6c6f76;--acc:#e9b44c;--acc-ink:#1c1d20;
  position:fixed;inset:0;display:none;flex-direction:column;background:var(--bg);color:var(--text);color-scheme:dark;font:14px/1.4 "Avenir Next","Segoe UI Variable",system-ui,sans-serif}
.app.open{display:flex}

header{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:10px 16px;background:var(--panel);border-bottom:1px solid #2b2d32;box-shadow:0 1px 12px rgba(0,0,0,.25);position:relative;z-index:1}
.bar-up header{padding-block:6px}
.bar-up header>*:not(.keep){display:none}
.brand small{font-size:10.5px;font-weight:500;letter-spacing:.02em;color:var(--faint)}
.brand{display:inline-flex;align-items:center;gap:8px;font-weight:700;letter-spacing:.01em;color:var(--acc);white-space:nowrap}
.brand i{width:16px;height:16px;background:
  linear-gradient(var(--acc) 0 0) 0 0/7px 7px no-repeat,linear-gradient(var(--acc) 0 0) 9px 0/7px 10px no-repeat,
  linear-gradient(var(--acc) 0 0) 0 9px/7px 7px no-repeat,linear-gradient(var(--acc) 0 0) 9px 12px/7px 4px no-repeat;opacity:.9}
.gr{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
#gFeed{flex:1 1 420px;min-width:0}
.joined{display:flex;flex:1 1 220px;min-width:0}
#src{flex:1;min-width:0;border-radius:8px 0 0 8px}
.joined button{border-radius:0 8px 8px 0;margin-left:-1px}
.end{display:flex;align-items:center;gap:8px;margin-left:auto}
.dim{color:var(--mute);font-size:12px;white-space:nowrap;margin-right:4px}
.opts{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;padding-top:10px;border-top:1px solid #2b2d32}
.group{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.gh{font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-right:4px;white-space:nowrap}

input[type=text],select,button{height:32px;background:var(--ctl);border:1px solid var(--line);border-radius:8px;padding:0 12px;outline:none;transition:background .15s,border-color .15s,color .15s}
input[type=text]{color:var(--text)}
input[type=text]::placeholder{color:var(--faint)}
select{appearance:none;-webkit-appearance:none;padding-right:28px;cursor:pointer;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%239a9ca3' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 10px center}
select:hover{background-color:var(--ctl-h)}
option{background:var(--panel);color:var(--text)}
input[type=text]:focus,select:focus-visible,button:focus-visible{border-color:var(--acc);box-shadow:0 0 0 3px rgba(233,180,76,.18)}
button{cursor:pointer;white-space:nowrap}
button:hover{background:var(--ctl-h)}
button.primary,#mute.on,.toolbar button.on{background:var(--acc);border-color:var(--acc);color:var(--acc-ink);font-weight:600}
button.primary:hover,#mute.on:hover,.toolbar button.on:hover{background:#f0c266}
button.icon{width:32px;padding:0;font-size:11px;color:var(--mute)}
label{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:#c9c7c1;white-space:nowrap}
input[type=range],input[type=checkbox]{accent-color:var(--acc)}

.chip{height:32px;padding:0 12px;border:1px solid var(--line);border-radius:999px;background:var(--ctl);font-size:12.5px;cursor:pointer;user-select:none;transition:background .15s,border-color .15s,color .15s}
.chip:hover{background:var(--ctl-h)}
label.chip:has(>input[type=checkbox]){position:relative;padding-left:11px}
label.chip>input[type=checkbox]{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
label.chip:has(>input[type=checkbox])::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:#4a4d54;transition:background .15s,box-shadow .15s}
label.chip:has(>input:checked){border-color:rgba(233,180,76,.45);background:rgba(233,180,76,.1);color:#f4e4c1}
label.chip:has(>input:checked)::before{background:var(--acc);box-shadow:0 0 6px rgba(233,180,76,.7)}
label.chip:has(>input:focus-visible){border-color:var(--acc);box-shadow:0 0 0 3px rgba(233,180,76,.18)}
.chip select{height:24px;margin-right:-8px;padding:0 24px 0 9px;border-radius:999px;font-size:12px;background-color:rgba(0,0,0,.22);border-color:transparent;background-position:right 8px center}
button.chip{font-weight:500}

.scroller{flex:1;overflow-y:scroll;padding:10px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#3a3d43 transparent}
.grid{position:relative}
.tile{position:absolute;display:block;overflow:hidden;border-radius:8px;background:#232529;cursor:zoom-in;color:inherit;text-decoration:none;contain:strict}
.tile::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);pointer-events:none;transition:box-shadow .15s}
.tile:hover::after,.tile:focus-visible::after{box-shadow:inset 0 0 0 2px rgba(233,180,76,.85)}
.tile:focus-visible{outline:none}
.tile img,.tile video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:transform .35s ease,filter .2s}
.tile:hover img{transform:scale(1.03)}
.tile .meta{position:absolute;left:0;right:0;bottom:0;padding:44px 12px 10px;background:linear-gradient(transparent,rgba(0,0,0,.45) 40%,rgba(0,0,0,.85));font-size:12px;opacity:0;transform:translateY(4px);transition:opacity .18s,transform .18s;pointer-events:none}
.tile:hover .meta,.tile:focus-visible .meta{opacity:1;transform:none}
.meta b{display:block;margin-bottom:3px;font-size:13px;font-weight:600;line-height:1.3;color:#fff;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.meta span{margin-right:10px;color:rgba(255,255,255,.72)}
.meta .go{pointer-events:auto;cursor:pointer}
.meta .go:hover{color:var(--acc);text-decoration:underline}
.cap .row a.go:hover{color:var(--acc)}
.badge{position:absolute;top:8px;right:8px;padding:3px 8px;border-radius:999px;background:rgba(14,14,16,.74);color:#f3f1ec;font-size:10.5px;font-weight:700;letter-spacing:.04em;line-height:1.3}
.tnav{position:absolute;top:50%;transform:translateY(-50%);width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(14,14,16,.7);color:#f3f1ec;font-size:22px;line-height:1;padding-bottom:2px;cursor:pointer;opacity:0;transition:opacity .15s,background .15s;user-select:none}
.tnav:hover{background:var(--acc);color:var(--acc-ink)}
.tprev{left:8px}
.tnext{right:8px}
.tile:hover .tnav{opacity:1}
@media (hover:none){.tnav{opacity:.85}}
.seek{position:absolute;z-index:1;left:0;right:0;bottom:0;height:18px;cursor:pointer;opacity:0;transition:opacity .15s;touch-action:none}
.seek::before,.seek i{position:absolute;left:0;bottom:0;height:4px;transition:height .12s}
.seek::before{content:"";right:0;background:rgba(255,255,255,.28)}
.seek i{width:100%;transform:scaleX(0);transform-origin:0 0;background:var(--acc);box-shadow:0 0 6px rgba(233,180,76,.6)}
.seek:hover::before,.seek:hover i{height:7px}
.tile.seekable:hover .seek{opacity:1}
.tile.seekable .meta{padding-bottom:16px}
.blur .tile.nsfw img,.blur .tile.nsfw video{filter:blur(22px)}
.blur .tile.nsfw:hover img,.blur .tile.nsfw:hover video{filter:none}
.status{padding:28px;text-align:center;color:var(--mute);font-size:13px}
.status.err{color:#f0907a;cursor:pointer}
.status.err:hover{text-decoration:underline}

.lb{position:absolute;inset:0;z-index:2;background:#0c0c0e;display:none;flex-direction:column;overflow:hidden}
.amb{position:absolute;z-index:-1;inset:-12%;background:var(--amb,none) center/cover no-repeat;filter:blur(70px) saturate(1.6) brightness(.38);pointer-events:none}
.amb::after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 30%,rgba(8,8,10,.55))}
.lb.open{display:flex}
.stage{position:relative;flex:1;min-height:0;display:flex;padding:8px 84px;overflow:auto}
.stage>img,.stage>video{margin:auto;max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 24px 70px rgba(0,0,0,.55);transform-origin:0 0}
.stage.fit-width>img,.stage.fit-width>video{width:100%;height:auto;max-height:none}
.stage.fit-actual>img,.stage.fit-actual>video{max-width:none;max-height:none}
.stage.fit-fit>img,.stage.fit-fit>video{width:100%;height:100%;max-width:none;max-height:none;object-fit:contain;box-shadow:none}
.stage.fit-fill{padding:0;overflow:hidden}
.stage.fit-fill>img,.stage.fit-fill>video{width:100%;height:100%;max-width:none;max-height:none;object-fit:cover;border-radius:0;box-shadow:none}
.stage.zoomed{overflow:hidden;cursor:grab;touch-action:none}
.stage.zoomed.panning{cursor:grabbing}
.stage.sliding{overflow:hidden}
.stage>.ghost{position:absolute;margin:0;max-width:none;max-height:none;pointer-events:none}
.stage>.in-next{animation:rg-in-next .28s ease-out}
.stage>.in-prev{animation:rg-in-prev .28s ease-out}
.stage>.out-next{animation:rg-out-next .28s ease-out forwards}
.stage>.out-prev{animation:rg-out-prev .28s ease-out forwards}
@keyframes rg-in-next{from{translate:60vw 0;opacity:0}}
@keyframes rg-in-prev{from{translate:-60vw 0;opacity:0}}
@keyframes rg-out-next{to{translate:-60vw 0;opacity:0}}
@keyframes rg-out-prev{to{translate:60vw 0;opacity:0}}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:10px 12px;padding:14px 16px 10px}
.toolbar .group{flex-wrap:nowrap}
.toolbar select,.toolbar button{height:34px;border-color:rgba(255,255,255,.07);background-color:rgba(255,255,255,.07);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.toolbar select{border-radius:999px;padding-left:14px}
.toolbar select:hover,.toolbar button:hover{background-color:rgba(255,255,255,.14)}
.toolbar .tbi{width:34px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#cfccc6}
.toolbar .tbi svg,.lbclose svg{width:18px;height:18px;fill:currentColor}
.toolbar .tbi.on{color:var(--acc);background:rgba(233,180,76,.14);border-color:rgba(233,180,76,.35);font-weight:400}
.toolbar .tbi.on:hover{background:rgba(233,180,76,.22)}
.toolbar .tbi.none,.toolbar .tbi.none:hover{opacity:.35;cursor:not-allowed;background-color:rgba(255,255,255,.04);color:#cfccc6}
.toolbar .lbclose{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:0 16px 0 13px;font-weight:600}
.lbclose svg{width:15px;height:15px}
.cap{flex:1 1 260px;min-width:0;text-align:left;font-size:12.5px;color:var(--mute);overflow:hidden}
.cap a{color:var(--text);text-decoration:none}
.cap>a{font-size:16px;font-weight:650;line-height:1.35;text-shadow:0 1px 8px rgba(0,0,0,.5)}
.cap a:hover{text-decoration:underline}
.cap>a,.cap .row{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cap .row{margin-top:3px}
.cap .row>*{color:var(--mute);font-weight:400}
.cap .row>*+*::before{content:"·";display:inline-block;margin:0 8px;color:#4c4f55}
.nav{position:absolute;z-index:1;top:50%;transform:translateY(-50%);width:52px;height:52px;padding:0 0 4px;display:flex;align-items:center;justify-content:center;border-radius:50%;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.06);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:#f3f1ec;font-size:32px;line-height:1;cursor:pointer;opacity:.75}
.nav:hover{opacity:1;background:rgba(255,255,255,.14)}
.prev{left:16px}.next{right:16px}
.nav.in{border-color:rgba(233,180,76,.55);color:var(--acc)}
.nav.in::after{content:attr(data-n);position:absolute;top:100%;margin-top:7px;font-size:11px;font-weight:600;letter-spacing:.03em;line-height:1;white-space:nowrap;color:var(--acc);text-shadow:0 1px 3px rgba(0,0,0,.8)}
.nav.end,.nav.end:hover{opacity:.2;background:rgba(255,255,255,.06);cursor:default}
.toolbar,.cap,.nav{transition:opacity .25s,background .15s}
.lb.idle{cursor:none}
.lb.idle .toolbar,.lb.idle .postbar,.lb.idle .cap,.lb.idle .nav{opacity:0;pointer-events:none}
.sep{width:1px;height:22px;align-self:center;background:var(--line)}
.postbar{display:flex;align-items:center;flex-wrap:wrap;justify-content:center;gap:4px;width:fit-content;max-width:calc(100% - 24px);margin:6px auto 16px;padding:5px;border-radius:999px;background:rgba(28,29,33,.72);border:1px solid rgba(255,255,255,.08);box-shadow:0 10px 30px rgba(0,0,0,.4);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);transition:opacity .25s}
.acts,.menu{display:flex;align-items:center;flex-wrap:wrap;gap:2px}
.menu{padding-left:6px;margin-left:2px;border-left:1px solid rgba(255,255,255,.1)}
.menu .pa{width:36px;padding:0;justify-content:center}
.menu .pa .t{display:none}
.pa{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 13px;border-radius:999px;background:transparent;border:1px solid transparent;color:#b4b6bc;transition:background .15s,color .15s,border-color .15s}
.pa:hover,.pa:focus-visible{color:var(--text);background:rgba(255,255,255,.1)}
.pa svg{width:16px;height:16px;display:block;fill:currentColor}
.pa .t{white-space:nowrap;font-size:12.5px}
.pa.on{color:var(--acc);border-color:rgba(233,180,76,.35);background:rgba(233,180,76,.1)}
.pa.down.on{color:#7fb2f0;border-color:rgba(127,178,240,.35);background:rgba(127,178,240,.1)}
.pa.busy{opacity:.6}
.votes{display:inline-flex;align-items:center;margin-right:2px;border-radius:999px;background:rgba(255,255,255,.07)}
.votes .pa{padding:0 10px;border:0}
.votes .pa .t{display:none}
.votes .pa.on{background:transparent}
.score{min-width:34px;padding:0 2px;text-align:center;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text);cursor:default}
.score.up{color:var(--acc)}
.score.down{color:#7fb2f0}
.awards{display:inline-flex;align-items:center;gap:3px;vertical-align:middle}
.awards img{width:16px;height:16px;object-fit:contain}
.awards span{margin-left:2px;font-size:11.5px;color:#e8c77a}
.meta .awards{margin-top:4px}
.tile .meta .awards img{position:static;width:14px;height:14px;transform:none;filter:none;transition:none}
.meta .awards span{margin:0 0 0 2px}
.lb.cmt{padding-right:min(440px,42vw)}
.lb.cmt .next{right:calc(min(440px,42vw) + 16px)}
.cmts{position:absolute;z-index:3;top:0;right:0;bottom:0;width:min(440px,42vw);display:flex;flex-direction:column;background:var(--panel);border-left:1px solid #2b2d32;box-shadow:-12px 0 40px rgba(0,0,0,.45);animation:rg-drawer .22s ease-out}
@keyframes rg-drawer{from{translate:40px 0;opacity:0}}
.cmh{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #2b2d32}
.cmh b{flex:1;font-size:14px}
.cmh a{color:var(--mute);font-size:12.5px;text-decoration:none;white-space:nowrap}
.cmh a:hover{color:var(--acc)}
.cml{flex:1;overflow-y:auto;padding:6px 14px 24px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#3a3d43 transparent}
.cnote{padding:24px 4px;color:var(--mute);font-size:13px;text-align:center}
.cnote.err{color:#f0907a;cursor:pointer}
.cm{margin-top:12px;font-size:13.5px;line-height:1.5}
.ckids{margin:2px 0 0 4px;padding-left:12px;border-left:2px solid #2e3035}
.ckids:hover{border-left-color:#3d4047}
.chd{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:12px;color:var(--faint);cursor:pointer;user-select:none}
.cau{color:#cfccc6;font-weight:600;text-decoration:none}
.cau:hover{color:var(--acc)}
.cau.op{color:var(--acc)}
.cau.op::after{content:" OP";font-size:10px;font-weight:700}
.chd .pin{color:#7fd08a}
.cbd{margin-top:3px;color:#dedbd5;overflow-wrap:anywhere}
.cbd p{margin:0 0 6px}
.cbd a{color:#e9c27a}
.cbd blockquote{margin:4px 0;padding-left:10px;border-left:3px solid #44474e;color:var(--mute)}
.cbd code{padding:1px 4px;border-radius:4px;background:#2a2c31;font-size:12.5px}
.cbd pre{overflow-x:auto;padding:8px;border-radius:6px;background:#26282d}
.cbd pre code{padding:0;background:none}
.cbd ul,.cbd ol{margin:0 0 6px;padding-left:22px}
.cbd table{border-collapse:collapse;margin:4px 0}
.cbd th,.cbd td{border:1px solid #393c42;padding:3px 6px}
.cm.folded>.cbd,.cm.folded>.ckids{display:none}
.cm.folded>.chd::before{content:"+";color:var(--acc);font-weight:700}
.cmore{display:inline-block;margin-top:8px;font-size:12px;color:#e9c27a;text-decoration:none}
.cmore:hover{text-decoration:underline}
.panel{position:absolute;top:64px;left:50%;transform:translateX(-50%);z-index:5;display:grid;gap:10px;width:min(360px,calc(100% - 32px));padding:16px;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.6);transition:opacity .25s}
.panel .head{font-size:13px;font-weight:600;color:var(--text)}
.panel .buttons{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}
#reportSend{background:#d9634c;border-color:#d9634c;color:#fff;font-weight:600}
.lb.idle .panel{opacity:0;pointer-events:none}
.toast{position:absolute;left:50%;bottom:80px;transform:translate(-50%,6px);background:rgba(31,32,36,.96);border:1px solid var(--line);border-radius:999px;padding:9px 18px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}
.toast.show{opacity:1;transform:translate(-50%,0)}

@media (max-width:700px){
  header{padding:8px 10px;gap:8px}
  #gFeed{flex-basis:100%}
  .end{margin-left:0}
  .opts{gap:8px 14px}
  .scroller{padding:6px}
  .stage{padding:4px 8px}
  .nav{width:40px;height:40px;font-size:26px}
  .prev{left:6px}.next{right:6px}
  .pa .t{display:none}
  .pa{width:36px;padding:0;justify-content:center}
  .votes .pa{width:auto;padding:0 10px}
  .toolbar .lbclose span{display:none}
  .toolbar .lbclose{width:34px;padding:0;justify-content:center}
  .postbar{margin-bottom:10px;border-radius:22px}
  .menu{border-left:0;padding-left:0;margin-left:0}
  .lb.cmt{padding-right:0}
  .lb.cmt .next{right:6px}
  .cmts{width:100%}
}
`;

  const ICON = {
    up: '<path d="M12 3l9 10h-5.5v8h-7v-8H3z"/>',
    down: '<path d="M12 21L3 11h5.5V3h7v8H21z"/>',
    comment: '<path d="M4 3h16a2 2 0 012 2v10a2 2 0 01-2 2H9.5L4 21V3z"/>',
    share: '<path d="M14 3v4C7.5 7.6 4 12.2 3 20c2.6-3.8 6.2-5.4 11-5.4V19l7-8z"/>',
    repost: '<path d="M7 7h9v3l5-4.5L16 1v3H5v7h2V7zm10 10H8v-3l-5 4.5L8 23v-3h11v-7h-2v4z"/>',
    follow: '<path d="M12 22a2.2 2.2 0 002.2-2h-4.4A2.2 2.2 0 0012 22zm6.5-6.3V11a6.5 6.5 0 10-13 0v4.7L3.6 18v1h16.8v-1z"/>',
    save: '<path d="M6 2h12a1 1 0 011 1v19l-7-4.2L5 22V3a1 1 0 011-1z"/>',
    hide: '<path d="M12 5.5c5.4 0 9.6 6.5 9.6 6.5s-1.3 2-3.6 3.7l-2.3-2.3A3.8 3.8 0 0012 8.2c-.4 0-.8 0-1.2.2L9 6.6c1-.7 1.9-1.1 3-1.1zM3.1 3.5l17.4 17.4-1.6 1.6-2.9-2.9c-1.3.4-2.6.6-4 .6-5.4 0-9.6-6.5-9.6-6.5.7-1.2 1.9-2.8 3.5-4.2L1.5 5.1z"/>',
    report: '<path d="M5 2v20H3V2h2zm2 1.2h13.5l-3.2 4.6 3.2 4.6H7V3.2z"/>',
  };

  // Post buttons offered in the lightbox toolbar. "state" ones light up when active.
  const ACTIONS = [
    { key: 'upvote', label: 'Upvote', on: 'Upvoted', icon: ICON.up },
    { key: 'downvote', label: 'Downvote', on: 'Downvoted', icon: ICON.down, cls: 'down' },
    { key: 'comment', label: 'Comments', icon: ICON.comment },
    { key: 'share', label: 'Copy link', icon: ICON.share },
    { key: 'repost', label: 'Crosspost', icon: ICON.repost, menu: true },
    { key: 'follow', label: 'Follow post', on: 'Following', icon: ICON.follow, menu: true },
    { key: 'save', label: 'Save', on: 'Saved', icon: ICON.save, menu: true },
    { key: 'hide', label: 'Hide', on: 'Hidden', icon: ICON.hide, menu: true },
    { key: 'report', label: 'Report', on: 'Reported', icon: ICON.report, menu: true },
  ];

  const REPORT_REASONS = [
    'spam', 'vote manipulation', 'personal information', 'sexualizing minors',
    'harassment', 'threatening violence', 'hate', 'copyright', 'breaking reddit', 'other',
  ];

  const host = document.createElement('div');
  host.id = 'wg-host';
  const root = host.attachShadow({ mode: 'open' });
  setHTML(root, `
<button class="fab" title="Open gallery (Alt+G). Drag to move it.">Gallery</button>
<div class="app">
  <header>
    <span class="brand keep"><i></i>Gallery<small id="ver"></small></span>
    <div class="gr rd" id="gFeed">
      <span class="joined">
        <input id="src" type="text" spellcheck="false" placeholder="r/pics+aww, user/name/m/feed, or a reddit URL">
        <button id="go" class="primary">Load</button>
      </span>
      <select id="feeds" title="Your saved feeds"></select>
      <button id="saveFeed" title="Save the current feed">Save</button>
      <button id="delFeed" title="Delete the selected saved feed">Delete</button>
      <button id="refresh" title="Reload the page (shift-click to fetch the listing again without reloading)">Refresh</button>
    </div>
    <div class="gr">
      <select id="sort" class="rd" title="Sort">
        <option value="">default order</option><option>hot</option><option>new</option>
        <option>top</option><option>rising</option><option>controversial</option>
      </select>
      <select id="time" class="rd" title="Time range" hidden>
        <option value="hour">past hour</option><option value="day">past day</option>
        <option value="week">past week</option><option value="month">past month</option>
        <option value="year">past year</option><option value="all">all time</option>
      </select>
      <select id="filter" title="Media type">
        <option value="all">all media</option><option value="videos">videos</option>
        <option value="animated">animated</option><option value="gifs">gifs</option><option value="pictures">pictures</option>
      </select>
    </div>
    <div class="end keep">
      <span id="count" class="dim"></span>
      <button id="update" class="primary" title="A newer version is available. Opens it so your userscript manager can install it." hidden></button>
      <button id="close" title="Leave gallery view and go back to the page (Esc)">Exit gallery</button>
      <button id="barToggle" class="icon" aria-expanded="true"></button>
    </div>
    <div class="opts">
      <div class="group">
        <span class="gh">Grid</span>
        <label class="chip">Columns <select id="cols" title="Number of columns"></select></label>
        <label class="chip"><input id="wide" type="checkbox">Widen landscape</label>
        <label class="chip rd"><input id="nsfw" type="checkbox">Blur NSFW</label>
        <label class="chip rd"><input id="prev" type="checkbox">Link previews</label>
      </div>
      <div class="group">
        <span class="gh">Playback</span>
        <button id="mute" class="chip" title="Mute or unmute all videos" aria-pressed="false"></button>
        <label class="chip"><input id="autoall" type="checkbox">Autoplay all</label>
        <label class="chip"><input id="gauto" type="checkbox">Gallery autoplay <select id="gms" title="Seconds between images"></select></label>
        <label class="chip"><input id="ascroll" type="checkbox">Autoscroll
          <select id="aspeed" title="Scrolling speed">
            <option value="25">slow</option><option value="60">medium</option>
            <option value="120">fast</option><option value="240">faster</option>
          </select>
        </label>
      </div>
    </div>
  </header>
  <div class="scroller"><div class="grid"></div><div class="status"></div></div>
  <div class="lb">
    <div class="amb"></div>
    <div class="toolbar">
      <div class="cap"></div>
      <div class="group vo">
        <button id="tbMute" class="tbi" title="Mute or unmute (M)"></button>
        <select id="tbSpeed" title="Video playback speed">
          <option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">1×</option>
          <option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option>
        </select>
        <button id="tbLoop" class="tbi"></button>
      </div>
      <span class="sep vo"></span>
      <div class="group">
        <select id="tbFit" title="How media is sized (Z fills the screen)">
          <option value="contain">fit screen</option><option value="fit">scale to fit</option>
          <option value="fill">fill screen</option>
          <option value="width">fit width</option><option value="actual">actual size</option>
        </select>
        <button id="tbCaption" class="tbi" title="Show or hide the details (title, subreddit, age)"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6M12 7.6v.2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>
        <button id="lbRefresh" class="tbi" title="Reload the page (shift-click to fetch the listing again without reloading)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 11-2.3-5.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <span class="sep"></span>
      <button class="lbclose" title="Back to the grid (Esc)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg><span>Back to grid</span></button>
    </div>
    <div class="panel" id="reportBox" hidden>
      <div class="head">Report this post to the moderators</div>
      <select id="reportReason"></select>
      <input id="reportText" type="text" placeholder="More detail (optional)" spellcheck="false">
      <div class="buttons"><button id="reportCancel">Cancel</button><button id="reportSend">Send report</button></div>
    </div>
    <button class="nav prev" title="Previous (←)">‹</button>
    <div class="stage"></div>
    <button class="nav next" title="Next (→)">›</button>
    <div class="postbar rd"><span class="acts"></span><span class="menu"></span></div>
    <aside class="cmts rd" id="cmts" hidden>
      <div class="cmh">
        <b id="cmTitle">Comments</b>
        <select id="cmSort" title="Comment order">
          <option value="confidence">best</option><option value="top">top</option><option value="new">new</option>
          <option value="controversial">controversial</option><option value="old">old</option><option value="qa">Q&amp;A</option>
        </select>
        <a id="cmOpen" target="_blank" rel="noopener noreferrer" title="Open the thread on Reddit">Reddit ↗</a>
        <button id="cmClose" class="icon" title="Close comments (C or Esc)">✕</button>
      </div>
      <div class="cml" id="cmList"></div>
    </aside>
    <div class="toast"></div>
  </div>
</div>`);
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const st = document.createElement('style');
    st.textContent = CSS;
    root.prepend(st);
  }
  document.documentElement.append(host);

  const $ = (s) => root.querySelector(s);
  const fab = $('.fab'), app = $('.app'), scroller = $('.scroller'), grid = $('.grid');
  const statusEl = $('.status'), lb = $('.lb'), stage = $('.stage'), cap = $('.cap');

  /* ------------------------------------------------------------------ *
   *  Masonry layout (items are placed by estimated height, so
   *  appending never reshuffles what's already on screen)
   * ------------------------------------------------------------------ */
  const GAP = 8;
  const colCount = () => cfg.columns || clamp(Math.round(scroller.clientWidth / 230), 1, 8);

  // How many columns a tile covers: landscape media gets extra width so it isn't tiny.
  function spanFor(t) {
    return cfg.wide ? Math.min(t.span, colN) : 1;   // never wider than the columns available
  }

  function updateGridHeight() {
    grid.style.height = S.tiles.length ? Math.max(0, Math.max(...colH) - GAP) + 'px' : '0px';
  }

  // Tiles are repositioned in place, not removed and re-added, so playing videos keep playing.
  function layoutCols() {
    colN = colCount();
    colW = (grid.clientWidth - GAP * (colN - 1)) / colN;
    colH = new Array(colN).fill(0);
    if (!S.tiles.length) grid.replaceChildren();
    S.tiles.forEach((t) => place(t, false));
    updateGridHeight();
  }

  // Tiles are absolutely positioned: each one goes where the columns it covers are shortest.
  // A wide tile sits on its tallest column and leaves a hole under the shorter ones, so it
  // may drop one column when that leaves a noticeably smaller hole.
  function place(t, updateHeight = true) {
    const want = spanFor(t);
    let span = want, bestCol = 0, bestTop = Infinity, bestCost = Infinity;
    for (let s = want; s >= Math.max(1, want - 1); s--) {
      for (let c = 0; c + s <= colN; c++) {
        let top = 0, hole = 0;
        for (let k = c; k < c + s; k++) top = Math.max(top, colH[k]);
        for (let k = c; k < c + s; k++) hole += top - colH[k];
        const cost = top + hole / s + (want - s) * colW * 0.4;
        if (cost < bestCost) { bestCost = cost; bestTop = top; bestCol = c; span = s; }
      }
    }
    const w = span * colW + (span - 1) * GAP;
    const h = w * t.ratio;
    Object.assign(t.el.style, {
      left: bestCol * (colW + GAP) + 'px',
      top: bestTop + 'px',
      width: w + 'px',
      height: h + 'px',
    });
    for (let k = bestCol; k < bestCol + span; k++) colH[k] = bestTop + h + GAP;
    if (t.el.parentNode !== grid) grid.append(t.el);
    if (updateHeight) updateGridHeight();
  }

  /* ------------------------------------------------------------------ *
   *  Tiles
   * ------------------------------------------------------------------ */
  /* ---- video helpers (with companion audio for v.redd.it) ---- */
  const live = new Set();

  /* ---- sound: item.sound is true / false / undefined (not known yet) ---- */
  // Cross-origin reads go through GM_xmlhttpRequest: v.redd.it and api.redgifs.com do not
  // promise CORS headers for reddit.com.
  function gmGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest unavailable')); return; }
      GM_xmlhttpRequest({
        method: 'GET', url, headers, timeout: 10000,
        onload: (r) => resolve({ status: r.status, text: r.responseText || '' }),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timed out')),
      });
    });
  }

  // The DASH manifest names the real audio file; null when it cannot be read, [] when it has no audio.
  function mpdAudio(xml, base) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror') || !doc.querySelector('MPD')) return null;
    const reps = [...doc.querySelectorAll('AdaptationSet')]
      .filter((s) => /audio/i.test(s.getAttribute('contentType') || s.getAttribute('mimeType') || s.querySelector('Representation')?.getAttribute('mimeType') || ''))
      .flatMap((s) => [...s.querySelectorAll('Representation')])
      .sort((x, y) => (+y.getAttribute('bandwidth') || 0) - (+x.getAttribute('bandwidth') || 0));
    return reps.map((r) => r.querySelector('BaseURL')?.textContent.trim()).filter(Boolean)
      .map((u) => new URL(u, base + '/').href);
  }

  const AUDIO_NAMES = ['DASH_AUDIO_128.mp4', 'DASH_AUDIO_64.mp4', 'DASH_audio.mp4', 'CMAF_AUDIO_128.mp4', 'CMAF_AUDIO_64.mp4'];
  function audioUrls(item) {
    item._audioP ||= (async () => {
      const guesses = AUDIO_NAMES.map((f) => item.audio + '/' + f);
      if (item.dash) {
        try {
          const r = await gmGet(item.dash);
          const found = r.status === 200 ? mpdAudio(r.text, item.audio) : null;
          if (found) return [...found, ...guesses.filter((g) => !found.includes(g))].slice(0, found.length ? 8 : 0);
        } catch { /* fall back to the usual names */ }
      }
      return guesses;
    })();
    return item._audioP;
  }

  // Redgifs: a temporary token from its public API, then the clip's own HD/SD files.
  const RG = { token: '', at: 0, clips: new Map() };
  async function redgifsToken(fresh) {
    const saved = store.get('rgToken', null);
    if (!fresh && !RG.token && saved && Date.now() - saved.at < 20 * 3600e3) Object.assign(RG, { token: saved.token, at: saved.at });
    if (!fresh && RG.token && Date.now() - RG.at < 20 * 3600e3) return RG.token;
    const r = await gmGet('https://api.redgifs.com/v2/auth/temporary');
    const token = r.status === 200 ? JSON.parse(r.text).token : '';
    if (!token) throw new Error(`Redgifs refused a token (HTTP ${r.status})`);
    Object.assign(RG, { token, at: Date.now() });
    store.set('rgToken', { token, at: RG.at });
    return token;
  }
  function redgifsClip(id) {
    if (!RG.clips.has(id)) {
      const p = (async () => {
        for (const fresh of [false, true]) {
          const r = await gmGet(`https://api.redgifs.com/v2/gifs/${id}`, { Authorization: 'Bearer ' + await redgifsToken(fresh) });
          if (r.status === 401) continue;                  // token expired early
          const g = r.status === 200 ? JSON.parse(r.text).gif : null;
          if (!g?.urls) throw new Error(`Redgifs returned HTTP ${r.status}`);
          return { hd: g.urls.hd || g.urls.sd, sd: g.urls.sd || g.urls.hd, sound: g.hasAudio !== false };
        }
        throw new Error('Redgifs refused the request');
      })();
      p.catch(() => RG.clips.delete(id));                 // let a later hover try again
      RG.clips.set(id, p);
    }
    return RG.clips.get(id);
  }

  // media.redgifs.com answers 403 to any request with a reddit.com Referer, and a <video> on
  // this page always sends one. GM_xmlhttpRequest sends none, so the file is downloaded that
  // way and played from a blob: URL. A few recent files are kept for revisits.
  const rgFiles = new Map();
  function redgifsFile(url) {
    if (!rgFiles.has(url)) {
      const p = new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET', url, responseType: 'blob', timeout: 60000,
          onload: (r) => (r.status === 200 && r.response ? resolve(r.response) : reject(new Error(`HTTP ${r.status}`))),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timed out')),
        });
      });
      p.catch(() => rgFiles.delete(url));
      rgFiles.set(url, p);
      while (rgFiles.size > 6) rgFiles.delete(rgFiles.keys().next().value);
    }
    return rgFiles.get(url);
  }

  function soundChanged(item) {
    if (S.slides[lbIdx]?.item === item) renderMute();
  }

  // Swap a playing element to another file without losing its place.
  function swapSrc(v, url) {
    const t = v.currentTime, playing = !v.paused, before = v.src;
    v.src = url;
    v.addEventListener('error', () => { if (v.src === url) swapSrc(v, before); }, { once: true });
    v.addEventListener('loadedmetadata', () => { try { if (t) v.currentTime = t; } catch { /* ignore */ } }, { once: true });
    if (playing) v.play().catch(() => {});
  }

  function upgradeRedgifs(v) {
    const item = v._item;
    if (v._rg || !item.redgifs) return;
    v._rg = true;
    redgifsClip(item.redgifs).then(async (c) => {
      item.sound = c.sound;
      soundChanged(item);
      if (v._small && !c.sound) return;                // a silent tile gains nothing from the download
      const url = v._small ? c.sd : c.hd;
      if (!url || !live.has(v)) return;
      const blob = await redgifsFile(url);
      if (!live.has(v)) return;
      v._blobUrl = URL.createObjectURL(blob);
      swapSrc(v, v._blobUrl);
    }).catch(() => { v._rg = false; });
  }

  // Plain MP4s (Imgur and the like): ask the browser whether it found an audio track.
  function watchSound(v, item) {
    const check = () => {
      if (item.sound !== undefined || !live.has(v)) return true;
      let s;
      if (typeof v.mozHasAudio === 'boolean') s = v.mozHasAudio;                       // Firefox
      else if (v.audioTracks && 'length' in v.audioTracks) s = v.audioTracks.length > 0;   // Safari
      else if (typeof v.webkitAudioDecodedByteCount === 'number' && v.currentTime > 1) s = v.webkitAudioDecodedByteCount > 0;   // Chrome
      if (s === undefined) return false;
      item.sound = s;
      soundChanged(item);
      return true;
    };
    const on = () => { if (check()) { v.removeEventListener('loadeddata', on); v.removeEventListener('timeupdate', on); } };
    v.addEventListener('loadeddata', on);
    v.addEventListener('timeupdate', on);
  }

  function makeVideo(item, { controls = false, small = false } = {}) {
    const v = document.createElement('video');
    const src = (small && item.tile) || item.src;
    Object.assign(v, { src, loop: true, controls, playsInline: true, autoplay: true, muted: cfg.muted });
    v._item = item;
    v._small = small;
    if (src !== item.src) v.addEventListener('error', () => { v.src = item.src; v.play().catch(() => {}); }, { once: true });
    if (item.redgifs && (!small || !cfg.muted)) upgradeRedgifs(v);          // tiles fetch it only when sound is on
    else if (item.sound === undefined && !item.audio && !item.redgifs && src === item.src) watchSound(v, item);   // a preview clip says nothing about the real file
    if (item.audio) {
      const a = new Audio();
      a.loop = true;
      a.preload = 'none';
      let list = null, n = 0, started = false;
      const next = () => {
        if (n >= list.length) { a.removeAttribute('src'); item.sound = false; soundChanged(item); return; }
        a.src = list[n++];
        if (!v.paused && !v.muted) a.play().catch(() => {});
      };
      a.addEventListener('error', () => { if (list && a.getAttribute('src')) next(); });
      a.addEventListener('loadedmetadata', () => {
        item._audioP = Promise.resolve([a.src]);             // remember the name that worked
        if (item.sound !== true) { item.sound = true; soundChanged(item); }
      });
      // The <video> element is the master: its muted/volume/play state drives the audio file.
      const refresh = () => {
        a.muted = v.muted;
        a.volume = v.volume;
        a.loop = v.loop;
        a.playbackRate = v.playbackRate;
        if (v.paused || v.muted || v.readyState < 2) { a.pause(); return; }
        if (!started) {
          started = true;
          audioUrls(item).then((l) => { if (live.has(v)) { list = l; next(); } });
          return;
        }
        if (!list || !a.getAttribute('src')) return;
        if (Math.abs(a.currentTime - v.currentTime) > 0.3) { try { a.currentTime = v.currentTime; } catch { /* not ready yet */ } }
        a.play().catch(() => {});
      };
      ['play', 'pause', 'playing', 'waiting', 'seeked', 'volumechange', 'ratechange', 'timeupdate'].forEach((ev) => v.addEventListener(ev, refresh));
      v._audio = a;
    }
    live.add(v);
    return v;
  }

  function startVideo(v) {
    v.play().catch(() => {
      if (!live.has(v)) return;                       // was removed while starting
      v.muted = true;                                 // browser refused unmuted autoplay
      v.play().catch(() => {});
    });
  }

  function killVideo(v) {
    live.delete(v);
    v.pause();
    v.remove();
    v.removeAttribute('src');
    v.load();
    if (v._audio) { v._audio.pause(); v._audio.removeAttribute('src'); v._audio.load(); }
    if (v._blobUrl) { URL.revokeObjectURL(v._blobUrl); v._blobUrl = null; }
  }

  const applyMute = () => live.forEach((v) => {
    v.muted = cfg.muted;
    if (!cfg.muted && v._item?.redgifs) upgradeRedgifs(v);   // a muted tile kept Reddit's silent preview
  });

  /* ---- visibility tracking: only tiles at least partly on screen play ---- */
  const active = () => app.classList.contains('open') && !lb.classList.contains('open') && !document.hidden;
  const canAutoplay = (n) => cfg.autoplayAll && n._vis && !(cfg.blurNsfw && n.classList.contains('nsfw'));

  // Starting a video costs a request and a decoder, so a tile has to stay on screen for a
  // moment first: tiles that only fly past during a fast scroll never start.
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const t = en.target;
      t._vis = en.isIntersecting;
      if (!t._vid) continue;
      clearTimeout(t._due);
      if (!en.isIntersecting) { t._hover = false; t._stop(); }
      else if (cfg.autoplayAll) t._due = setTimeout(() => { if (t.isConnected && canAutoplay(t)) t._play(); }, 150);
    }
  }, { root: scroller });

  // Tile pictures load one and a half screens ahead of the scroll. The browser's own lazy
  // loading does not reliably look ahead inside a nested scroller, so pictures popped in late.
  const lazy = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      lazy.unobserve(en.target);
      en.target._load();
    }
  }, { root: scroller, rootMargin: '150% 0px' });

  function syncAutoplay() {
    for (const t of S.tiles) {
      const n = t.el;
      if (!n._vid) continue;
      if (canAutoplay(n)) n._play();
      else if (!n._hover) n._stop();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) S.tiles.forEach((t) => t.el._stop?.());
    else syncAutoplay();
  });

  function restartGalleryTimer() {
    clearInterval(galleryTimer);
    galleryTimer = null;
    if (!cfg.galleryAuto || !(cfg.galleryMs >= 200)) return;
    galleryTimer = setInterval(() => {
      if (!app.classList.contains('open') || lb.classList.contains('open')) return;
      for (const t of S.tiles) {
        const n = t.el;
        if (n._gallery && n._vis && !n._hover) n._step(1);   // wraps from last back to first
      }
    }, cfg.galleryMs);
  }

  /* ---- tiles ---- */
  function buildTile(post, items, first) {
    const n = items.length;
    const it = items[0];
    const a = el('a', 'tile' + (post.over_18 ? ' nsfw' : ''));
    a.href = site.postHref(post);

    let base;
    if (it.thumb || it.type === 'image' || n > 1) {
      base = new Image();
      base.decoding = 'async';
      base.referrerPolicy = site.referrer;
      base.alt = '';
      a._load = () => { if (!base.getAttribute('src')) base.src = it.thumb || it.src; };   // see `lazy`
    } else {
      base = document.createElement('video');
      base.muted = true; base.preload = 'metadata';
      a._load = () => { if (!base.getAttribute('src')) base.src = it.src + '#t=0.1'; };
    }
    a.append(base);

    const badge = el('span', 'badge');
    if (n > 1) badge.textContent = `1 / ${n}`;
    else if (it.type === 'video') badge.textContent = 'Video';
    else if (it.external) badge.textContent = 'Link';
    if (badge.textContent) a.append(badge);

    const meta = el('div', 'meta');
    meta.append(el('b', '', post.title));
    if (post.subreddit) meta.append(
      feedSpan('r/' + post.subreddit, 'r/' + post.subreddit, true),
      feedSpan('u/' + post.author, 'user/' + post.author, true),
    );
    const aw = awardsEl(post);
    if (aw) meta.append(aw);
    a.append(meta);

    // Multi-image posts: in-place previous/next buttons, wrapping around at both ends
    let gi = 0;
    if (n > 1) {
      a._gallery = true;
      const show = (i) => {
        gi = ((i % n) + n) % n;
        const cur = items[gi];
        base.src = cur.thumb || cur.src;
        badge.textContent = `${gi + 1} / ${n}`;
        const nx = items[(gi + 1) % n];
        const pre = new Image();
        pre.referrerPolicy = site.referrer;
        pre.src = nx.thumb || nx.src;
      };
      a._show = show;
      a._step = (d) => show(gi + d);
      for (const [cls, label, d, text] of [['tprev', '‹', -1, 'Previous image'], ['tnext', '›', 1, 'Next image']]) {
        const b = el('span', 'tnav ' + cls, label);
        b.setAttribute('role', 'button');
        b.setAttribute('aria-label', text);
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); a._step(d); });
        a.append(b);
      }
    }

    // Single videos / GIFs: play on hover, or all at once with "Autoplay all"
    if (n === 1 && it.type === 'video') {
      a._vid = true;
      let v = null;
      // Seek bar along the bottom edge, shown while hovered once the clip's length is known.
      const seek = el('span', 'seek'), bar = el('i');
      seek.append(bar);
      a.append(seek);
      let drawing = false, dragging = false;
      const draw = () => {
        if (!v || !a._hover) { drawing = false; return; }
        if (v.duration) bar.style.transform = `scaleX(${v.currentTime / v.duration})`;
        requestAnimationFrame(draw);
      };
      a._track = () => { if (!drawing) { drawing = true; requestAnimationFrame(draw); } };
      const seekTo = (e) => {
        if (!v?.duration) return;
        const r = seek.getBoundingClientRect();
        v.currentTime = clamp((e.clientX - r.left) / r.width, 0, 0.999) * v.duration;
        bar.style.transform = `scaleX(${v.currentTime / v.duration})`;
      };
      seek.addEventListener('pointerdown', (e) => {
        if (e.button) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        try { seek.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        seekTo(e);
      });
      seek.addEventListener('pointermove', (e) => { if (dragging) seekTo(e); });
      for (const ev of ['pointerup', 'pointercancel']) seek.addEventListener(ev, () => { dragging = false; });
      seek.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });   // not a click on the tile
      a.addEventListener('dragstart', (e) => { if (dragging) e.preventDefault(); });         // the tile is a link

      a._play = () => {
        if (v || !active()) return;
        v = makeVideo(it, { small: true });
        v.addEventListener('loadedmetadata', () => a.classList.add('seekable'));
        base.after(v);
        startVideo(v);
        a._track();
      };
      a._stop = () => {
        if (!v) return;
        killVideo(v);
        v = null;
        dragging = false;
        a.classList.remove('seekable');
        bar.style.transform = '';
      };
    }

    // Not for touch: a tap would start a video only for the lightbox it opens to stop it again.
    a.addEventListener('pointerenter', (e) => { if (e.pointerType === 'touch') return; a._hover = true; if (a._vid) { a._play(); a._track(); } });
    a.addEventListener('pointerleave', (e) => { if (e.pointerType === 'touch') return; a._hover = false; if (a._vid && !canAutoplay(a)) a._stop(); });
    a.addEventListener('click', (e) => {
      if (e.button || e.ctrlKey || e.metaKey || e.shiftKey) return; // let modified clicks open the post
      e.preventDefault();
      openLb(first + gi);
    });
    return a;
  }

  let reflow;
  function addPost(post, items) {
    const first = S.slides.length;
    const aspect = (items[0].w || 1) / (items[0].h || 1);           // width / height
    const ratio = clamp(1 / aspect, 0.3, 2.2);                       // height / width, clamped
    // portrait and square -> 1 column, landscape (4:3, 3:2) -> up to 2, widescreen (16:9 and wider) -> up to 3
    const span = aspect >= 1.7 ? 3 : aspect >= 1.2 ? 2 : 1;
    const tile = buildTile(post, items, first);
    items.forEach((item, pos) => S.slides.push({ post, item, pos, count: items.length, tile, first }));
    const rec = { el: tile, ratio, span };
    if (!items[0].w || !items[0].h) {
      tile.querySelector('img')?.addEventListener('load', (e) => {
        const { naturalWidth: w, naturalHeight: h } = e.target;
        if (!w || !h) return;
        rec.ratio = clamp(h / w, 0.3, 2.2);
        rec.span = w / h >= 1.7 ? 3 : w / h >= 1.2 ? 2 : 1;
        clearTimeout(reflow);
        reflow = setTimeout(layoutCols, 150);
      }, { once: true });
    }
    S.tiles.push(rec);
    place(rec);
    if (lbIdx === first - 1) renderNav();
    lazy.observe(tile);
    if (tile._vid || tile._gallery) io.observe(tile);
  }

  /* ------------------------------------------------------------------ *
   *  Loading
   * ------------------------------------------------------------------ */
  function setStatus(msg, err) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('err', !!err);
  }

  function updateCount() {
    $('#count').textContent = S.tiles.length
      ? `${S.tiles.length} posts, ${S.slides.length} items` + (S.dupes ? `, ${S.dupes} repost${S.dupes > 1 ? 's' : ''} hidden` : '')
      : '';
  }

  function loadMore() { return site.load(); }

  // After a reload, page through the feed until the item the lightbox was on shows up again.
  function maybeRestore() {
    const r = S.restore;
    if (!r) return;
    const i = S.slides.findIndex((sl) => sl.post.name === r.id && sl.pos === r.pos);
    if (i >= 0) {
      S.restore = null;
      openLb(i);
      return;
    }
    if (S.done || ++S.restoreTries > 12) S.restore = null;   // it has gone, or it is too far down
  }

  function maybeFill(auto) {
    if (S.loading || S.done || !app.classList.contains('open')) return;
    if (auto && (S.emptyStreak >= 5 || statusEl.classList.contains('err'))) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (remaining < Math.max(1200, scroller.clientHeight * 1.5)) loadMore();
  }

  // Each item lands in exactly one bucket:
  //   gifs      GIF-format loops: .gif files, imgur GIFVs, GIFs Reddit converted, GIF gallery items
  //   animated  other looping clips: redgifs-style loops from external sites, animated WebP
  //   videos    regular videos
  //   pictures  still images
  function matchesFilter(it) {
    switch (cfg.filter) {
      case 'videos': return it.type === 'video' && !it.animated;
      case 'animated': return !!it.animated && !it.gif;
      case 'gifs': return !!it.animated && !!it.gif;
      case 'pictures': return it.type === 'image' && !it.animated;
      default: return true;
    }
  }

  function refreshStatus() {
    if (S.done) {
      setStatus(S.slides.length ? 'End of feed'
        : S.all.length && cfg.filter !== 'all' ? 'Nothing in this feed matches the filter.'
        : 'No images or videos found in this feed.');
    } else {
      setStatus(S.emptyStreak >= 5 ? 'No matching media in the last few pages. Scroll or click here to keep looking.' : '');
    }
  }

  // Re-apply the type filter to posts already downloaded (no new requests).
  function rebuild() {
    S.restore = null;
    S.tiles.forEach((t) => t.el._stop?.());
    io.disconnect();
    lazy.disconnect();
    Object.assign(S, { tiles: [], slides: [], emptyStreak: 0 });
    layoutCols();
    scroller.scrollTop = 0;
    for (const r of S.all) {
      const shown = r.items.filter(matchesFilter);
      if (shown.length) addPost(r.post, shown);
    }
    updateCount();
    if (!S.loading) refreshStatus();
    maybeFill(true);
  }

  function reset() {
    S.tiles.forEach((t) => t.el._stop?.());
    io.disconnect();
    lazy.disconnect();
    S.gen++;
    Object.assign(S, { after: null, loading: false, done: false, emptyStreak: 0, dupes: 0, all: [], tiles: [], slides: [] });
    S.seen.clear();
    S.media.clear();
    layoutCols();
    scroller.scrollTop = 0;
    updateCount();
    refreshHeader();
    loadMore();
  }

  /* ------------------------------------------------------------------ *
   *  Header controls
   * ------------------------------------------------------------------ */
  function refreshHeader() {
    $('#src').value = sourceString();
    const s = currentSort();
    $('#sort').value = SORTS.includes(s) && s !== 'best' ? s : '';
    $('#time').value = S.query.get('t') || 'day';
    $('#time').hidden = !(s === 'top' || s === 'controversial');
  }

  function renderFeeds(selected = '') {
    const sel = $('#feeds');
    sel.replaceChildren(new Option('Saved feeds', ''));
    Object.keys(cfg.feeds).sort((a, b) => a.localeCompare(b)).forEach((name) => sel.append(new Option(name, name)));
    sel.value = selected;
  }

  function goSource(str) {
    const s = parseSource(str);
    if (!s) return setStatus('That does not look like a Reddit address.', true);
    S.restore = null;
    S.path = s.path;
    S.query = s.query;
    reset();
  }

  $('#go').onclick = () => goSource($('#src').value);
  $('#src').addEventListener('keydown', (e) => { if (e.key === 'Enter') goSource(e.target.value); });
  $('#feeds').onchange = (e) => { if (e.target.value) goSource(cfg.feeds[e.target.value]); };
  $('#saveFeed').onclick = () => {
    const dflt = S.path.split('/').filter(Boolean).pop() || 'front page';
    const name = (prompt('Name for this feed:', dflt) || '').trim();
    if (!name) return;
    cfg.feeds[name] = sourceString();
    store.set('feeds', cfg.feeds);
    renderFeeds(name);
  };
  $('#delFeed').onclick = () => {
    const name = $('#feeds').value;
    if (!name || !confirm(`Delete saved feed "${name}"?`)) return;
    delete cfg.feeds[name];
    store.set('feeds', cfg.feeds);
    renderFeeds();
  };
  if (!['all', 'videos', 'animated', 'gifs', 'pictures'].includes(cfg.filter)) cfg.filter = 'all';
  $('#filter').value = cfg.filter;
  $('#filter').onchange = (e) => {
    cfg.filter = e.target.value;
    store.set('filter', cfg.filter);
    rebuild();
  };
  $('#sort').onchange = () => applySort($('#sort').value, $('#time').value);
  $('#time').onchange = () => applySort($('#sort').value, $('#time').value);

  const colsSel = $('#cols');
  colsSel.append(new Option('auto', '0'));
  for (let n = 1; n <= 15; n++) colsSel.append(new Option(String(n), String(n)));
  colsSel.value = String(clamp(cfg.columns | 0, 0, 15));
  colsSel.onchange = () => {
    cfg.columns = +colsSel.value;
    store.set('columns', cfg.columns);
    layoutCols();
  };

  $('#wide').checked = cfg.wide;
  $('#wide').onchange = (e) => {
    cfg.wide = e.target.checked;
    store.set('wide', cfg.wide);
    layoutCols();
  };

  $('#nsfw').checked = cfg.blurNsfw;
  app.classList.toggle('blur', cfg.blurNsfw);
  $('#nsfw').onchange = (e) => {
    cfg.blurNsfw = e.target.checked;
    store.set('blurNsfw', cfg.blurNsfw);
    app.classList.toggle('blur', cfg.blurNsfw);
    syncAutoplay();
  };

  $('#prev').checked = cfg.previews;
  $('#prev').onchange = (e) => {
    cfg.previews = e.target.checked;
    store.set('previews', cfg.previews);
    reset();
  };

  const SVG = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const LINE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const TB_ICON = {
    sound: SVG(`<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" ${LINE}/>`),
    muted: SVG(`<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9.5l5 5m0-5l-5 5" ${LINE}/>`),
    loop: SVG(`<path d="M4 12a6 6 0 016-6h7M20 12a6 6 0 01-6 6H7" ${LINE}/><path d="M15 3l3 3-3 3M9 21l-3-3 3-3" ${LINE}/>`),
  };

  function renderMute() {
    for (const id of ['#mute', '#tbMute']) {      // header button and lightbox toolbar button
      const b = $(id);
      const none = id === '#tbMute' && noSound();
      if (id === '#mute') b.textContent = cfg.muted ? 'Muted' : 'Sound on';
      else {
        setHTML(b, cfg.muted || none ? TB_ICON.muted : TB_ICON.sound);
        b.title = none ? 'This video has no sound' : (cfg.muted ? 'Unmute' : 'Mute') + ' (M)';
      }
      b.classList.toggle('on', !cfg.muted && !none);
      b.classList.toggle('none', none);
      b.setAttribute('aria-disabled', String(none));
      b.setAttribute('aria-pressed', String(!cfg.muted));
    }
  }
  // The lightbox shows a video that is known to be silent: there is nothing to unmute.
  function noSound() {
    const it = lb.classList.contains('open') && S.slides[lbIdx]?.item;
    return !!it && it.type === 'video' && it.sound === false;
  }
  function lbMute() {
    if (noSound()) toast('This video has no sound');
    else toggleMute();
  }
  function toggleMute() {
    cfg.muted = !cfg.muted;
    store.set('muted', cfg.muted);
    renderMute();
    applyMute();
  }
  $('#mute').onclick = toggleMute;
  $('#tbMute').onclick = lbMute;

  $('#autoall').checked = cfg.autoplayAll;
  $('#autoall').onchange = (e) => {
    cfg.autoplayAll = e.target.checked;
    store.set('autoplayAll', cfg.autoplayAll);
    syncAutoplay();
  };

  $('#gauto').checked = cfg.galleryAuto;
  const gmsSel = $('#gms');
  for (let ms = 1000; ms <= 10000; ms += 100) gmsSel.append(new Option((ms / 1000).toFixed(1) + ' s', String(ms)));
  cfg.galleryMs = clamp(Math.round(cfg.galleryMs / 100) * 100, 1000, 10000);
  gmsSel.value = String(cfg.galleryMs);
  const galleryChanged = restartGalleryTimer;
  $('#gauto').onchange = (e) => {
    cfg.galleryAuto = e.target.checked;
    store.set('galleryAuto', cfg.galleryAuto);
    galleryChanged();
  };
  gmsSel.onchange = () => {
    cfg.galleryMs = +gmsSel.value;
    store.set('galleryMs', cfg.galleryMs);
    galleryChanged();
  };

  // The whole header folds away to leave the grid more room.
  function renderBar() {
    app.classList.toggle('bar-up', cfg.barUp);
    const b = $('#barToggle');
    b.textContent = cfg.barUp ? '▼' : '▲';
    b.title = cfg.barUp ? 'Show the toolbar' : 'Collapse the toolbar';
    b.setAttribute('aria-expanded', String(!cfg.barUp));
  }
  renderBar();
  $('#barToggle').onclick = () => {
    cfg.barUp = !cfg.barUp;
    store.set('barUp', cfg.barUp);
    renderBar();
  };

  /* ---- autoscroll: creeps down the grid, paused while you hold the pointer down ---- */
  const SPEEDS_PX = [25, 60, 120, 240];
  if (!SPEEDS_PX.includes(cfg.scrollSpeed)) cfg.scrollSpeed = 60;
  let scrollRAF = null, scrollLast = 0, scrollFrac = 0, scrollHold = false;

  function scrollStep(t) {
    if (!cfg.autoScroll || !app.classList.contains('open')) { scrollRAF = null; return; }
    scrollRAF = requestAnimationFrame(scrollStep);
    const dt = scrollLast ? (t - scrollLast) / 1000 : 0;
    scrollLast = t;
    if (scrollHold || lb.classList.contains('open') || dt <= 0 || dt > 0.5) return;
    scrollFrac += cfg.scrollSpeed * dt;
    const px = Math.floor(scrollFrac);
    if (px < 1) return;
    scrollFrac -= px;
    scroller.scrollTop += px;
  }

  function startScroll() {
    if (scrollRAF || !cfg.autoScroll || !app.classList.contains('open')) return;
    scrollLast = 0;
    scrollFrac = 0;
    scrollRAF = requestAnimationFrame(scrollStep);
  }

  const holdOn = () => { scrollHold = true; };
  const holdOff = () => { scrollHold = false; scrollLast = 0; };
  app.addEventListener('pointerdown', holdOn);
  app.addEventListener('touchstart', holdOn, { passive: true });
  for (const ev of ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur']) {
    window.addEventListener(ev, holdOff);
  }

  $('#ascroll').checked = cfg.autoScroll;
  $('#aspeed').value = String(cfg.scrollSpeed);
  $('#ascroll').onchange = (e) => {
    cfg.autoScroll = e.target.checked;
    store.set('autoScroll', cfg.autoScroll);
    startScroll();
  };
  $('#aspeed').onchange = (e) => {
    cfg.scrollSpeed = +e.target.value;
    store.set('scrollSpeed', cfg.scrollSpeed);
    e.target.blur();
  };

  // Reachable in fullscreen, where the browser's own reload button is out of sight.
  function refreshFeed(e) {
    if (e && e.shiftKey) { closeLb(); reset(); return; }   // shift: just fetch the listing again
    location.reload();
  }
  $('#refresh').onclick = refreshFeed;
  $('#lbRefresh').onclick = refreshFeed;

  $('#close').onclick = () => closeGallery();

  // The Gallery button sits at the top edge like a notch. It can be dragged along that edge,
  // or off it to anywhere on the page; the place is remembered (as fractions of the window).
  function placeFab(p = store.get('fabPos', null) || { x: 0.5, y: 0 }) {
    fab.classList.toggle('free', p.y > 0);
    fab.style.left = clamp(p.x, 0.06, 0.94) * 100 + '%';
    fab.style.top = p.y > 0 ? `min(${p.y * 100}%, calc(100% - 44px))` : '0';
  }
  placeFab();
  let fabDrag = null, fabDragged = false;
  fab.addEventListener('pointerdown', (e) => {
    fabDragged = false;
    if (e.button) return;
    fabDrag = { x: e.clientX, y: e.clientY, pos: null };
    try { fab.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
  });
  fab.addEventListener('pointermove', (e) => {
    if (!fabDrag) return;
    if (!fabDrag.pos && Math.hypot(e.clientX - fabDrag.x, e.clientY - fabDrag.y) < 8) return;   // still a click
    const top = e.clientY - fab.offsetHeight / 2;
    fabDrag.pos = { x: e.clientX / innerWidth, y: top < 24 ? 0 : top / innerHeight };          // near the top it docks again
    fab.classList.add('drag');
    placeFab(fabDrag.pos);
  });
  const fabDrop = () => {
    const d = fabDrag;
    fabDrag = null;
    fab.classList.remove('drag');
    if (!d?.pos) return;
    fabDragged = true;                                // the click that ends a drag opens nothing
    store.set('fabPos', d.pos);
  };
  fab.addEventListener('pointerup', fabDrop);
  fab.addEventListener('pointercancel', fabDrop);
  fab.onclick = () => { if (fabDragged) { fabDragged = false; return; } toggle(); };
  statusEl.onclick = () => {
    if (S.loading || S.done) return;
    S.emptyStreak = 0;
    statusEl.classList.remove('err');
    loadMore();
  };
  let fillQueued = false;
  scroller.addEventListener('scroll', () => {
    if (fillQueued) return;
    fillQueued = true;
    requestAnimationFrame(() => { fillQueued = false; maybeFill(false); });
  }, { passive: true });

  let resizeTimer, lastGridW = 0;
  new ResizeObserver(() => {
    const w = grid.clientWidth;
    if (!w || w === lastGridW) return;
    lastGridW = w;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (app.classList.contains('open')) layoutCols(); }, 120);
  }).observe(grid);

  /* ------------------------------------------------------------------ *
   *  Lightbox
   * ------------------------------------------------------------------ */
  function clearStage() {
    stage.querySelectorAll('video').forEach(killVideo);   // also stops companion audio
    stage.replaceChildren();
    stage.classList.remove('sliding');                 // its animation was cut short
    resetZoom();
  }

  function openLb(i) {
    lb.classList.add('open');
    for (const t of S.tiles) t.el._stop?.();     // nothing keeps playing behind the preview
    showSlide(i);
  }

  function closeLb() {
    if (!lb.classList.contains('open')) return;
    tabFocus.del(pageKey());
    lb.classList.remove('open', 'idle');
    hidePanels();
    closeComments();
    if (inFs()) { try { exitFs()?.catch?.(() => {}); } catch { /* ignore */ } }
    clearStage();
    const s = S.slides[lbIdx];
    if (s) {
      s.tile._show?.(s.pos);                              // grid tile shows the image you stopped on
      // The grid stays where it was. It only moves when the item you stopped on is off screen.
      const top = grid.offsetTop + parseFloat(s.tile.style.top), view = scroller.scrollTop;
      if (top + parseFloat(s.tile.style.height) <= view || top >= view + scroller.clientHeight) s.tile.scrollIntoView({ block: 'center' });
    }
    lbIdx = -1;
    syncAutoplay();                                       // the grid picks up where it left off
  }

  // The outgoing item stays on stage as a paused ghost while it slides away, then goes.
  function slideOut(old, dir) {
    const { offsetLeft: left, offsetTop: top, offsetWidth: width, offsetHeight: height } = old;
    old.remove();                                     // keep clearStage from killing it now
    if (old.tagName === 'VIDEO') old.pause();         // its companion audio follows the pause
    old.classList.remove('in-next', 'in-prev');
    old.classList.add('ghost', dir > 0 ? 'out-next' : 'out-prev');
    Object.assign(old.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
    return () => {
      stage.append(old);
      setTimeout(() => (old.tagName === 'VIDEO' ? killVideo(old) : old.remove()), 300);
    };
  }

  // The arrows say what a step does. A single chevron in the accent colour, with the position
  // it leads to underneath, stays inside this post's own pictures; a double chevron moves on
  // to another post. At either end of the feed the arrow is dimmed but still takes the click,
  // which would otherwise land on the backdrop and close the lightbox.
  function renderNav() {
    const cur = S.slides[lbIdx];
    if (!cur) return;
    for (const [sel, d, one, two, word, key] of [['.prev', -1, '‹', '«', 'Previous', '←'], ['.next', 1, '›', '»', 'Next', '→']]) {
      const b = $(sel), to = S.slides[lbIdx + d], same = !!to && to.post === cur.post;
      b.textContent = same || !to ? one : two;
      b.classList.toggle('in', same);
      b.classList.toggle('end', !to);
      b.dataset.n = same ? `${to.pos + 1} / ${to.count}` : '';
      b.title = !to ? `No ${word.toLowerCase()} item` : `${word} ${same ? 'item in this post' : 'post'} (${key})`;
    }
  }

  // slide: 1 or -1 (wheel navigation) slides the old item out left/right and the new one in.
  function showSlide(i, slide = 0) {
    if (i < 0 || i >= S.slides.length) return;
    const changedPost = S.slides[lbIdx]?.post !== S.slides[i].post;
    lbIdx = i;
    const { post, item, pos, count } = S.slides[i];
    if (changedPost) {
      hidePanels();
      if (!cmtBox.hidden) loadComments(post);            // the open comments follow the post
    }
    tabFocus.set(pageKey(), { id: post.name, pos });

    if (slide && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) slide = 0;
    const old = slide && media();
    const ghost = old ? slideOut(old, slide) : null;
    clearStage();
    let m;
    if (item.type === 'video') {
      m = makeVideo(item, { controls: true });
      m.loop = cfg.loop;
      m.defaultPlaybackRate = m.playbackRate = cfg.speed;
    } else {
      m = new Image();
      m.referrerPolicy = site.referrer;
      m.alt = post.title;
      if (item.thumb && item.thumb !== item.src) m.addEventListener('error', () => { m.src = item.thumb; }, { once: true });
      m.src = item.src;
    }
    stage.append(m);
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
    if (slide) {
      ghost?.();
      m.classList.add(slide > 0 ? 'in-next' : 'in-prev');
      stage.classList.add('sliding');                 // no scrollbar flash while it moves in
      m.addEventListener('animationend', () => {
        m.classList.remove('in-next', 'in-prev');
        stage.classList.remove('sliding');
      }, { once: true });
    }
    if (item.type === 'video') startVideo(m);
    // The grid may only have had a still or a short clip of this item.
    site.full?.(item)?.then((changed) => { if (changed && S.slides[lbIdx]?.item === item) showSlide(lbIdx); });
    lb.querySelectorAll('.vo').forEach((n) => { n.hidden = item.type !== 'video'; });   // video-only controls
    renderMute();                                     // greyed out when this video is known to be silent
    renderNav();
    const amb = item.type === 'image' ? item.thumb || item.src : item.thumb;
    lb.style.setProperty('--amb', amb ? `url("${amb.replace(/["\\\n]/g, encodeURIComponent)}")` : 'none');

    cap.replaceChildren();
    const title = el('a', '', post.title);
    title.href = site.postHref(post);
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    const row = el('div', 'row');
    if (count > 1) row.append(el('span', '', `${pos + 1} of ${count}`));
    if (post.subreddit) row.append(
      feedSpan('r/' + post.subreddit, 'r/' + post.subreddit),
      feedSpan('u/' + post.author, 'user/' + post.author),
    );
    if (post.created_utc) row.append(el('span', '', ago(post.created_utc) + ' ago'));
    const aw = awardsEl(post);
    if (aw) row.append(aw);
    if (item.external) {
      const ext = el('a', '', 'Open linked page');
      ext.href = post.url_overridden_by_dest || post.url;
      ext.target = '_blank';
      ext.rel = 'noopener noreferrer';
      row.append(ext);
    }
    cap.append(title, row);
    renderActions();

    for (const j of [i + 1, i - 1]) {
      const sl = S.slides[j];
      if (sl && sl.item.type === 'image') { const p = new Image(); p.referrerPolicy = site.referrer; p.src = sl.item.src; }
    }
    if (i >= S.slides.length - 8) loadMore();
  }

  $('.prev').onclick = () => showSlide(lbIdx - 1);
  $('.next').onclick = () => showSlide(lbIdx + 1);
  $('.lbclose').onclick = closeLb;
  // Clicking any empty space around the media goes back to the grid: the area the media
  // sits in, and the gaps beside the post buttons underneath it.
  const backdrop = (t) => t === stage || t === lb;   // the blurred .amb layer takes no clicks, so it counts as lb
  lb.addEventListener('click', (e) => {
    if (panned) { panned = false; return; }            // the end of a drag, not a click
    if (!backdrop(e.composedPath()[0])) return;
    if (reportBox.hidden) closeLb(); else hidePanels();
  });
  lb.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });      // no autoscroll cursor
  lb.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeLb(); } });

  /* ---- lightbox toolbar ---- */
  const tb = $('.toolbar');
  const FITS = ['contain', 'fit', 'fill', 'width', 'actual'];
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  if (!FITS.includes(cfg.fit)) cfg.fit = 'contain';
  if (!SPEEDS.includes(cfg.speed)) cfg.speed = 1;

  const reqFs = () => (lb.requestFullscreen || lb.webkitRequestFullscreen)?.call(lb);
  function exitFs() { return (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); }
  function inFs() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  let lbFull = false, fsByUs = false;
  function toggleFullscreen() {
    fsByUs = inFs();
    try { (inFs() ? exitFs() : reqFs())?.catch?.(() => {}); } catch { /* ignore */ }
  }

  // The browser keeps Esc for itself in fullscreen and never passes it to the page, so a
  // fullscreen exit the script did not ask for is that Esc: carry on down the Esc chain.
  function fsChanged() {
    const was = lbFull, ours = fsByUs;
    lbFull = root.fullscreenElement === lb;    // not a video the user made fullscreen itself
    fsByUs = false;
    if (was && !lbFull && !ours && lb.classList.contains('open')) {
      if (!reportBox.hidden) hidePanels();
      else if (!cmtBox.hidden) closeComments();
      else closeLb();
    }
  }

  function applyFit() {
    stage.className = 'stage fit-' + cfg.fit;
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
    resetZoom();
  }

  function renderToolbar() {
    $('#tbFit').value = cfg.fit;
    $('#tbSpeed').value = String(cfg.speed);
    setHTML($('#tbLoop'), TB_ICON.loop);
    $('#tbLoop').title = cfg.loop ? 'Looping (click to play once)' : 'Plays once (click to loop)';
    $('#tbLoop').classList.toggle('on', cfg.loop);
    $('#tbCaption').classList.toggle('on', cfg.caption);
    cap.hidden = !cfg.caption;
    renderMute();
  }

  // Z flips between filling the screen and whichever mode you were on before.
  let lastFit = cfg.fit === 'fill' ? 'contain' : cfg.fit;
  function toggleFill() {
    if (cfg.fit !== 'fill') lastFit = cfg.fit;
    cfg.fit = cfg.fit === 'fill' ? lastFit : 'fill';
    store.set('fit', cfg.fit);
    renderToolbar();
    applyFit();
  }

  const eachVideo = (fn) => stage.querySelectorAll('video').forEach(fn);
  $('#tbFit').onchange = (e) => { cfg.fit = e.target.value; store.set('fit', cfg.fit); applyFit(); e.target.blur(); };
  $('#tbSpeed').onchange = (e) => {
    cfg.speed = +e.target.value;
    store.set('speed', cfg.speed);
    eachVideo((v) => { v.defaultPlaybackRate = v.playbackRate = cfg.speed; });
    e.target.blur();
  };
  $('#tbLoop').onclick = () => {
    cfg.loop = !cfg.loop;
    store.set('loop', cfg.loop);
    renderToolbar();
    eachVideo((v) => { v.loop = cfg.loop; });
  };
  $('#tbCaption').onclick = () => { cfg.caption = !cfg.caption; store.set('caption', cfg.caption); renderToolbar(); };

  // In fullscreen the toolbar, caption and arrows fade out after a pause and return on movement.
  let idleTimer;
  function wake() {
    lb.classList.remove('idle');
    clearTimeout(idleTimer);
    if (!inFs() || !lb.classList.contains('open')) return;
    idleTimer = setTimeout(() => {
      if (tb.matches(':hover') || !reportBox.hidden) return;
      lb.classList.add('idle');
    }, 2500);
  }
  lb.addEventListener('mousemove', wake);
  lb.addEventListener('touchstart', wake, { passive: true });
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, () => { fsChanged(); wake(); }));

  /* ---- wheel steps through items; Ctrl+wheel zooms around the pointer, drag pans ---- */
  let zoom = 1, panX = 0, panY = 0, drag = null, panned = false;
  let wheelSum = 0, wheelAt = 0, stepAt = 0;
  const media = () => stage.querySelector('img:not(.ghost),video:not(.ghost)');

  function drawZoom() {
    const m = media();
    if (m) m.style.transform = zoom === 1 ? '' : `translate(${panX}px,${panY}px) scale(${zoom})`;
    stage.classList.toggle('zoomed', zoom !== 1);
  }

  function resetZoom() {
    zoom = 1; panX = 0; panY = 0; drag = null;
    stage.classList.remove('panning');
    drawZoom();
  }

  // Keeps the point under the pointer still: it moves by (1 - new/old) of its distance from the corner.
  function zoomAt(z, cx, cy) {
    const m = media();
    z = clamp(z, 1, 10);
    if (!m || z === 1) { resetZoom(); return; }
    const r = m.getBoundingClientRect();
    const k = 1 - z / zoom;
    panX += (cx - r.left) * k;
    panY += (cy - r.top) * k;
    zoom = z;
    drawZoom();
  }

  lb.addEventListener('wheel', (e) => {
    const t = e.composedPath()[0];
    if (!lb.classList.contains('open') || reportBox.contains(t) || cmtBox.contains(t)) return;   // those scroll themselves
    const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 600 : 1);   // lines / pages to pixels
    if (e.ctrlKey) {                                   // also what a trackpad pinch sends
      e.preventDefault();
      zoomAt(zoom * Math.exp(-dy * 0.002), e.clientX, e.clientY);
      return;
    }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    // A picture taller than the screen (width / actual size) scrolls to its end first.
    const canScroll = dy > 0 ? stage.scrollTop + stage.clientHeight < stage.scrollHeight - 1 : stage.scrollTop > 0;
    if (zoom === 1 && stage.contains(t) && canScroll) return;
    e.preventDefault();
    // Trackpads send a stream of small events: add them up and allow one step per gesture.
    if (e.timeStamp - wheelAt > 200) wheelSum = 0;
    wheelAt = e.timeStamp;
    wheelSum += dy;
    if (Math.abs(wheelSum) < 50 || e.timeStamp - stepAt < 300) return;
    stepAt = e.timeStamp;
    showSlide(lbIdx + Math.sign(wheelSum), Math.sign(wheelSum));
    wheelSum = 0;
  }, { passive: false });

  lb.addEventListener('pointerdown', () => { panned = false; }, true);   // a drag with no click after it
  stage.addEventListener('pointerdown', (e) => {
    if (zoom === 1 || e.button) return;
    e.preventDefault();
    drag = { x: e.clientX - panX, y: e.clientY - panY, sx: e.clientX, sy: e.clientY };
    stage.classList.add('panning');
    try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    panX = e.clientX - drag.x;
    panY = e.clientY - drag.y;
    drawZoom();
  });
  for (const ev of ['pointerup', 'pointercancel']) {
    stage.addEventListener(ev, (e) => {
      if (!drag) return;
      panned = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4;
      drag = null;
      stage.classList.remove('panning');
    });
  }

  // Swipe sideways for the next / previous item, swipe up to go back to the grid. On a
  // video or animation a quick flick still steps, but a slower slide scrubs through it:
  // once a touch has lasted FLICK_MS and is moving sideways, it belongs to the video.
  const FLICK_MS = 250, SCRUB_SPAN = 60;             // a slide across the whole screen covers at most this many seconds
  let touch = null;
  lb.addEventListener('touchstart', (e) => {
    const t = e.composedPath()[0];
    if (e.touches.length > 1 || cmtBox.contains(t) || reportBox.contains(t)) { touch = null; return; }   // a pinch, or a panel that scrolls itself
    // A picture taller than the screen scrolls to its end before a swipe up closes it.
    const atEnd = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1;
    const { clientX: x, clientY: y } = e.touches[0];
    touch = { x, y, atEnd, at: e.timeStamp, video: null };
    const m = media();
    if (m && m.tagName === 'VIDEO' && m.duration > 0 && Number.isFinite(m.duration)) {
      const r = m.getBoundingClientRect();
      if (!(t === m && y > r.bottom - 56)) touch.video = m;   // the strip along the bottom is the player's own seek bar
    }
  }, { passive: true });
  lb.addEventListener('touchmove', (e) => {
    const v = touch && touch.video;
    if (!v || zoom !== 1 || e.touches.length > 1) return;
    const { clientX: x, clientY: y } = e.touches[0];
    if (!touch.scrub) {
      const dx = x - touch.x;
      if (e.timeStamp - touch.at < FLICK_MS || Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(y - touch.y)) return;
      touch.scrub = { x, time: v.currentTime };       // from here, so the picture does not jump
    }
    const span = Math.min(v.duration, SCRUB_SPAN);
    try { v.currentTime = clamp(touch.scrub.time + (x - touch.scrub.x) / (lb.clientWidth || 1) * span, 0, Math.max(0, v.duration - 0.05)); } catch { /* not seekable yet */ }
  }, { passive: true });
  lb.addEventListener('touchend', (e) => {
    const from = touch;
    touch = null;
    if (!from || from.scrub || zoom !== 1) return;                 // scrubbed a video, or a zoomed picture is being panned
    const dx = e.changedTouches[0].clientX - from.x, dy = e.changedTouches[0].clientY - from.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) >= Math.abs(dy)) showSlide(lbIdx + (dx < 0 ? 1 : -1));
    else if (dy < -80 && -dy > Math.abs(dx) * 1.5 && from.atEnd) closeLb();
  }, { passive: true });
  lb.addEventListener('touchcancel', () => { touch = null; }, { passive: true });

  /* ------------------------------------------------------------------ *
   *  Open / close
   * ------------------------------------------------------------------ */
  // A plugin may have the page hidden while the gallery is up (site.hidePage).
  let pageHidden = false, pageScroll = 0;
  function coverPage(on) {
    if (on === pageHidden) return;
    pageHidden = on;
    if (on) { pageScroll = scrollY; if (site.hidePage) document.body.style.display = 'none'; }
    else { if (site.hidePage) document.body.style.display = ''; scrollTo(0, pageScroll); }
  }

  function openGallery(force) {
    app.classList.add('open');
    syncFab();
    checkUpdate();
    startScroll();
    document.documentElement.style.overflow = 'hidden';
    coverPage(true);
    pushGuard();
    if (force || S.href !== pageKey()) {
      S.href = pageKey();
      const s = sourceFromLocation();
      S.path = s.path;
      S.query = s.query;
      reset();
      S.restore = tabFocus.get(pageKey());   // reset() clears state, so ask after it
      S.restoreTries = 0;
    } else {
      layoutCols();
      maybeFill(false);
    }
  }

  // hideGallery only hides the overlay; closeGallery is the user leaving gallery mode for this page.
  function hideGallery() {
    closeLb();
    app.classList.remove('open');
    S.tiles.forEach((t) => t.el._stop?.());
    coverPage(false);
    syncFab();
    document.documentElement.style.overflow = '';
  }

  function closeGallery() {
    tabPages.del(pageKey());
    pageMem.del(memKey());
    tabFocus.del(pageKey());
    hideGallery();
    if (onGuard()) history.back();                   // drop the guard entry, so the next Back really leaves
  }

  // While the gallery is open, Back must not leave the page. The open gallery sits on a
  // history entry of its own (same address, marked in its state); a Back off that entry
  // lands on the same page underneath, and the entry is put straight back.
  // Browsers skip such an entry on Back until the page has been clicked, tapped or typed in.
  let guardKey = '';
  const onGuard = () => !!history.state?.rgGuard;
  function pushGuard() {
    guardKey = pageKey();
    if (onGuard()) return;                           // a reload lands on the guard entry again
    const state = history.state && typeof history.state === 'object' ? history.state : null;
    try { history.pushState({ ...state, rgGuard: true }, '', location.href); } catch { /* ignore */ }
  }

  // Only a deliberate open is remembered for the page.
  function toggle() {
    if (app.classList.contains('open')) return closeGallery();
    pageMem.add(memKey());
    openGallery();
  }

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyG') { e.preventDefault(); toggle(); return; }
    if (!app.classList.contains('open')) return;

    const t = e.composedPath()[0];
    const typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    if (typing) { if (e.key === 'Escape') { t.blur(); hidePanels(); } return; }

    const lbOpen = lb.classList.contains('open');
    if (lbOpen) wake();
    const panelOpen = !reportBox.hidden;
    let handled = true;
    if (e.key === 'Escape') (panelOpen ? hidePanels() : lbOpen && !cmtBox.hidden ? closeComments() : lbOpen ? closeLb() : closeGallery());
    else if (site.key(e, lbOpen)) { /* the plugin's own shortcut */ }
    else if (lbOpen && e.key === 'ArrowRight') showSlide(lbIdx + 1);
    else if (lbOpen && e.key === 'ArrowLeft') showSlide(lbIdx - 1);
    else if (lbOpen && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'f' || e.key === 'F')) toggleFullscreen();
    else if (lbOpen && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'm' || e.key === 'M')) lbMute();
    else if (lbOpen && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) toggleFill();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // The corner button, unless the plugin has put a button of its own on the page.
  function syncFab() {
    fab.hidden = app.classList.contains('open') || site.fabHidden();
  }

  /* ================================================================== *
   *  Plugin: reddit.com
   *  Feeds from Reddit's JSON listings, media extraction, post actions,
   *  comments, and a Gallery button in Reddit's own sort bar.
   *  Still in the base and Reddit-aware: the v.redd.it audio and Redgifs
   *  handling in the video helpers, and the feed / sort header controls.
   * ================================================================== */
  /* ------------------------------------------------------------------ *
   *  Source handling (what are we showing?)
   * ------------------------------------------------------------------ */
  function sourceFromLocation() {
    return { path: location.pathname.replace(/\/+$/, ''), query: new URLSearchParams(location.search) };
  }

  // Accepts: full URL, "r/pics+aww", "pics+aww", "user/name/m/feed", "u/name", "search?q=cats"
  function parseSource(input) {
    let s = (input || '').trim();
    if (/^https?:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        return { path: u.pathname.replace(/\/+$/, ''), query: u.searchParams };
      } catch { return null; }
    }
    s = s.replace(/^\/+/, '').replace(/^u\//i, 'user/');
    const [p, qs = ''] = s.split('?');
    const path = /^[\w+-]+$/.test(p) && !/^(search|popular|all)$/i.test(p) ? 'r/' + p : p;
    return { path: ('/' + path).replace(/\/+$/, ''), query: new URLSearchParams(qs) };
  }

  function sourceString() {
    const q = new URLSearchParams(S.query);
    ['sort', 't', 'after', 'count', 'raw_json', 'limit'].forEach((k) => q.delete(k));
    const qs = q.toString();
    return S.path.replace(/^\//, '') + (qs ? '?' + qs : '');
  }

  function currentSort() {
    const last = S.path.split('/').pop();
    return SORTS.includes(last) ? last : (S.query.get('sort') || '');
  }

  const isListingPath = (p) =>
    /^(\/r\/[^/]+|\/user\/[^/]+\/m\/[^/]+)?(\/(hot|new|top|rising|controversial|best))?$/i.test(p);

  function applySort(sort, time) {
    S.restore = null;
    const parts = S.path.split('/');
    if (SORTS.includes(parts[parts.length - 1])) { parts.pop(); S.path = parts.join('/'); }
    S.query.delete('sort');
    S.query.delete('t');
    if (sort) {
      if (isListingPath(S.path)) S.path += '/' + sort;
      else S.query.set('sort', sort);
      if (sort === 'top' || sort === 'controversial') S.query.set('t', time || 'day');
    }
    reset();
  }

  function jsonUrl() {
    const q = new URLSearchParams(S.query);
    q.set('raw_json', '1');
    q.set('limit', '100');
    q.delete('count');
    if (S.after) q.set('after', S.after); else q.delete('after');
    return `${location.origin}${S.path ? S.path + '.json' : '/.json'}?${q}`;
  }

  /* ------------------------------------------------------------------ *
   *  Media extraction
   * ------------------------------------------------------------------ */
  function pickThumb(resolutions, source, target = 640) {
    const list = [...(resolutions || []), source].filter(Boolean);
    if (!list.length) return '';
    return (list.find((r) => r.width >= target) || list[list.length - 1]).url;
  }

  // v.redd.it serves audio as a separate file next to the silent video track.
  // e.g. https://v.redd.it/abc123 — the audio file sits next to the video track (see audioUrls).
  function redditBase(fallbackUrl) {
    const m = /^(https:\/\/v\.redd\.it\/[^/]+)\//.exec(fallbackUrl || '');
    return m ? m[1] : '';
  }

  // Grid tiles play a 480p rendition; the lightbox keeps the full file.
  const smallDash = (u, h) => (h > 480 ? u.replace(/DASH_\d+(\.mp4)/, 'DASH_480$1') : '');

  function extractMedia(post) {
    const src = post.crosspost_parent_list?.[0] || post;
    const prev = src.preview?.images?.[0];
    const prevThumb = prev ? pickThumb(prev.resolutions, prev.source) : '';
    const url = src.url_overridden_by_dest || src.url || '';

    // 1. Reddit galleries
    if (src.is_gallery && src.gallery_data && src.media_metadata) {
      const out = [];
      for (const g of src.gallery_data.items) {
        const m = src.media_metadata[g.media_id];
        if (!m || m.status !== 'valid' || !m.s) continue;
        const isGif = m.e === 'AnimatedImage' && (!m.m || /gif/i.test(m.m));   // else animated WebP etc.
        const thumb = m.p?.length ? (m.p.find((r) => r.x >= 640) || m.p[m.p.length - 1]).u : (m.s.u || m.s.gif);
        if (m.e === 'AnimatedImage' && m.s.mp4) {
          out.push({ type: 'video', src: m.s.mp4, thumb, w: m.s.x, h: m.s.y, animated: true, gif: isGif, sound: false });
        } else if (m.s.u || m.s.gif) {
          out.push({ type: 'image', src: m.s.u || m.s.gif, thumb, w: m.s.x, h: m.s.y, animated: m.e === 'AnimatedImage', gif: isGif });
        }
      }
      return out;
    }

    // 2. v.redd.it video (the MP4 is silent; audio is a separate file, see makeVideo)
    const rv = src.secure_media?.reddit_video || src.media?.reddit_video;
    if (rv?.fallback_url) {
      const silent = !!rv.is_gif || rv.has_audio === false;
      return [{
        type: 'video', src: rv.fallback_url, tile: smallDash(rv.fallback_url, rv.height), thumb: prevThumb, w: rv.width, h: rv.height,
        audio: silent ? '' : redditBase(rv.fallback_url), dash: rv.dash_url || '',
        sound: silent ? false : rv.has_audio,             // undefined when Reddit does not say
        animated: !!rv.is_gif, gif: !!rv.is_gif,          // Reddit converts uploaded GIFs into looping "videos"
      }];
    }

    // 3. GIFs that Reddit converted to MP4. Reddit's copies of Redgifs clips are silent previews;
    //    `redgifs` marks them so makeVideo can swap in the real file, which may have sound.
    const rg = /redgifs\.com\/(?:watch|ifr)\/([a-z0-9]+)/i.exec(url)?.[1]?.toLowerCase();
    const gifMp4 = prev?.variants?.mp4?.source;
    if (gifMp4?.url) {
      const small = prev.variants.mp4.resolutions?.find((r) => r.width >= 640);
      return [{ type: 'video', src: gifMp4.url, tile: small?.url, thumb: prevThumb, w: gifMp4.width, h: gifMp4.height, animated: true, gif: !rg,
        ...(rg ? { redgifs: rg } : { sound: false }) }];
    }
    const rvp = src.preview?.reddit_video_preview;
    if (rvp?.fallback_url) {
      return [{ type: 'video', src: rvp.fallback_url, tile: smallDash(rvp.fallback_url, rvp.height), thumb: prevThumb, w: rvp.width, h: rvp.height, animated: rvp.is_gif !== false,
        ...(rg ? { redgifs: rg } : { sound: false }) }];
    }
    if (/\.gifv(\?|$)/i.test(url)) {
      return [{ type: 'video', src: url.replace(/\.gifv(\?.*)?$/i, '.mp4'), thumb: prevThumb, w: prev?.source?.width, h: prev?.source?.height, animated: true, gif: true }];
    }

    // 4. Direct images
    if (/\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(url) || src.post_hint === 'image' || /^https?:\/\/(i\.redd\.it|i\.imgur\.com)\//i.test(url)) {
      return [{ type: 'image', src: url, thumb: prevThumb || url, w: prev?.source?.width, h: prev?.source?.height, animated: /\.gif(\?|$)/i.test(url), gif: /\.gif(\?|$)/i.test(url) }];
    }

    // 5. Link posts that only carry a preview image (articles, imgur pages, etc.)
    if (cfg.previews && prev?.source?.url) {
      return [{ type: 'image', src: prev.source.url, thumb: prevThumb, w: prev.source.width, h: prev.source.height, external: true }];
    }
    return [];
  }

  async function redditLoad() {
    if (S.loading || S.done) return;
    S.loading = true;
    const gen = S.gen;
    setStatus('Loading…');
    try {
      const res = await fetch(jsonUrl(), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) {
        throw new Error(
          res.status === 429 ? 'Reddit is rate limiting requests (429). Wait a moment, then click here to retry.' :
          res.status === 403 ? 'Reddit refused access (403). The feed may be private, quarantined or age-gated. Click here to retry.' :
          res.status === 404 ? 'Nothing found at this address (404).' :
          `Request failed (HTTP ${res.status}). Click here to retry.`);
      }
      let json;
      try { json = await res.json(); } catch { throw new Error('Reddit did not return a listing for this page.'); }
      if (gen !== S.gen) return;

      const listing = Array.isArray(json) ? json[0] : json;      // comment pages return [post, comments]
      const children = listing?.data?.children || [];
      S.after = listing?.data?.after || null;
      if (!S.after) S.done = true;

      let added = 0;
      for (const c of children) {
        if (c.kind !== 't3') continue;
        const post = c.data;
        if (S.seen.has(post.name)) continue;                      // same post again, from overlapping pages
        S.seen.add(post.name);
        const items = extractMedia(post);
        if (!items.length) continue;
        const key = mediaKey(items);
        if (key) {
          if (S.media.has(key)) { S.dupes++; continue; }
          S.media.add(key);
        }
        S.all.push({ post, items });
        const shown = items.filter(matchesFilter);
        if (!shown.length) continue;
        addPost(post, shown);
        added++;
      }
      S.emptyStreak = added ? 0 : S.emptyStreak + 1;
      updateCount();
      refreshStatus();
      maybeRestore();
    } catch (e) {
      if (gen === S.gen) setStatus(e.message || String(e), true);
    } finally {
      if (gen === S.gen) {
        S.loading = false;
        if (S.restore && !S.done) loadMore();   // keep paging until the remembered item turns up
        else maybeFill(true);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   *  Post actions (vote, save, hide, follow, report, …)
   *  These use Reddit's own endpoints with your logged-in session, the same
   *  way the site does. Writing needs the session's modhash.
   * ------------------------------------------------------------------ */
  const actsEl = $('.acts'), menuEl = $('.menu'), postbar = $('.postbar'), toastEl = $('.toast'), reportBox = $('#reportBox');
  let modhash = null;
  let toastTimer;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  async function getModhash() {
    if (modhash !== null) return modhash;
    try {
      const r = await fetch(location.origin + '/api/me.json?raw_json=1', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const j = await r.json();
      modhash = j?.data?.modhash || '';
    } catch { modhash = ''; }
    return modhash;
  }

  async function api(path, params) {
    const uh = await getModhash();
    const body = new URLSearchParams({ api_type: 'json', ...params });
    if (uh) body.set('uh', uh);
    const res = await fetch(location.origin + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(uh ? { 'X-Modhash': uh } : {}) },
      body,
    });
    if (res.status === 403) { modhash = null; throw new Error('Reddit refused that (403). Log in to Reddit in this tab and try again.'); }
    if (res.status === 429) throw new Error('Reddit is rate limiting requests. Wait a moment.');
    if (!res.ok) throw new Error(`Reddit returned HTTP ${res.status}.`);
    let j = null;
    try { j = JSON.parse(await res.text()); } catch { /* some endpoints return an empty body */ }
    const err = j?.json?.errors?.[0];
    if (err) throw new Error(err[1] || err[0]);
    return j;
  }

  const openTab = (url) => window.open(url, '_blank', 'noopener');
  const postUrl = (post) => location.origin + post.permalink;

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* fall through */ }
    const ta = el('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    root.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('The browser would not copy the link.');
  }

  const voteVal = (l) => (l === true ? 1 : l === false ? -1 : 0);

  async function doAction(key, post) {
    switch (key) {
      case 'upvote':
      case 'downvote': {
        const want = key === 'upvote';
        const dir = post.likes === want ? 0 : want ? 1 : -1;
        const before = voteVal(post.likes);
        await api('/api/vote', { id: post.name, dir: String(dir), rank: '2' });
        post.likes = dir === 0 ? null : want;
        post.score = (post.score || 0) + voteVal(post.likes) - before;
        break;
      }
      case 'save':
        await api(post.saved ? '/api/unsave' : '/api/save', { id: post.name });
        post.saved = !post.saved;
        toast(post.saved ? 'Saved' : 'Removed from saved');
        break;
      case 'hide':
        await api(post.hidden ? '/api/unhide' : '/api/hide', { id: post.name });
        post.hidden = !post.hidden;
        toast(post.hidden ? 'Hidden on Reddit, still shown here' : 'Unhidden');
        break;
      case 'follow':
        await api('/api/follow_post', { fullname: post.name, follow: String(!post._followed) });
        post._followed = !post._followed;
        toast(post._followed ? 'Following this post' : 'Stopped following');
        break;
      case 'comment':
        toggleComments(post);
        break;
      case 'share':
        await copyText(postUrl(post));
        toast('Link copied');
        break;
      case 'repost':
        openTab(`${location.origin}/submit?crosspost_fullname=${encodeURIComponent(post.name)}`);
        break;
      case 'report':
        openReport(post);
        break;
    }
  }

  async function runAction(a, post, btn) {
    if (btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    try { await doAction(a.key, post); }
    catch (e) { toast(e.message || String(e)); }
    finally { btn.classList.remove('busy'); syncActions(post); }
  }

  function syncActions(post) {
    if (!post) return;
    const state = {
      upvote: post.likes === true,
      downvote: post.likes === false,
      follow: !!post._followed,
      save: !!post.saved,
      hide: !!post.hidden,
      report: !!post._reported,
      comment: !cmtBox.hidden,
    };
    for (const b of postbar.querySelectorAll('.pa')) {
      const a = ACTIONS.find((x) => x.key === b.dataset.k);
      const on = !!state[a.key];
      b.classList.toggle('on', on);
      const label = a.key === 'comment' ? plural(post.num_comments, 'comment') : on && a.on ? a.on : a.label;
      b.querySelector('.t').textContent = label;
      b.title = a.key === 'comment' ? 'Show the comments here (C)' : label;
      b.setAttribute('aria-pressed', String(on));
    }
    if (scoreEl) {
      scoreEl.textContent = post.hide_score ? '•' : fmt(post.score);
      scoreEl.className = 'score' + (post.likes === true ? ' up' : post.likes === false ? ' down' : '');
      scoreEl.title = post.hide_score ? 'Score hidden for now'
        : `${post.score} point${post.score === 1 ? '' : 's'}` + (post.upvote_ratio ? `, ${Math.round(post.upvote_ratio * 100)}% upvoted` : '');
    }
  }

  function renderActions() {
    actsEl.replaceChildren();
    menuEl.replaceChildren();
    const s = S.slides[lbIdx];
    postbar.hidden = false;
    if (!s) return;
    let votes = null;
    for (const a of ACTIONS) {
      const b = el('button', 'pa' + (a.cls ? ' ' + a.cls : ''));
      b.dataset.k = a.key;
      setHTML(b, `<svg viewBox="0 0 24 24" aria-hidden="true">${a.icon}</svg>`);
      b.append(el('span', 't', a.label));
      b.onclick = () => runAction(a, S.slides[lbIdx]?.post || s.post, b);
      if (a.key === 'upvote' || a.key === 'downvote') {   // ↑ score ↓ as one pill
        if (!votes) { votes = el('span', 'votes'); actsEl.append(votes); }
        votes.append(b);
        if (a.key === 'upvote') { scoreEl = el('span', 'score'); votes.append(scoreEl); }
        continue;
      }
      (a.menu ? menuEl : actsEl).append(b);
    }
    syncActions(s.post);
  }

  const hidePanels = () => { reportBox.hidden = true; };

  /* ---- comments panel: the thread beside the media, read from the post's .json ---- */
  const cmtBox = $('#cmts'), cmtList = $('#cmList');
  const cmtCache = new Map();    // post name + sort -> rendered thread
  let cmtPost = null;

  function toggleComments(post) {
    if (!cmtBox.hidden) closeComments();
    else openComments(post);
  }
  function openComments(post) {
    cmtBox.hidden = false;
    lb.classList.add('cmt');
    loadComments(post);
  }
  function closeComments() {
    if (cmtBox.hidden) return;
    cmtBox.hidden = true;
    lb.classList.remove('cmt');
    cmtPost = null;
    syncActions(S.slides[lbIdx]?.post);
  }

  function renderComment(c, post) {
    const d = c.data;
    if (c.kind === 'more') {
      if (!d.count) return null;
      const more = el('a', 'cmore', `${d.count} more repl${d.count > 1 ? 'ies' : 'y'} on Reddit`);
      more.href = location.origin + post.permalink + (d.parent_id?.startsWith('t1_') ? d.parent_id.slice(3) + '/' : '');
      more.target = '_blank';
      more.rel = 'noopener noreferrer';
      return more;
    }
    const n = el('div', 'cm');
    const head = el('div', 'chd');
    const who = el('a', 'cau' + (d.is_submitter ? ' op' : ''), d.author);
    who.href = `${location.origin}/user/${d.author}`;
    who.target = '_blank';
    who.rel = 'noopener noreferrer';
    head.append(who, el('span', '', d.score_hidden ? 'score hidden' : plural(d.score, 'point')), el('span', '', ago(d.created_utc)));
    if (d.stickied) head.append(el('span', 'pin', 'pinned'));
    const aw = awardsEl(d);
    if (aw) head.append(aw);
    head.title = 'Collapse or expand';
    head.addEventListener('click', (e) => { if (!e.target.closest('a')) n.classList.toggle('folded'); });
    const body = el('div', 'cbd');
    body.append(cleanHtml(d.body_html));
    n.append(head, body);
    const kids = d.replies?.data?.children || [];
    if (kids.length) {
      const k = el('div', 'ckids');
      for (const r of kids) { const x = renderComment(r, post); if (x) k.append(x); }
      n.append(k);
    }
    return n;
  }

  async function loadComments(post) {
    cmtPost = post;
    const sort = cfg.cmtSort;
    $('#cmTitle').textContent = plural(post.num_comments, 'comment');
    $('#cmOpen').href = location.origin + post.permalink;
    $('#cmSort').value = sort;
    cmtList.scrollTop = 0;
    syncActions(post);
    const key = post.name + ' ' + sort;
    if (cmtCache.has(key)) { cmtList.replaceChildren(cmtCache.get(key)); return; }
    cmtList.replaceChildren(el('div', 'cnote', 'Loading comments…'));
    try {
      const res = await fetch(`${location.origin}${post.permalink.replace(/\/?$/, '/')}.json?raw_json=1&limit=200&depth=8&sort=${sort}`,
        { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(res.status === 429 ? 'Reddit is rate limiting requests. Wait a moment.' : `Reddit returned HTTP ${res.status}.`);
      const json = await res.json();
      if (cmtPost !== post || cfg.cmtSort !== sort) return;      // moved on while this was loading
      const wrap = el('div');
      for (const c of json?.[1]?.data?.children || []) { const x = renderComment(c, post); if (x) wrap.append(x); }
      if (!wrap.childNodes.length) wrap.append(el('div', 'cnote', 'No comments yet.'));
      cmtCache.set(key, wrap);
      cmtList.replaceChildren(wrap);
    } catch (e) {
      if (cmtPost !== post) return;
      const err = el('div', 'cnote err', (e.message || String(e)) + ' Click to retry.');
      err.onclick = () => loadComments(post);
      cmtList.replaceChildren(err);
    }
  }

  $('#cmClose').onclick = closeComments;
  $('#cmSort').onchange = (e) => {
    cfg.cmtSort = e.target.value;
    store.set('cmtSort', cfg.cmtSort);
    e.target.blur();
    if (cmtPost) loadComments(cmtPost);
  };

  /* ---- report ---- */
  let reportPost = null;
  const reasonSel = $('#reportReason');
  REPORT_REASONS.forEach((r) => reasonSel.append(new Option(r, r)));
  function openReport(post) {
    reportPost = post;
    $('#reportText').value = '';
    reportBox.hidden = false;
  }
  $('#reportCancel').onclick = hidePanels;
  $('#reportSend').onclick = async () => {
    const post = reportPost;
    if (!post) return;
    const reason = reasonSel.value;
    const other = $('#reportText').value.trim();
    hidePanels();
    try {
      await api('/api/report', {
        thing_id: post.name,
        reason,
        ...(reason === 'other' || other ? { other_reason: other || reason } : {}),
      });
      post._reported = true;
      toast('Report sent');
    } catch (e) {
      toast(e.message || String(e));
    }
    syncActions(post);
  };

  SITES.reddit = {
    cls: 'reddit',
    referrer: 'no-referrer',
    hidePage: true,              // Reddit's own feed and players stop rendering under the gallery
    load: redditLoad,
    postHref: (post) => location.origin + post.permalink + HANDOFF,
    key(e, lbOpen) {
      if (!lbOpen || e.ctrlKey || e.metaKey || e.altKey || !/^c$/i.test(e.key)) return false;
      toggleComments(S.slides[lbIdx].post);
      return true;
    },
    fabHidden: () => false,
    button: syncFab,
    start: syncFab,
  };

  // <web>
  /* ------------------------------------------------------------------ *
   *  Plugin: any site, part 2. Loading (see scan / pickGrid above). Three sources,
   *  tried in order: what the page shows now, what its own infinite scroll
   *  adds when the page underneath is scrolled, and its "next page" link.
   * ------------------------------------------------------------------ */
  let G = null;
  const webState = () => (G && G.gen === S.gen ? G : (G = {
    gen: S.gen, done: new WeakSet(), sigs: new Set(), noGrow: 0, next: undefined, visited: new Set([location.href.split('#')[0]]),
  }));

  function harvest(found, g) {
    let added = 0;
    for (const c of pickGrid(found, g.sigs)) {
      if (g.done.has(c.node)) continue;
      g.done.add(c.node);
      const item = { type: c.type, src: c.src, thumb: c.thumb, w: c.w, h: c.h, animated: !!c.animated, gif: !!c.gif, external: !!c.external };
      if (c.tile) item.tile = c.tile;
      // A still or a hover clip that links to a page of its own: the real video may be there.
      if (c.link && !c.external && !c.gif && (c.tile || c.type === 'image') && c.link.split('#')[0] !== location.href.split('#')[0] &&
        new URL(c.link).origin === location.origin) item.page = c.link;
      const key = mediaKey([item]);
      if (key) {
        if (S.media.has(key)) continue;              // the same file twice on one page is not a repost
        S.media.add(key);
      }
      let file = c.src.split(/[?#]/)[0].split('/').pop() || '';
      try { file = decodeURIComponent(file); } catch { /* keep it as it is */ }
      const post = { name: 'web:' + (key || c.src), title: c.title || file, link: c.link || c.src, url: c.link || c.src };
      S.all.push({ post, items: [item] });
      if (!matchesFilter(item)) continue;
      addPost(post, [item]);
      added++;
    }
    return added;
  }

  // Scrolls the real page (it stays rendered under the gallery) and waits for it to settle.
  function grow() {
    return new Promise((resolve) => {
      let quiet;
      const done = () => { mo.disconnect(); clearTimeout(quiet); clearTimeout(cap); resolve(); };
      const mo = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, 500); });
      mo.observe(document.body, { childList: true, subtree: true });
      const cap = setTimeout(done, 4000);
      quiet = setTimeout(done, 1500);                // nothing moved: the page has no more to give
      scrollTo(0, (document.scrollingElement || document.documentElement).scrollHeight);
    });
  }

  const NEXT_TEXT = /^\s*(next|next page|older|older posts|more|›|»|→|>|>>)\s*$/i;
  function findNext(doc, base, g) {
    const links = [
      doc.querySelector('link[rel~="next"][href]'), doc.querySelector('a[rel~="next"][href]'),
      ...[...doc.querySelectorAll('a[href]')].filter((a) => NEXT_TEXT.test(a.textContent) ||
        /\bnext\b/i.test((a.getAttribute('aria-label') || '') + ' ' + (a.getAttribute('class') || ''))),
    ];
    for (const n of links) {
      const u = n ? abs(n.getAttribute('href'), base).split('#')[0] : '';
      if (u && new URL(u).origin === location.origin && !g.visited.has(u)) return u;
    }
    return '';
  }

  async function nextPage(g, gen) {
    if (g.next === undefined) g.next = findNext(document, location.href, g);
    const url = g.next;
    if (!url) return 0;
    g.visited.add(url);
    g.next = '';
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok || gen !== S.gen) return 0;
    const doc = new DOMParser().parseFromString(trusted(await res.text()), 'text/html');
    if (gen !== S.gen) return 0;
    g.next = findNext(doc, url, g);
    return harvest(scan(doc, url, false), g);
  }

  async function webLoad() {
    if (S.loading || S.done) return;
    S.loading = true;
    const gen = S.gen, g = webState();
    setStatus('Loading…');
    try {
      let added = harvest(scan(document, location.href, true), g);
      if (!added && g.noGrow < 2) {                  // two fruitless tries: this page does not grow
        await grow();
        if (gen !== S.gen) return;
        added = harvest(scan(document, location.href, true), g);
        g.noGrow = added ? 0 : g.noGrow + 1;
      }
      if (!added) {
        added = await nextPage(g, gen);
        if (gen !== S.gen) return;
      }
      if (!added && g.noGrow >= 2 && !g.next) S.done = true;
      S.emptyStreak = added ? 0 : S.emptyStreak + 1;
      updateCount();
      refreshStatus();
      maybeRestore();
    } catch (e) {
      if (gen === S.gen) setStatus(e.message || String(e), true);
    } finally {
      if (gen === S.gen) {
        S.loading = false;
        if (S.restore && !S.done) loadMore();
        else maybeFill(true);
      }
    }
  }

  // The video file a detail page plays, best quality first: its <video>, its og:video, or
  // the address in its player set-up script.
  const VID_FILE = /\.(?:mp4|webm|m4v|mov)(?=[/?#]|$)/i;
  function videoIn(html, base) {
    const doc = new DOMParser().parseFromString(trusted(html), 'text/html');
    const found = [];
    for (const n of doc.querySelectorAll('video[src],video source[src]')) {
      found.push([n.getAttribute('src'), ['label', 'title', 'res', 'size'].map((k) => n.getAttribute(k) || '').join(' ')]);
    }
    for (const n of doc.querySelectorAll('meta[property^="og:video"],meta[name="twitter:player:stream"]')) found.push([n.getAttribute('content'), '']);
    for (const m of html.matchAll(/["']?(?:video_(?:alt_)?url\d*|contentUrl|videoUrl|file|src)["']?\s*[:=]\s*["'](https?:[^"'\s]+)["']/g)) {
      found.push([m[1].replace(/\\\//g, '/'), '']);
    }
    let best = '', score = -1;
    for (const [u, label] of found) {
      const url = VID_FILE.test(u || '') ? abs(u, base) : '';
      const q = +(/(\d{3,4})p?\b/.exec(label) || /(\d{3,4})p\b/.exec(url) || [0, 0])[1];
      if (url && q > score) { best = url; score = q; }
    }
    return best;
  }

  const pageVideo = new Map();   // detail page -> promise of its video file ('' when it has none)
  const videoFrom = new Map();   // video file -> the page it was found on
  // Resolves to true once the item has been given the video from its own page.
  function webFull(item) {
    const page = item.page;
    if (!page) return null;
    if (!pageVideo.has(page)) {
      pageVideo.set(page, fetch(page, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.text() : ''))
        .then((html) => {
          const url = html ? videoIn(html, page) : '';
          // The same file on several pages is the site's own clip (an advert, a banner), not this item.
          if (!url || (videoFrom.has(url) && videoFrom.get(url) !== page)) return '';
          videoFrom.set(url, page);
          return url;
        })
        .catch(() => ''));
    }
    return pageVideo.get(page).then((url) => {
      if (item.page !== page) return false;
      item.page = '';
      if (!url || url === item.src) return false;
      if (item.type === 'image') item.thumb = item.thumb || item.src;
      Object.assign(item, { type: 'video', src: url, sound: undefined, animated: false, gif: false });
      return true;
    });
  }

  SITES.web = {
    cls: 'web',
    referrer: '',                // other sites often refuse their media without their own referer
    hidePage: false,             // the page stays rendered: its lazy loading and infinite scroll feed the gallery
    load: webLoad,
    full: webFull,
    postHref: (post) => post.link,
    key: () => false,
    fabHidden: fabOff,
    button: syncFab,
    start: syncFab,
  };
  // </web>

  const site = SITES[REDDIT ? 'reddit' : 'web'];
  app.classList.add(site.cls);

  /* ------------------------------------------------------------------ *
   *  Menu commands + remembered pages (Reddit navigates without reloads)
   * ------------------------------------------------------------------ */
  renderFeeds();
  applyFit();
  renderToolbar();
  renderActions();
  restartGalleryTimer();
  $('#update').onclick = openUpdate;
  $('#ver').textContent = 'v' + VERSION;
  $('.brand').title = ABOUT;
  if (newerThan(store.get('newVersion', ''), VERSION)) offerUpdate(store.get('newVersion', ''));
  checkUpdate();                                     // at most one request per 15 minutes

  // Opened in a new tab from the gallery: adopt gallery mode for this page, then tidy the URL.
  if (location.hash === HANDOFF) {
    tabPages.add(pageKey());
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch { /* ignore */ }
  }

  const wantGallery = () => tabPages.has(pageKey()) || pageMem.has(memKey());

  // Reddit navigates without reloading, so watch for URL changes (including Back/Forward).
  let lastHref = location.href, lastKey = pageKey();
  function navCheck() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const key = pageKey();
    const keyChanged = key !== lastKey;              // pageKey ignores tracking params Reddit adds to the same page
    lastKey = key;
    const isOpen = app.classList.contains('open');
    if (wantGallery()) { if (!isOpen || keyChanged) openGallery(true); }
    else if (isOpen && keyChanged) hideGallery();    // went Back/Forward to a page that isn't in gallery mode
    site.button(true, true);                         // the site may have rebuilt the place its button lives in
  }
  setInterval(navCheck, 600);
  addEventListener('popstate', () => {               // Back/Forward: no need to wait for the poll
    // One step back from an open gallery is still the same page: stay in the gallery.
    // A jump to another page (history menu) is a real navigation and goes through navCheck.
    if (app.classList.contains('open') && !onGuard() && pageKey() === guardKey) pushGuard();
    else navCheck();
  });

  site.start();



  if (wantGallery()) openGallery(true);
  return { toggle, checkUpdate, syncFab };
  }   // main

  /* ------------------------------------------------------------------ *
   *  Start. Reddit gets the gallery at once. Any other site gets nothing
   *  but a key listener and one look for a media grid, until it is needed.
   * ------------------------------------------------------------------ */
  let gallery = null;
  const start = () => gallery || (gallery = main());
  const menu = (label, fn) => { try { GM_registerMenuCommand(label, fn); } catch { /* no menu here */ } };
  menu('Open gallery (Alt+G)', () => start().toggle());
  menu('Check for an update now', () => start().checkUpdate(true));
  {
    const info = typeof GM_info !== 'undefined' ? GM_info : {};
    const text = `Version ${info.script?.version || '?'}` + (info.loader ? ` (loader ${info.loader})` : '');
    menu(text, () => alert(`Web Gallery View\n${text}\nhttps://github.com/realteamnet/RedditGallery`));
  }
  if (REDDIT) { start(); return; }
  // <web>

  menu('Show / hide the Gallery button on this site', () => {
    const list = store.get('fabOff', []).filter((h) => h !== location.host);
    if (!fabOff()) list.push(location.host);
    store.set('fabOff', list);
    gallery?.syncFab();
  });
  if (!document.body || !/html/i.test(document.contentType || 'html')) return;
  if (pageMem.has(memKey())) { start(); return; }    // a remembered page: main opens it

  document.addEventListener('keydown', (e) => {
    if (gallery || !(e.altKey && e.code === 'KeyG')) return;   // once it runs, the gallery has its own listener
    e.preventDefault();
    start().toggle();
  }, true);

  // The corner button appears by itself only where the page has a media grid.
  const look = () => {
    if (gallery || fabOff()) return;
    const found = scan(document, location.href, true);
    if (found.top >= 6 && pickGrid(found).length >= 8) start();
  };
  (window.requestIdleCallback || setTimeout)(look, { timeout: 2000 });
  setTimeout(look, 4000);                            // lazy pages fill in late
  addEventListener('popstate', () => setTimeout(look, 1500));
  // </web>
})();
