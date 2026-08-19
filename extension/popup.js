const statusEl = document.getElementById("status");

chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
  if (!statusEl) return;
  if (chrome.runtime.lastError) {
    statusEl.textContent = "waiting for Grok";
    return;
  }
  statusEl.textContent = res && res.connected ? "connected" : "waiting for Grok";
});
