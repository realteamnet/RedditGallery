// ==UserScript==
// @name         Web Gallery View
// @namespace    https://violentmonkey.github.io/
// @version      3.1.0
// @description  Show a page's pictures, GIFs and videos as a media gallery with infinite scroll and a lightbox. Best-effort on any site with a media grid; full support for Reddit. Keeps itself up to date from GitHub.
// @homepageURL  https://github.com/realteamnet/RedditGallery
// @downloadURL  https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryView.user.js
// @updateURL    https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryView.user.js
// @match        *://*/*
// @noframes
// @run-at       document-idle
// @grant        GM_info
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @connect      raw.githubusercontent.com
// @connect      v.redd.it
// @connect      api.redgifs.com
// @connect      media.redgifs.com
// ==/UserScript==

// Stage 1 of 3, and deliberately almost nothing, so that it rarely has to be updated: it
// runs its stored copy of stage 2 (WebGalleryLoader.js) and fetches one if it has none.
// Stage 2 keeps itself and the gallery (WebGalleryCore.user.js, stage 3) up to date. All
// three files sit next to each other:  https://github.com/realteamnet/RedditGallery
//
// Whatever is on that repository's main branch therefore runs on every site you visit, with
// the permissions above (some are for later use), without you seeing it first. Install
// WebGalleryCore.user.js instead if you want to confirm each update yourself.
(() => {
  'use strict';
  const NEXT = 'https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryLoader.js';
  const GM = { GM_info, GM_getValue, GM_setValue, GM_deleteValue, GM_registerMenuCommand, GM_xmlhttpRequest, GM_download, GM_openInTab, GM_setClipboard };

  function run(code) {
    let stage2;
    try { stage2 = new Function(...Object.keys(GM), code); } catch (e) {
      if (e instanceof SyntaxError) GM_setValue('shim2', '');   // a broken copy: fetch a fresh one next time
      return;                                                  // otherwise this site forbids running fetched code
    }
    try { stage2(...Object.values(GM)); } catch (e) { GM_setValue('shim2', ''); console.warn('[Web Gallery View]', e); }
  }

  const stored = GM_getValue('shim2', '');
  if (stored) { run(stored); return; }
  GM_xmlhttpRequest({
    method: 'GET',
    url: NEXT,
    onload: (r) => {
      if (r.status !== 200 || !/^\/\/ Web Gallery View loader \d/.test(r.responseText)) return;
      GM_setValue('shim2', r.responseText);
      run(r.responseText);
    },
  });
})();
