document.getElementById('open-options').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options.html'));
  }
});

document.getElementById('parse-current').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Trigger the injected button if available
        const btn = document.querySelector('.osz-root .osz-btn');
        if (btn) btn.click();
      }
    });
    setStatus('Opened panel on page');
  } catch (e) {
    setStatus('Unable to parse this page');
  }
});

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

