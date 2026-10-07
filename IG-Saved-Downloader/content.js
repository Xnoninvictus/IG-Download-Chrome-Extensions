// ============================================================
// IG Saved Downloader — Content Script
//
// Single button: 📦 Select All & Download
//   1. Scrolls the saved grid, harvesting every post/reel URL.
//   2. For each, fetches the post page HTML and extracts the
//      *real* media URL(s) — every carousel slide, the mp4 for
//      reels, the full-size jpg for photos.
//   3. Queues them and downloads one by one with random delays.
// ============================================================

(function () {
  'use strict';

  const BTN_ID = 'ig-all-btn';
  const STATUS_ID = 'ig-saved-status';
  const LOG = (...args) => console.log('[IG Saved]', ...args);

  // ---- Pacing (ms) ----
  const SCROLL_MIN = 1500;
  const SCROLL_MAX = 3000;
  const FETCH_MIN  = 800;
  const FETCH_MAX  = 1600;
  const DOWNLOAD_MIN = 2000;
  const DOWNLOAD_MAX = 4500;
  const MAX_SCROLL_ITERATIONS = 500;

  // ----------------------------------------------------------
  // Styles
  // ----------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('ig-saved-style')) return;
    const style = document.createElement('style');
    style.id = 'ig-saved-style';
    style.textContent = `
      #${BTN_ID} {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 2147483647;
        padding: 10px 16px;
        background: linear-gradient(135deg, #e1306c, #f77737);
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.35);
        opacity: 0.85;
        transition: opacity 0.2s, transform 0.2s;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${BTN_ID}:hover:not(:disabled) { opacity: 1; transform: scale(1.04); }
      #${BTN_ID}:disabled { cursor: wait; opacity: 0.9; }
      #${STATUS_ID} {
        position: fixed;
        top: 70px;
        right: 20px;
        z-index: 2147483647;
        max-width: 340px;
        padding: 8px 12px;
        background: rgba(0,0,0,0.82);
        color: #fff;
        border-radius: 6px;
        font-size: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.4;
        opacity: 0;
        transition: opacity 0.25s;
        pointer-events: none;
        white-space: pre-line;
      }
      #${STATUS_ID}.visible { opacity: 1; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createUI() {
    if (document.getElementById(BTN_ID)) return;
    injectStyles();

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = '📦 Select All & Download';
    btn.addEventListener('click', selectAllAndDownload);

    const status = document.createElement('div');
    status.id = STATUS_ID;

    (document.body || document.documentElement).appendChild(btn);
    (document.body || document.documentElement).appendChild(status);
    LOG('UI injected.');
  }

  function setStatus(text, visible = true) {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('visible', visible);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const isOnSavedPage = () => /\/saved(\/|$|\?)/.test(location.pathname);

  function extractShortcode(url) {
    const m = url.match(/\/(p|reel|tv)\/([^\/?#]+)/);
    return m ? m[2] : 'unknown';
  }

  // ==========================================================
  // MEDIA EXTRACTION
  // ==========================================================

  // Balanced-brace JSON blob finder. Given `"key":{...}` in the
  // HTML, returns the full `{...}` object as a string.
  function extractJsonBlob(html, key) {
    const marker = `"${key}":`;
    const idx = html.indexOf(marker);
    if (idx === -1) return null;

    const start = html.indexOf('{', idx);
    if (start === -1) return null;

    let depth = 0, inString = false, escape = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return html.slice(start, i + 1);
      }
    }
    return null;
  }

  function unescapeUrl(u) {
    return u
      .replace(/\\\//g, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/\\u002F/gi, '/')
      .replace(/&amp;/g, '&');
  }

  // ---------- Highest-quality picker for a candidate array ----------
  // Instagram returns several versions; pick the largest width.
  function pickBestVersion(versions) {
    if (!Array.isArray(versions) || versions.length === 0) return null;
    let best = versions[0];
    for (const v of versions) {
      const w = v.width || 0;
      if (w > (best.width || 0)) best = v;
    }
    return best.url || null;
  }

  function pickBestImage(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    let best = candidates[0];
    for (const c of candidates) {
      const w = c.width || 0;
      if (w > (best.width || 0)) best = c;
    }
    return best.url || null;
  }

  // ---------- Extract from a single media "node" ----------
  // Handles both legacy (edge_sidecar / xdt_shortcode_media) and
  // modern v1 (carousel_media / items[]) shapes.
  function extractFromNode(node) {
    if (!node) return [];

    // Detect whether this node is supposed to be a video
    const isVideo =
      node.is_video === true ||
      node.media_type === 2 ||
      node.__typename === 'GraphVideo' ||
      node.__typename === 'XDTGraphVideo';

    const videos = node.video_versions || node.videoVersions;
    if (Array.isArray(videos) && videos.length) {
      const url = pickBestVersion(videos);
      if (url) return [{ url: unescapeUrl(url), ext: 'mp4' }];
    }

    if (node.video_url) {
      return [{ url: unescapeUrl(node.video_url), ext: 'mp4' }];
    }

    // Image candidates
    const candidates =
      node.image_versions2?.candidates ||
      node.image_versions?.candidates ||
      node.display_resources;
    if (Array.isArray(candidates) && candidates.length) {
      const url = pickBestImage(candidates);
      if (url) return [{ url: unescapeUrl(url), ext: 'jpg' }];
    }

    if (node.display_url) {
      if (isVideo) {
        // We think it's a video but only have the thumbnail —
        // signal this so callers don't silently accept it.
        return [{ url: unescapeUrl(node.display_url), ext: 'jpg', __thumbOnly: true }];
      }
      return [{ url: unescapeUrl(node.display_url), ext: 'jpg' }];
    }

    return [];
  }

  // ---------- Walk a carousel / sidecar ----------
  function extractFromMediaData(data) {
    if (!data) return [];

    // Newest shape: items: [ { media_type, video_versions, image_versions2 } ]
    if (Array.isArray(data.items) && data.items.length) {
      const results = [];
      for (const item of data.items) {
        if (item.media_type === 8 && Array.isArray(item.carousel_media)) {
          for (const sub of item.carousel_media) {
            results.push(...extractFromNode(sub));
          }
        } else {
          results.push(...extractFromNode(item));
        }
      }
      if (results.length) return results;
    }

    // v1 carousel: carousel_media: [...]
    if (Array.isArray(data.carousel_media) && data.carousel_media.length) {
      const results = [];
      for (const item of data.carousel_media) {
        results.push(...extractFromNode(item));
      }
      if (results.length) return results;
    }

    // Graph carousel: edge_sidecar_to_children.edges[].node
    const edges = data.edge_sidecar_to_children?.edges;
    if (Array.isArray(edges) && edges.length) {
      const results = [];
      for (const edge of edges) {
        if (edge?.node) results.push(...extractFromNode(edge.node));
      }
      if (results.length) return results;
    }

    // Single media
    return extractFromNode(data);
  }

  // ---------- Main extractor: HTML → [{url, ext}] ----------
  function extractMedia(html) {
    // Detect if this page should contain a video
    const isVideoPage =
      /"is_video"\s*:\s*true/.test(html) ||
      /"media_type"\s*:\s*2\b/.test(html) ||
      /<meta\s+property="og:type"\s+content="video/.test(html);

    // 1. Try xdt_shortcode_media (classic posts + carousels)
    const blob1 = extractJsonBlob(html, 'xdt_shortcode_media');
    if (blob1) {
      try {
        const urls = extractFromMediaData(JSON.parse(blob1));
        if (urls.length && !urls.every((u) => u.__thumbOnly)) return urls;
      } catch (e) { LOG('xdt_shortcode_media parse failed:', e.message); }
    }

    // 2. Try xdt_api__v1__media__shortcode__web_info (modern reels)
    const blob2 = extractJsonBlob(html, 'xdt_api__v1__media__shortcode__web_info');
    if (blob2) {
      try {
        const urls = extractFromMediaData(JSON.parse(blob2));
        if (urls.length && !urls.every((u) => u.__thumbOnly)) return urls;
      } catch (e) { LOG('web_info parse failed:', e.message); }
    }

    // 3. Direct regex sweep for video URLs anywhere in the HTML
    if (isVideoPage) {
      // video_versions: [ { ..., url: "https://..." }, ... ]  (take best)
      const versionsBlock = html.match(/"video_versions"\s*:\s*(\[[^\]]*\])/);
      if (versionsBlock) {
        try {
          const arr = JSON.parse(unescapeUrl(versionsBlock[1]));
          const best = pickBestVersion(arr);
          if (best) return [{ url: unescapeUrl(best), ext: 'mp4' }];
        } catch (_) { /* fall through */ }
      }

      // video_url anywhere
      const vurl = html.match(/"video_url"\s*:\s*"(https?:\\?\/\\?\/[^"]+?)"/);
      if (vurl) return [{ url: unescapeUrl(vurl[1]), ext: 'mp4' }];

      // playable_url(_quality_hd)
      const playable = html.match(
        /"playable_url(?:_quality_hd)?"\s*:\s*"(https?:\\?\/\\?\/[^"]+?)"/
      );
      if (playable) return [{ url: unescapeUrl(playable[1]), ext: 'mp4' }];

      // og:video
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const ogVideo =
        doc.querySelector('meta[property="og:video:secure_url"]')?.content ||
        doc.querySelector('meta[property="og:video"]')?.content;
      if (ogVideo) return [{ url: unescapeUrl(ogVideo), ext: 'mp4' }];

      // If we got here, the page *is* a video but we couldn't find it.
      throw new Error('Video detected but no mp4 URL found');
    }

    // 4. Image-only fallback
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ogImage = doc.querySelector('meta[property="og:image"]')?.content;
    if (ogImage) return [{ url: unescapeUrl(ogImage), ext: 'jpg' }];

    return [];
  }

  // ---------- Fetch a post page and extract its media ----------
  async function fetchPostMedia(postUrl) {
    const res = await fetch(postUrl, {
      credentials: 'include',
      // Mimic a real browser navigation so Instagram serves the
      // full HTML (with embedded video JSON) instead of a reduced
      // preview that only has og:image.
      headers: {
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return extractMedia(html);
  }

  // ==========================================================
  // SCROLL COLLECTOR
  // ==========================================================
  async function scrollAndCollectPostUrls() {
    const seen = new Set();
    let lastHeight = 0, unchanged = 0, iterations = 0;

    const harvest = () => {
      const anchors = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
      for (const a of anchors) {
        const href = a.getAttribute('href');
        if (!href) continue;
        try {
          const full = new URL(href, location.origin).toString().split('?')[0].replace(/\/+$/, '');
          if (/instagram\.com\/(p|reel|tv)\//.test(full)) seen.add(full);
        } catch (_) {}
      }
    };

    while (iterations < MAX_SCROLL_ITERATIONS) {
      harvest();
      setStatus(`Scanning…\n${seen.size} posts found\nscroll #${iterations + 1}`);

      window.scrollTo(0, document.body.scrollHeight);
      await sleep(randomBetween(SCROLL_MIN, SCROLL_MAX));

      const newHeight = document.body.scrollHeight;
      if (newHeight === lastHeight) {
        if (++unchanged >= 4) break;
      } else {
        unchanged = 0;
      }
      lastHeight = newHeight;
      iterations++;
    }
    harvest();
    return Array.from(seen);
  }

  // ==========================================================
  // DOWNLOAD QUEUE
  // ==========================================================
  async function runDownloadQueue(items) {
    let ok = 0, fail = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const shortName = item.filename.split('/').pop();
      setStatus(
        `Downloading ${i + 1}/${items.length}\n${shortName}\n✅ ${ok}   ❌ ${fail}`
      );

      try {
        const res = await chrome.runtime.sendMessage({
          type: 'DOWNLOAD_ONE',
          url: item.url,
          filename: item.filename,
        });
        if (res?.ok) ok++;
        else { fail++; LOG('Download failed:', shortName, res?.error); }
      } catch (err) {
        fail++; LOG('Download exception:', shortName, err.message);
      }

      if (i < items.length - 1) {
        await sleep(randomBetween(DOWNLOAD_MIN, DOWNLOAD_MAX));
      }
    }

    setStatus(`✅ Done\nDownloaded: ${ok}\nFailed: ${fail}`, true);
    setTimeout(() => setStatus('', false), 8000);
  }

  // ==========================================================
  // MAIN FLOW — Select All & Download
  // ==========================================================
  async function selectAllAndDownload() {
    const btn = document.getElementById(BTN_ID);
    btn.disabled = true;
    btn.textContent = '⏳ Scanning…';

    try {
      // Phase 1 — collect post/reel URLs from the grid
      const postUrls = await scrollAndCollectPostUrls();
      LOG('Collected', postUrls.length, 'post URLs');
      if (postUrls.length === 0) throw new Error('No posts found.');

      // Phase 2 — fetch each post page and extract real media URLs
      const queue = [];
      let processed = 0;
      const failures = [];

      for (const postUrl of postUrls) {
        processed++;
        btn.textContent = `🔍 ${processed}/${postUrls.length}`;
        setStatus(
          `Extracting ${processed}/${postUrls.length}\n${queue.length} media queued\n${failures.length} skipped`
        );

        try {
          const media = await fetchPostMedia(postUrl);
          const shortcode = extractShortcode(postUrl);

          media.forEach((m, i) => {
            queue.push({
              url: m.url,
              filename: `instagram/${shortcode}${
                media.length > 1 ? '_' + (i + 1) : ''
              }.${m.ext}`,
            });
          });
        } catch (err) {
          LOG('Skip', postUrl, '→', err.message);
          failures.push({ url: postUrl, reason: err.message });
        }

        if (processed < postUrls.length) {
          await sleep(randomBetween(FETCH_MIN, FETCH_MAX));
        }
      }

      LOG('Queue:', queue.length, 'media files');
      LOG('Failures:', failures);

      if (queue.length === 0) {
        throw new Error(`Nothing to download (${failures.length} failed).`);
      }

      // Phase 3 — download one by one
      btn.textContent = `⬇️ 0/${queue.length}`;
      await runDownloadQueue(queue);

      // Summary toast
      if (failures.length > 0) {
        setStatus(
          `⚠️ Done with warnings\n${queue.length} queued · ${failures.length} skipped\n` +
          `Check console for skipped URLs`,
          true
        );
        setTimeout(() => setStatus('', false), 10000);
      }

      btn.textContent = `✅ ${queue.length} done`;
      setTimeout(() => {
        btn.textContent = '📦 Select All & Download';
        btn.disabled = false;
      }, 3000);
    } catch (err) {
      LOG('Error (all):', err);
      btn.textContent = '❌ ' + err.message.slice(0, 32);
      setTimeout(() => {
        btn.textContent = '📦 Select All & Download';
        btn.disabled = false;
      }, 4000);
    }
  }

  // ==========================================================
  // SPA-AWARE INJECTION
  // ==========================================================
  function ensureUI() {
    if (isOnSavedPage()) {
      if (!document.getElementById(BTN_ID)) createUI();
    } else {
      document.getElementById(BTN_ID)?.remove();
      document.getElementById(STATUS_ID)?.remove();
    }
  }

  let attempts = 0;
  const MAX_ATTEMPTS = 60;

  function retryInject() {
    ensureUI();
    if (isOnSavedPage() && !document.getElementById(BTN_ID) && attempts < MAX_ATTEMPTS) {
      attempts++;
      setTimeout(retryInject, 500);
    }
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      LOG('URL changed:', lastUrl);
      attempts = 0;
      retryInject();
    }
  }, 500);

  new MutationObserver(() => ensureUI()).observe(
    document.body || document.documentElement,
    { childList: true, subtree: true }
  );

  function start() {
    retryInject();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
