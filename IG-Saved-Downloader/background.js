chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'DOWNLOAD_ONE') return;

  chrome.downloads.download(
    { url: msg.url, filename: msg.filename, saveAs: false },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[IG BG] Failed:', chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        console.log('[IG BG] Started id =', downloadId, '→', msg.filename);
        sendResponse({ ok: true, downloadId });
      }
    }
  );

  return true;
});
