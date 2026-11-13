# Reddit Gallery View

A userscript that turns any Reddit listing — subreddit, user, search, custom feed /
multireddit, front page — into a masonry media gallery with infinite scroll and a
lightbox.

[![Install](https://img.shields.io/badge/Install-RedditGallery.user.js-2ea44f?style=for-the-badge&logo=greasyfork&logoColor=white)](https://raw.githubusercontent.com/realteamnet/RedditGallery/main/RedditGallery.user.js)

One click installs it if a userscript manager (Violentmonkey, Tampermonkey,
Greasemonkey) is loaded.

## Install

1. Install a userscript manager: [Violentmonkey](https://violentmonkey.github.io/)
   (recommended), Tampermonkey or Greasemonkey.
2. Click **[Install](https://raw.githubusercontent.com/realteamnet/RedditGallery/main/RedditGallery.user.js)**:
   the manager opens its install page.
3. Confirm. Updates come automatically from the same URL.

## Use

- Click **Gallery** next to Reddit's sort bar, the corner button, or press **Alt+G**.
- **Exit gallery** (or Esc) returns to Reddit where you left off.
- Turn on **Auto-open** to start every listing page in gallery view.

## Features

- **Masonry grid** — wide pictures span two or three columns; new pages append
  without reshuffling what is on screen. Pick the column count, widen landscape items,
  blur NSFW, include link previews.
- **Filters** — all, pictures, videos, animated, GIFs. Reposts are skipped.
- **Media** — Reddit galleries, v.redd.it video with sound, converted GIFs, direct
  images, link previews, crossposts, and Redgifs (full file with audio).
- **Playback** — tiles play lighter versions while on screen; global mute, autoplay all,
  gallery autoplay with an interval, and autoscroll at four speeds. Out of the box:
  muted, autoplay all on, gallery autoplay on.
- **Lightbox** — wheel, arrow keys or a sideways swipe to step through items, swipe up
  to go back to the grid, Ctrl+wheel / pinch to zoom
  (up to 10×) and drag to pan, seek bar, loop, fit/fill, fullscreen.
- **Post actions** — vote, save, hide, follow, share, crosspost, report, and read the
  comments in a side panel without leaving the lightbox.
- Remembers gallery view per subreddit and multireddit: open it once and that feed opens
  as a gallery from then on, in any tab and under any sort, until you exit gallery view
  there. Other pages, and the item you were viewing, are remembered per tab.
- Checks for a newer version (at most every 15 minutes) and offers it.

## Keyboard

| Key | Action |
| --- | --- |
| Alt+G | Open / close the gallery |
| ← / → | Previous / next item in the lightbox |
| C | Toggle comments |
| M | Mute / unmute |
| F | Fullscreen |
| Z | Toggle fit / fill |
| Esc | Close panel → comments → lightbox → gallery |

## Notes

Everything runs in your browser against Reddit's own `.json` endpoints with your
session, so private multireddits work. The UI lives in a shadow DOM so Reddit's styles
cannot interfere. Reddit re-skins often; if the inline Gallery button disappears, the
corner button and Alt+G still work.
