// Ezy-Meta Popup Logic

let activeTabName = "queue";

document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupActions();
  fetchState();
  setInterval(fetchState, 1000);
});

function setupTabs() {
  const btnQueue = document.getElementById("btnTabQueue");
  const btnHistory = document.getElementById("btnTabHistory");
  const paneQueue = document.getElementById("tabContentQueue");
  const paneHistory = document.getElementById("tabContentHistory");

  btnQueue.addEventListener("click", () => {
    activeTabName = "queue";
    btnQueue.classList.add("active");
    btnHistory.classList.remove("active");
    paneQueue.classList.add("active");
    paneHistory.classList.remove("active");
  });

  btnHistory.addEventListener("click", () => {
    activeTabName = "history";
    btnHistory.classList.add("active");
    btnQueue.classList.remove("active");
    paneHistory.classList.add("active");
    paneQueue.classList.remove("active");
  });
}

function setupActions() {
  document.getElementById("btnOpenMeta").addEventListener("click", () => {
    chrome.tabs.query({ url: "https://www.meta.ai/*" }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: "https://www.meta.ai/" });
      }
    });
  });

  document.getElementById("btnReconnect").addEventListener("click", () => {
    const btn = document.getElementById("btnReconnect");
    btn.innerText = "SYNCING...";
    chrome.runtime.sendMessage({ type: "FORCE_RECONNECT" }, () => {
      setTimeout(() => {
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> SYNC CLI`;
        fetchState();
      }, 600);
    });
  });
}

function fetchState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
    if (chrome.runtime.lastError || !state) {
      // Fallback: check storage
      chrome.storage.local.get(["ezyMetaState"], (res) => {
        if (res.ezyMetaState) render(res.ezyMetaState);
      });
      return;
    }
    render(state);
  });
}

function render(state) {
  const { cliConnected, metaAiReady, tabId, user, stats = {}, activeTask, queue = [], history = [] } = state;

  // 1. Overall Status Badge
  const badge = document.getElementById("overallStatusBadge");
  const badgeText = document.getElementById("overallStatusText");

  if (cliConnected && metaAiReady) {
    badge.className = "status-badge status-online";
    badgeText.innerText = "ONLINE";
  } else if (cliConnected && !metaAiReady) {
    badge.className = "status-badge status-waiting";
    badgeText.innerText = "WAITING TAB";
  } else {
    badge.className = "status-badge status-offline";
    badgeText.innerText = "OFFLINE";
  }

  // 2. Node Status Grid
  const cliDot = document.getElementById("cliDot");
  const cliText = document.getElementById("cliStatusText");
  if (cliConnected) {
    cliDot.className = "dot dot-on";
    cliText.innerText = "Port 4242 OK";
  } else {
    cliDot.className = "dot dot-off";
    cliText.innerText = "Disconnected";
  }

  const metaDot = document.getElementById("metaDot");
  const metaText = document.getElementById("metaStatusText");
  if (metaAiReady) {
    metaDot.className = "dot dot-on";
    metaText.innerText = `Tab #${tabId} Ready`;
  } else if (tabId) {
    metaDot.className = "dot dot-warn";
    metaText.innerText = `Tab #${tabId} Loading...`;
  } else {
    metaDot.className = "dot dot-off";
    metaText.innerText = "Tab Not Found";
  }

  // User row
  const userRow = document.getElementById("userRow");
  const userName = document.getElementById("userName");
  if (user) {
    userRow.style.display = "flex";
    userName.innerText = user;
  } else {
    userRow.style.display = "none";
  }

  // 3. Metrics
  const totalGen = stats.totalGenerated || (history.filter(h => h.status === "COMPLETED" || h.videoUrl).length);
  document.getElementById("statGenerated").innerText = totalGen;
  document.getElementById("statQueue").innerText = queue.length;
  document.getElementById("tabQueueCount").innerText = queue.length;
  document.getElementById("tabHistoryCount").innerText = history.length;

  // 4. Active Workflow Card
  const activeCard = document.getElementById("activeTaskCard");
  const activeBadge = document.getElementById("activeBadge");
  const idleState = document.getElementById("idleStateText");
  const runningState = document.getElementById("activeRunningState");

  if (activeTask) {
    activeCard.className = "active-card running";
    activeBadge.className = "mini-tag running";
    activeBadge.innerText = "GENERATING";
    idleState.style.display = "none";
    runningState.style.display = "block";

    document.getElementById("activeTaskId").innerText = activeTask.id || "TASK";
    document.getElementById("activeTaskPrompt").innerText = activeTask.prompt || "Animate Image";
    document.getElementById("activeTaskStep").innerText = activeTask.progress || "In progress...";
  } else {
    activeCard.className = "active-card idle";
    activeBadge.className = "mini-tag idle";
    activeBadge.innerText = "IDLE";
    idleState.style.display = "flex";
    runningState.style.display = "none";
  }

  // 5. Render Queue List
  const queueList = document.getElementById("queueList");
  if (queue.length === 0) {
    queueList.innerHTML = `<div class="empty-list">No tasks currently queued.</div>`;
  } else {
    queueList.innerHTML = queue.map((t, idx) => `
      <div class="list-item">
        <div class="item-top">
          <span class="item-id">#${idx + 1} ${escapeHtml(t.id)}</span>
          <span class="item-badge" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b;">QUEUED</span>
        </div>
        <div class="item-prompt">${escapeHtml(t.prompt)}</div>
      </div>
    `).join("");
  }

  // 6. Render History List
  const historyList = document.getElementById("historyList");
  if (history.length === 0) {
    historyList.innerHTML = `<div class="empty-list">No generation history yet.</div>`;
  } else {
    historyList.innerHTML = history.map((h, idx) => {
      const isOk = !h.error;
      const meta = h.meta;
      return `
        <div class="list-item">
          <div class="item-top">
            <span class="item-id">${escapeHtml(h.id || `GEN_${idx + 1}`)}</span>
            <span class="item-badge ${isOk ? 'completed' : 'failed'}">${isOk ? 'SUCCESS' : 'FAILED'}</span>
          </div>
          <div class="item-prompt">${escapeHtml(h.prompt || "Image to Video")}</div>
          ${meta && (meta.resolution || meta.bitrateKbps) ? `
            <div class="item-meta-tags" style="display: flex; gap: 6px; margin: 4px 0 6px 0; font-size: 10px; font-family: monospace;">
              ${meta.resolution ? `<span style="background: rgba(0,255,102,0.12); color: #00ff66; padding: 2px 6px; border-radius: 4px; font-weight: 600; border: 1px solid rgba(0,255,102,0.25);">${escapeHtml(meta.resolution)}</span>` : ''}
              ${meta.bitrateKbps ? `<span style="background: rgba(0,229,255,0.12); color: #00e5ff; padding: 2px 6px; border-radius: 4px; font-weight: 600; border: 1px solid rgba(0,229,255,0.25);">${(meta.bitrateKbps / 1000).toFixed(1)} Mbps</span>` : ''}
              ${meta.durationSec ? `<span style="background: rgba(255,255,255,0.08); color: #94a3b8; padding: 2px 6px; border-radius: 4px;">${meta.durationSec}s</span>` : ''}
            </div>
          ` : ''}
          <div class="item-actions">
            ${h.videoUrl ? `<a href="${h.videoUrl}" target="_blank" class="btn-link">WATCH MP4 ↗</a>` : ''}
          </div>
        </div>
      `;
    }).join("");
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
