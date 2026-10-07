# IG Saved Downloader

A Chrome extension (Manifest V3) that bulk-downloads every post and reel from your Instagram **Saved** collection — including full-resolution images and every slide of a carousel.

Instead of scraping thumbnails, the extension opens each saved post's page, parses the embedded JSON that Instagram ships with the HTML, and extracts the *real* media URLs (the `mp4` for reels, the highest-resolution `jpg` for photos, and every carousel slide).

---

## Table of Contents

1. [Features](#features)
2. [How It Works](#how-it-works)
3. [Project Structure](#project-structure)
4. [Installation](#installation)
5. [Usage](#usage)
6. [Permissions Explained](#permissions-explained)
7. [Media Extraction Deep Dive](#media-extraction-deep-dive)
8. [Configuration](#configuration)
9. [Troubleshooting](#troubleshooting)
10. [Known Limitations](#known-limitations)
11. [Privacy & Disclaimer](#privacy--disclaimer)
12. [License](#license)

---

## Features

- **One-click bulk export** — a single floating button does everything.
- **Auto-scroll harvesting** — scrolls the Saved grid until the page stops growing, collecting every post/reel URL.
- **Real media URLs, not thumbnails** — fetches each post page and parses the embedded JSON to get the highest-quality image or the actual `mp4`.
- **Full carousel support** — every slide of a sidecar post is downloaded and numbered (`shortcode_1.jpg`, `shortcode_2.jpg`, …).
- **Reel / video support** — extracts the best `video_versions` entry by resolution.
- **Human-like pacing** — randomized delays between scrolls, fetches, and downloads to avoid rate-limiting.
- **SPA-aware** — automatically injects/removes the button as you navigate Instagram's single-page app.
- **Live progress UI** — status panel shows scan count, extraction progress, and download success/failure tallies.

---

## How It Works

The extension runs in three phases:

```
┌──────────────────────────────────────────────────────────────┐
│  PHASE 1 — SCROLL & HARVEST                                  │
│  content.js scrolls the Saved grid, repeatedly harvesting    │
│  every <a href="/p/..."> and <a href="/reel/..."> anchor.    │
│  Stops when page height is unchanged for 4 consecutive       │
│  scrolls (or after 500 iterations).                          │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  PHASE 2 — FETCH & EXTRACT                                   │
│  For each collected post URL, content.js does a credentialed │
│  fetch() of the post page, then parses the returned HTML:    │
│    1. xdt_shortcode_media           (classic posts)          │
│    2. xdt_api__v1__media__shortcode__web_info (modern reels) │
│    3. Regex sweep for video_versions / video_url /           │
│       playable_url / og:video                                │
│    4. og:image fallback for image-only posts                 │
│  Produces a flat queue of {url, filename} items.             │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  PHASE 3 — DOWNLOAD QUEUE                                    │
│  Sends DOWNLOAD_ONE messages one at a time to background.js, │
│  which calls chrome.downloads.download(). Randomized delay   │
│  (2–4.5 s) between each download.                            │
└──────────────────────────────────────────────────────────────┘
```

All downloaded files land in a folder named `instagram/` inside your Chrome downloads directory.

---

## Project Structure

| File | Purpose |
|------|---------|
| **`manifest.json`** | Extension manifest (Manifest V3). Declares permissions, host permissions, the background service worker, and the content script. |
| **`content.js`** | The brain. Injects the floating UI, scrolls the Saved page, harvests post URLs, fetches post HTML, extracts media URLs, and drives the download queue. |
| **`background.js`** | Minimal service worker. Listens for `DOWNLOAD_ONE` messages and calls `chrome.downloads.download()`. |
| **`popup.html`** | The toolbar popup shown when you click the extension icon. Contains quick usage instructions. |
| **`styles.css`** | Legacy stylesheet. **Not currently loaded by the extension** — `content.js` injects its own styles inline. Kept for reference / potential future use. |

> **Note:** `popup.html` still describes the older "export a `.txt` file of URLs" behavior and references a `📦 Select All & Export` button. The current build downloads media files directly and the button reads `📦 Select All & Download`. The popup text is stale but harmless.

---

## Installation

This extension is not published to the Chrome Web Store. Load it as an unpacked extension:

1. **Download the source.** Place the four files (`manifest.json`, `content.js`, `background.js`, `popup.html`, and optionally `styles.css`) into a single folder, e.g. `ig-saved-downloader/`.

2. **Open the Extensions page.** In Chrome, navigate to:
   ```
   chrome://extensions/
   ```

3. **Enable Developer Mode.** Toggle the switch in the top-right corner.

4. **Click "Load unpacked."** Select your `ig-saved-downloader/` folder.

5. **Verify.** The extension should appear in the list with the name **IG Saved Downloader**. Pin it to your toolbar for easy access.

> Works on any Chromium-based browser that supports Manifest V3 (Chrome 88+, Edge, Brave, Opera, Vivaldi).

---

## Usage

1. **Log in to Instagram** in the same browser. The extension relies on your existing session cookies — it does not ask for credentials.

2. **Navigate to your Saved page:**
   ```
   https://www.instagram.com/your_username/saved/
   ```

3. **Wait for the grid to load.** The floating button appears in the top-right corner of the page once the extension detects you're on a Saved page.

4. **Click `📦 Select All & Download`.**

5. **Watch the status panel** (just below the button) as it progresses through:
   - `Scanning…` — scrolling and harvesting post URLs
   - `Extracting X/Y` — fetching and parsing each post
   - `Downloading X/Y` — sending files to Chrome's download manager

6. **Find your files** in `Downloads/instagram/`. Carousel slides are numbered sequentially.

7. **Don't close the tab** while the process is running. The extension needs the page context to keep fetching.

### Tips

- If you have hundreds of saved posts, the whole process can take a while. The pacing delays exist to keep Instagram from throttling you.
- You can safely leave the tab in the background; Chrome throttles timers slightly but downloads will continue.
- To cancel, simply close the tab or click the button again after it re-enables (it will restart from scratch).

---

## Permissions Explained

| Permission | Why it's needed |
|------------|-----------------|
| `downloads` | To save files to disk via `chrome.downloads.download()`. |
| `host_permissions: https://www.instagram.com/*` | To read the Saved page, fetch post pages with your session cookies, and inject the UI. |
| `host_permissions: https://*.cdninstagram.com/*` | Instagram's CDN — where image and video files are actually hosted. |
| `host_permissions: https://*.fbcdn.net/*` | Facebook/Meta CDN — used for some Reels and video assets. |

The extension requests **no** permissions to read your browsing history, tabs, clipboard, or any site other than Instagram and its CDNs.

---

## Media Extraction Deep Dive

Instagram's web pages embed a large JSON blob that describes the post. The extension tries several strategies in order and takes the first one that yields a non-thumbnail result.

### 1. JSON blob finder — `extractJsonBlob(html, key)`

Instagram doesn't emit valid JSON at the top level of the page, so a naive `JSON.parse` won't work. The extractor scans for `"key":` and then walks the string with a brace-depth counter (respecting string escapes) to find the matching closing `}`. This yields a parseable object.

### 2. Handled shapes

The extractor normalizes across Instagram's several generations of payload shapes:

- **`items[]`** (newest) — each item may be a single photo/video or a `media_type: 8` carousel.
- **`carousel_media[]`** (v1 API) — direct array of media nodes.
- **`edge_sidecar_to_children.edges[].node`** (GraphQL) — legacy carousel shape.
- **Single node** — a bare photo or video.

### 3. Per-node extraction — `extractFromNode(node)`

For each node it picks, in order:

1. `video_versions` / `videoVersions` → best by `width` → `.mp4`
2. `video_url` → `.mp4`
3. `image_versions2.candidates` / `image_versions.candidates` / `display_resources` → best by `width` → `.jpg`
4. `display_url` → `.jpg` (flagged `__thumbOnly` if the node *should* have been a video)

### 4. Video-page fallbacks

If the page is detected as a video (via `"is_video": true`, `"media_type": 2`, or `og:type=video`) but the JSON blobs failed to parse, the extractor falls back to regex sweeps for:

- `"video_versions": [...]`
- `"video_url": "..."`
- `"playable_url(_quality_hd)": "..."`
- `og:video:secure_url` / `og:video` meta tags

If a video page yields only a thumbnail, the extractor **throws** rather than silently saving a JPEG — the failure is logged and the post is skipped.

---

## Configuration

Pacing constants live at the top of `content.js`:

```js
const SCROLL_MIN = 1500;          // ms — min delay between scrolls
const SCROLL_MAX = 3000;          // ms — max delay between scrolls
const FETCH_MIN  = 800;           // ms — min delay between post fetches
const FETCH_MAX  = 1600;          // ms — max delay between post fetches
const DOWNLOAD_MIN = 2000;        // ms — min delay between downloads
const DOWNLOAD_MAX = 4500;        // ms — max delay between downloads
const MAX_SCROLL_ITERATIONS = 500; // hard cap on scroll loop
```

Tune these if you want faster runs (at higher rate-limit risk) or slower, safer runs.

The download subfolder (`instagram/`) is set inside `selectAllAndDownload()`:

```js
filename: `instagram/${shortcode}${...}.${m.ext}`
```

Change `instagram/` to any folder name you prefer.

---

## Troubleshooting

| Symptom | Likely cause & fix |
|---------|--------------------|
| **Button doesn't appear** | Make sure the URL is `instagram.com/<user>/saved/`. Reload the page. Check `chrome://extensions/` for errors. |
| **"No posts found"** | The Saved grid hadn't loaded yet. Scroll manually for a moment, then click the button. |
| **Many posts skipped** | Instagram likely rate-limited you, or the post uses a JSON shape the extractor doesn't recognize. Check the DevTools console (`[IG Saved]` logs) for reasons. |
| **Videos save as `.jpg`** | The extractor detected a video but only found a thumbnail. The post is logged as a failure — see the console. |
| **Downloads folder gets a `instagram/` subfolder** | This is intentional (see [Configuration](#configuration)). |
| **`HTTP 429` errors** | Too many requests. Increase `FETCH_MIN/MAX` and `DOWNLOAD_MIN/MAX`, wait a few minutes, try again. |
| **`chrome.runtime.lastError` in background** | Usually a bad filename (illegal characters) or an expired CDN URL. Check the console — the file's URL may have expired; re-run the extension. |
| **Extension stops mid-run** | Chrome may have suspended the background service worker, or you navigated away from the Saved page. Keep the tab open and active. |

To see detailed logs, open DevTools (`F12`) on the Instagram tab and filter for `[IG Saved]`.

---

## Known Limitations

- **Relies on Instagram's internal JSON format.** Meta changes these payload shapes periodically. When they do, extraction will need updating.
- **Uses your session cookies.** Only run this on your own account. It is not designed for scraping other users' profiles.
- **Rate limits are real.** Downloading hundreds of posts in one sitting may trigger throttling. The randomized delays mitigate this but don't eliminate it.
- **No resume support.** If the run is interrupted, restarting begins from scratch. Already-downloaded files are not skipped.
- **SPA navigation.** The button appears/disappears based on URL; if you navigate away mid-run, the process will fail.
- **The `popup.html` text and `styles.css` are stale** relative to the current functionality (see [Project Structure](#project-structure)).
- **CDN URLs can expire.** Media URLs are signed and time-limited. If a fetch or download fails, re-running the extension will get fresh URLs.

---

## Privacy & Disclaimer

- **No data leaves your machine.** The extension talks only to `instagram.com` and Meta's CDNs, using your existing browser session. There is no analytics, telemetry, or third-party server.
- **No credentials are stored.** Login is handled entirely by Instagram's own cookies.
- **Use responsibly.** Download only content you have the right to save. Respect Instagram's Terms of Service and the copyright of content creators.
- **Provided as-is.** This is an unofficial tool and is not affiliated with, endorsed by, or supported by Instagram or Meta.

---

## License

MIT License. See `LICENSE`

---

## Contributing

Pull requests welcome for:

- Additional JSON shape handlers (Instagram changes these often).
- A proper `options.html` for pacing configuration.
- Resume / skip-existing support.
- Refreshing the popup text to match current behavior.
- Removing the unused `styles.css` or wiring it in.

Please test against a live Saved page before opening a PR.
