const el = (id) => document.getElementById(id);

function render(status) {
  const connected = Boolean(status && status.connected);
  el("status").textContent = connected ? "connected" : "waiting for Grok";
  el("dot").classList.toggle("on", connected);
  el("port").textContent = status && status.port ? String(status.port) : "—";
  el("tabs").textContent = String((status && status.attachedTabs) || 0);
  el("version").textContent = (status && status.version) || "—";
  el("browser").textContent = (status && status.browserName) || "this browser";
  el("hint").textContent = connected
    ? "Grok can drive tabs it opens here."
    : "Start Grok to connect.";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
    if (chrome.runtime.lastError) {
      render(null);
      return;
    }
    render(res);
  });
}

refresh();
setInterval(refresh, 1000);
