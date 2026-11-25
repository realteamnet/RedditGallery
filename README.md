# Web Gallery View

A userscript that turns a page's pictures, GIFs and videos into a masonry media gallery
with infinite scroll and a lightbox.

- **Any site** with a grid of media: best effort, read straight from the page.
- **Reddit**: full support — any listing (subreddit, user, search, multireddit, front
  page), sorting, saved feeds, votes, comments.

[![Install Web Gallery View](https://img.shields.io/badge/Install-WebGalleryView.user.js-2ea44f?style=for-the-badge&logo=greasyfork&logoColor=white)](https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryView.user.js)

One click installs it if a userscript manager (Violentmonkey, Tampermonkey,
Greasemonkey) is loaded.

**Reddit only?** [RedditGallery.user.js](https://raw.githubusercontent.com/realteamnet/RedditGallery/main/RedditGallery.user.js)
is the Reddit-only edition: the same code and the same version, running on reddit.com and nowhere else.
Install one or the other. If both are installed, only one of them runs on Reddit.

## Install

1. Install Violentmonkey for your browser:
   - [Firefox](https://addons.mozilla.org/firefox/addon/violentmonkey/)
   - [Edge](https://microsoftedge.microsoft.com/addons/detail/eeagobfjdenkkddmbclomhiblgggliao)
   - [Chrome](https://chrome.google.com/webstore/detail/violent-monkey/jinjaccalgkegednnccohejagnlnfdag)
     (also Brave, Vivaldi, Opera and other Chromium browsers)
   - [Other browsers and beta versions](https://violentmonkey.github.io/get-it/)

   Tampermonkey and Greasemonkey should also work.
2. Click **[Install Web Gallery View](https://raw.githubusercontent.com/realteamnet/RedditGallery/main/WebGalleryView.user.js)**
   (or the Reddit-only edition above): the manager opens its install page.
3. Confirm. Updates come automatically from the same URL.

## Use

- **On Reddit**: click **Gallery** next to Reddit's sort bar, the corner button, or press
  **Alt+G**.
- **On any other site**: press **Alt+G**, or use the corner **Gallery** button, which
  appears by itself on pages where a grid of media is found. The userscript menu can
  hide that button for a site.
- **Exit gallery** (or Esc) returns to the page where you left off.
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
  to go back to the grid, Ctrl+wheel / pinch to zoom (up to 10×) and drag to pan, seek
  bar, loop, fit/fill, fullscreen.
- Checks for a newer version (at most every 15 minutes) and offers it.

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
