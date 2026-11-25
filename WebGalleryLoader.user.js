// ==UserScript==
// @name         Web Gallery View (auto-updating loader)
// @namespace    https://violentmonkey.github.io/
// @version      1.1.0
// @description  Runs the latest Web Gallery View straight from GitHub, so new versions arrive by themselves with no install prompt. Install this INSTEAD of WebGalleryView.user.js.
// @homepageURL  https://github.com/realteamnet/RedditGallery
// @downloadURL  https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryLoader.user.js
// @updateURL    https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryLoader.user.js
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

// This file is only a loader. The gallery itself is WebGalleryView.user.js, next to it in
// the repository:  https://github.com/realteamnet/RedditGallery/blob/main/WebGalleryView.user.js
//
// What it does: keeps a copy of that file in the userscript manager's storage, runs the
// copy on every page, and replaces it in the background when GitHub has a newer one. A new
// version therefore takes effect on the next page you open, without any prompt.
//
// What that means: whatever is on the repository's main branch runs on every site you
// visit, with this script's permissions, without you seeing it first. Use the plain
// WebGalleryView.user.js instead if you want to confirm each update yourself.
//
// The permissions above are the gallery's. A gallery version that needs a new one only
// works after this loader has been updated the normal way.
(() => {
  'use strict';

  const REPO = 'https://raw.githubusercontent.com/realteamnet/RedditGallery/';
  const VERSION_FILE = REPO + 'main/version.json';
  const FILE = 'WebGalleryView.user.js';
  const EVERY = 15 * 60 * 1000;            // look for a newer copy at most this often
  const get = (k, d) => { try { const v = GM_getValue(k); return v === undefined ? d : v; } catch { return d; } };
  const set = (k, v) => { try { GM_setValue(k, v); } catch { /* ignore */ } };
  const versionOf = (code) => /^\/\/ @version\s+(\S+)/m.exec(code || '')?.[1] || '';
  const genuine = (code) => /^\/\/ ==UserScript==/.test(code || '') && /^\/\/ @name\s+Web Gallery View\s*$/m.test(code) && !!versionOf(code);

  // The gallery reads its version and update address from GM_info. It gets its own version
  // and no address: updating is this loader's job, so the gallery never offers one itself.
  function run(code) {
    const info = { ...GM_info, script: { ...GM_info.script, version: versionOf(code) }, scriptMetaStr: '' };
    try {
      new Function('GM_info', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand', 'GM_xmlhttpRequest', code)(
        info, GM_getValue, GM_setValue, GM_registerMenuCommand, GM_xmlhttpRequest);
    } catch (e) {
      // Some sites forbid running fetched code (a strict Content-Security-Policy).
      console.warn('[Web Gallery loader] could not run the gallery on this page:', e);
    }
  }

  function download(url, then) {
    try {
      GM_xmlhttpRequest({
        method: 'GET', url, headers: { 'Cache-Control': 'no-cache' }, timeout: 15000,
        onload: (r) => then(r.status === 200 ? r.responseText || '' : ''),
        onerror: () => then(''),
        ontimeout: () => then(''),
      });
    } catch { then(''); }
  }

  // GitHub serves every address from a 5-minute cache, so the gallery is never fetched from
  // the moving "main" address. A small version file says which release is current, and the
  // gallery comes from that release's own address (its git tag), whose content never changes.
  function refresh(then) {
    set('loader.at', Date.now());
    download(VERSION_FILE + '?t=' + Date.now(), (text) => {
      let info = null;
      try { info = JSON.parse(text); } catch { /* an error page, not the version file */ }
      const stored = get('loader.code', '');
      if (!info || !/^\d+(\.\d+)*$/.test(info.version || '') || !/^[\w.-]+$/.test(info.ref || '')) { then?.(''); return; }
      if (info.version === versionOf(stored)) { then?.(stored); return; }          // already have it
      download(REPO + info.ref + '/' + FILE, (code) => {
        if (!genuine(code) || versionOf(code) !== info.version) { then?.(''); return; }   // keep the last good copy
        set('loader.code', code);
        then?.(code);
      });
    });
  }

  try {
    GM_registerMenuCommand('Fetch the latest gallery now', () => refresh((code) => {
      alert(code ? `Web Gallery View ${versionOf(code)} is stored. Reload the page to use it.` : 'Could not fetch the gallery from GitHub.');
    }));
  } catch { /* no menu here */ }

  const cached = get('loader.code', '');
  if (cached) {
    run(cached);
    if (Date.now() - get('loader.at', 0) > EVERY) refresh();   // takes effect on the next page
  } else {
    refresh((code) => { if (code) run(code); });               // first use: nothing stored yet
  }
})();
