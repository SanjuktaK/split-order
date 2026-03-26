// MV3 service worker (kept minimal)
chrome.runtime.onInstalled.addListener(() => {
  // Could add context menu or onboarding here
});

// Optional: listen for messages (future API integration)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'PING') {
    sendResponse({ ok: true });
    return true;
  }
});

