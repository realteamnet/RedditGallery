# Web Gallery View

A userscript that turns a page's pictures, GIFs and videos into a masonry media gallery
with infinite scroll and a lightbox.

- **Any site** with a grid of media: best effort, read straight from the page.
- **Reddit**: full support — any listing (subreddit, user, search, multireddit, front
  page), sorting, saved feeds, votes, comments.

[![Install Web Gallery View](https://img.shields.io/badge/Install-WebGalleryView.user.js-2ea44f?style=for-the-badge&logo=greasyfork&logoColor=white)](https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryView.user.js)

One click installs it if a userscript manager (Violentmonkey, Tampermonkey,
Greasemonkey) is loaded.

## The files

| File | What it is |
| --- | --- |
| [WebGalleryView.user.js](WebGalleryView.user.js) | **Install this.** Stage 1: a few lines that run stage 2. Kept minimal so it almost never needs updating. |
| [WebGalleryLoader.js](WebGalleryLoader.js) | Stage 2: keeps itself and the gallery up to date. Not installed; stage 1 fetches it. |
| [WebGalleryCore.user.js](WebGalleryCore.user.js) | Stage 3: the gallery itself, all the code. |
| [RedditGallery.user.js](RedditGallery.user.js) | Reddit-only edition: the same gallery code, running on reddit.com and nowhere else. |

**Web Gallery View updates itself.** It keeps copies of the loader and the gallery, runs
them on every page, and replaces them in the background when this repository has newer
ones, so a new version is in use on the next page you open (within about 20 minutes of
a release). The trade-off: whatever is on this repository's main branch runs on every
site you visit without you confirming it first. Some sites with a strict security policy
may refuse to run fetched code; the gallery is then simply absent there.

**Prefer to confirm every update yourself?** Install
[WebGalleryCore.user.js](https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryCore.user.js)
(any site) or
[RedditGallery.user.js](https://raw.githubusercontent.com/realteamnet/RedditGallery/main/RedditGallery.user.js)
(Reddit only) instead. Those are ordinary userscripts: they show a small "update
available" bar and your userscript manager installs the new version. Install only one;
if more are installed, only one runs on a page.

## Install

1. Install Violentmonkey for your browser:
   - [Firefox](https://addons.mozilla.org/firefox/addon/violentmonkey/)
   - [Edge](https://microsoftedge.microsoft.com/addons/detail/eeagobfjdenkkddmbclomhiblgggliao)
   - [Chrome](https://chrome.google.com/webstore/detail/violent-monkey/jinjaccalgkegednnccohejagnlnfdag)
     (also Brave, Vivaldi, Opera and other Chromium browsers)
   - [Other browsers and beta versions](https://violentmonkey.github.io/get-it/)

   Tampermonkey and Greasemonkey should also work.
2. Click **[Install Web Gallery View](https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryView.user.js)**
   (or one of the other files above): the manager opens its install page.
3. Confirm. From then on the gallery keeps itself up to date.

## Use

- **On Reddit**: click **Gallery** next to Reddit's sort bar, the corner button, or press
  **Alt+G**.
- **On any other site**: press **Alt+G**, or use the corner **Gallery** button, which
  appears by itself on pages where a grid of media is found. The userscript menu can
  hide that button for a site.
- **Exit gallery** (or Esc) returns to the page where you left off.
- The version is shown next to "Gallery" in the header and in the userscript menu.
- The browser's Back button does not leave gallery view; exit the gallery first.
- Gallery view is remembered per page: once opened, that page opens as a gallery from
  then on, until you exit it there. No page opens as a gallery unless you switched it on.

## Features

- **Masonry grid** — wide pictures span two or three columns; new pages append
  without reshuffling what is on screen. Pick the column count and widen landscape items.
- **Filters** — all, pictures, videos, animated, GIFs. Duplicates are skipped.
- **Playback** — global mute, autoplay all, gallery autoplay with an interval, and
  autoscroll at four speeds. Out of the box: muted, autoplay all on, gallery autoplay on.
- **Lightbox** — wheel, arrow keys or a sideways swipe to step through items, swipe up
  to go back to the grid. The arrows show what a step does: a gold single arrow with a
  position ("2 / 5") stays inside the post's own pictures, a double arrow moves to another
  post. On a video a quick flick steps and a slower slide scrubs through it. Also Ctrl+wheel / pinch to zoom (up to 10×) and drag to pan, seek
  bar, loop, fit/fill, fullscreen.
- Looks for a newer version at most every 15 minutes. Web Gallery View takes it by
  itself; the other two files offer it in a small bar at the top of the page, and nothing
  is installed until you choose **Update**.

### On any site (best effort)

- Finds the page's media grid by its repeating structure, and leaves out logos, icons,
  avatars and navigation images. Without a grid it takes the page's large pictures.
- Looks for the full-size file behind each thumbnail: a direct link to the media file,
  the largest `srcset` entry, lazy-loading attributes, WordPress-style size suffixes.
- Loads more as you scroll: it drives the site's own infinite scroll underneath, and
  follows "next page" links on the same site.
- Not handled yet: sites where the full-size picture only exists on a separate detail
  page, "Load more" buttons, and streamed videos (those show their poster and a link).
- Until used, it adds nothing to a page: no button, no timers.

### On Reddit

- **Media** — Reddit galleries, v.redd.it video with sound, converted GIFs, direct
  images, link previews, crossposts, and Redgifs (full file with audio). Tiles play
  lighter versions while on screen.
- **Feeds** — load any subreddit, multireddit, user or search from the header, sort it,
  save feeds, blur NSFW, include link previews. Reposts are skipped.
- **Post actions** — vote, save, hide, follow, share, crosspost, report, and read the
  comments in a side panel without leaving the lightbox.
- Subreddits and multireddits are remembered as one page under every sort.

## Keyboard

| Key | Action |
| --- | --- |
| Alt+G | Open / close the gallery |
| ← / → | Previous / next item in the lightbox |
| C | Toggle comments (Reddit) |
| M | Mute / unmute |
| F | Fullscreen |
| Z | Toggle fit / fill |
| Esc | Close panel → comments → lightbox → gallery |

## Notes

Everything runs in your browser. On Reddit it uses Reddit's own `.json` endpoints with
your session, so private multireddits work. On other sites it only reads the page you
are on and same-site "next" pages. The UI lives in a shadow DOM so the site's styles
cannot interfere. Reddit re-skins often; if the inline Gallery button disappears, the
corner button and Alt+G still work.
