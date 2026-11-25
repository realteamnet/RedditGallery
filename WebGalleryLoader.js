// Web Gallery View loader 1.0.0
//
// Stage 2 of 3. Not a userscript: WebGalleryView.user.js (stage 1, the installed file) keeps
// a copy of this file and runs it on every page. This file keeps a copy of the gallery
// (WebGalleryCore.user.js, stage 3) and runs that. Both copies are replaced in the
// background when the repository has newer ones, so stage 1 almost never has to change.
//
// The first line must stay "// Web Gallery View loader <version>": stage 1 and this file
// both refuse anything that does not start with it.
//
// Runs inside a function whose parameters are the GM_* functions stage 1 was granted.
'use strict';

const REPO = 'https://raw.githubusercontent.com/realteamnet/RedditGallery/main/';
const EVERY = 15 * 60 * 1000;              // look for newer copies at most this often
const get = (k, d) => { try { const v = GM_getValue(k); return v === undefined ? d : v; } catch { return d; } };
const set = (k, v) => { try { GM_setValue(k, v); } catch { /* ignore */ } };

const versionOf = (code) => /^\/\/ @version\s+(\S+)/m.exec(code || '')?.[1] || '';
const isCore = (code) => /^\/\/ ==UserScript==/.test(code) && /^\/\/ @name\s+Web Gallery View \(core\)\s*$/m.test(code) && !!versionOf(code);
const isLoader = (code) => /^\/\/ Web Gallery View loader \d/.test(code);
// A copy that does not even parse must never replace one that works.
const parses = (code) => { try { new Function(code); return true; } catch (e) { return !(e instanceof SyntaxError); } };

const SELF = /^\/\/ Web Gallery View loader (\S+)/.exec(get('shim2', ''))?.[1] || '?';

// The gallery reads its version and update address from GM_info. It gets its own version
// and no address: updating is done here, so the gallery never offers an update itself.
function run(code) {
  const info = {
    ...GM_info, script: { ...GM_info.script, version: versionOf(code) }, scriptMetaStr: '',
    loader: `${SELF}, shim ${GM_info.script.version}`,
  };
  try {
    new Function('GM_info', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand', 'GM_xmlhttpRequest', code)(
      info, GM_getValue, GM_setValue, GM_registerMenuCommand, GM_xmlhttpRequest);
  } catch (e) {
    // Some sites forbid running fetched code (a strict Content-Security-Policy).
    console.warn('[Web Gallery View] could not run the gallery on this page:', e);
  }
}

// A conditional request: with the stored copy's ETag GitHub answers "not modified" and
// sends nothing unless the file changed. GitHub caches each address for up to 5 minutes
// (a query string does not get around that), so a new version is that much late at most.
function update(file, key, valid, then) {
  const stored = get(key, ''), etag = stored && get(key + '.etag', '');
  const done = (code) => then && then(code);
  try {
    GM_xmlhttpRequest({
      method: 'GET',
      url: REPO + file,
      headers: etag ? { 'If-None-Match': etag } : {},
      timeout: 15000,
      onload: (r) => {
        if (r.status === 304) { done(stored); return; }
        const code = r.responseText || '';
        if (r.status !== 200 || !valid(code) || !parses(code)) { done(''); return; }   // keep the stored copy
        set(key, code);
        set(key + '.etag', /^etag:\s*(\S+)/im.exec(r.responseHeaders || '')?.[1] || '');
        done(code);
      },
      onerror: () => done(''),
      ontimeout: () => done(''),
    });
  } catch { done(''); }
}

function refresh(then) {
  set('loader.at', Date.now());
  update('WebGalleryLoader.js', 'shim2', isLoader);          // this file; used from the next page on
  update('WebGalleryCore.user.js', 'loader.code', isCore, then);
}

try {
  GM_registerMenuCommand('Fetch the latest gallery now', () => refresh((code) => {
    alert(code ? `Web Gallery View ${versionOf(code)} is stored. Reload the page to use it.` : 'Could not fetch the gallery from GitHub.');
  }));
} catch { /* no menu here */ }

const core = get('loader.code', '');
if (core) {
  run(core);
  if (Date.now() - get('loader.at', 0) > EVERY) refresh();   // takes effect on the next page
} else {
  refresh((code) => { if (code) run(code); });               // first use: nothing stored yet
}
