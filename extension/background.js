// Ezy-Meta Background Service Worker
const WS_URL = "ws://127.0.0.1:4242";
let ws = null;
let reconnectTimer = null;
let metaAiTabId = null;

const state = {
  cliConnected: false,
  metaAiReady: false,
  tabId: null,
  tabUrl: null,
  user: null,
  stats: {
    totalGenerated: 0,
    pendingCount: 0
  },
  activeTask: null,
  queue: [],
  history: [],
  session: {
    consecutiveGenerations: 0,
    maxConsecutiveBeforeRefresh: 5,
    lastRefresh: new Date().toISOString()
  }
};

let consecutiveGenerations = 0;
const MAX_CONSECUTIVE_BEFORE_REFRESH = 5;

// Helper: Reload or reset Meta AI tab with completion promise
async function reloadMetaAiTab({ newChat = false } = {}) {
  if (!metaAiTabId) {
    await checkMetaAiTab();
  }
  if (!metaAiTabId) {
    throw new Error("No active Meta AI tab found to reload");
  }

  const tabId = metaAiTabId;
  const targetUrl = newChat ? "https://www.meta.ai/" : null;

  state.metaAiReady = false;
  state.session.lastRefresh = new Date().toISOString();
  broadcastState();

  return new Promise((resolve) => {
    let resolved = false;

    const onComplete = async () => {
      if (resolved) return;
      resolved = true;
      consecutiveGenerations = 0;
      state.session.consecutiveGenerations = 0;
      setTimeout(async () => {
        await checkMetaAiTab();
        resolve({ ok: true, tabId, newChat });
      }, 1200);
    };

    const onUpdatedListener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdatedListener);
        onComplete();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdatedListener);

    // Timeout safety fallback (12s)
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdatedListener);
      onComplete();
    }, 12000);

    if (targetUrl) {
      chrome.tabs.update(tabId, { url: targetUrl });
    } else {
      chrome.tabs.reload(tabId);
    }
  });
}

// Enable Side Panel to open on icon click
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("[EzyMeta] Error setting side panel behavior:", error));
}

// Intercept video CDN streams from Meta AI
const capturedTaskUrls = new Map();

if (chrome.webRequest && chrome.webRequest.onCompleted) {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const url = details.url;
      if (url && (url.includes(".mp4") || url.includes("fbcdn.net/o1/v/t2/f2/m412") || url.includes("video_dashinit"))) {
        if (state.activeTask && state.activeTask.id) {
          const taskId = state.activeTask.id;
          if (!capturedTaskUrls.has(taskId)) {
            capturedTaskUrls.set(taskId, new Set());
          }
          const taskUrls = capturedTaskUrls.get(taskId);
          if (!taskUrls.has(url)) {
            taskUrls.add(url);
            console.log(`[EzyMeta] Captured candidate video URL (${taskUrls.size}):`, url);
            sendToServer("VIDEO_CANDIDATE", {
              taskId,
              videoUrl: url
            });
          }
        }
      }
    },
    { urls: ["*://*.fbcdn.net/*", "*://*.meta.ai/*"] }
  );
}

// Initialize state from storage
chrome.storage.local.get(["stats", "history"], (res) => {
  if (res.stats) state.stats = res.stats;
  if (res.history) state.history = res.history;
  broadcastState();
});

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("[EzyMeta] Connected to CLI Daemon via WebSocket");
      state.cliConnected = true;
      clearTimeout(reconnectTimer);
      broadcastState();
      checkMetaAiTab();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (e) {
        console.error("[EzyMeta] WS JSON parse error:", e);
      }
    };

    ws.onclose = () => {
      console.log("[EzyMeta] WS Disconnected. Reconnecting in 3s...");
      state.cliConnected = false;
      broadcastState();
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.warn("[EzyMeta] WS Error:", err);
      state.cliConnected = false;
      broadcastState();
    };
  } catch (err) {
    console.error("[EzyMeta] Failed to construct WebSocket:", err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, 3000);
}

function sendToServer(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

// Check for active Meta AI tab and auto-inject content script if needed
async function checkMetaAiTab() {
  try {
    const allTabs = await chrome.tabs.query({});
    const metaTabs = allTabs.filter(t => (t.url && t.url.includes("meta.ai")) || (t.pendingUrl && t.pendingUrl.includes("meta.ai")));
    
    if (metaTabs.length > 0) {
      // Prioritize active tab if it is a meta tab, otherwise take first
      const activeMeta = metaTabs.find(t => t.active) || metaTabs[0];
      metaAiTabId = activeMeta.id;
      state.tabId = metaAiTabId;
      state.tabUrl = activeMeta.url || activeMeta.pendingUrl;

      // Ping content script to verify it's responsive
      chrome.tabs.sendMessage(metaAiTabId, { type: "PING" }, async (res) => {
        if (chrome.runtime.lastError || !res) {
          console.log("[EzyMeta] Content script not responding on tab", metaAiTabId, "- Auto-injecting content.js...");
          // Pre-existing tab! Inject content.js dynamically
          try {
            await chrome.scripting.executeScript({
              target: { tabId: metaAiTabId },
              files: ["content.js"]
            });
            console.log("[EzyMeta] Auto-injected content.js successfully!");
            
            // Re-ping after 300ms
            setTimeout(() => {
              chrome.tabs.sendMessage(metaAiTabId, { type: "PING" }, (retryRes) => {
                state.metaAiReady = !!(retryRes && retryRes.ready);
                state.user = (retryRes && retryRes.user) || null;
                broadcastState();
                sendToServer("STATUS_UPDATE", {
                  metaAiReady: state.metaAiReady,
                  tabId: state.tabId,
                  tabUrl: state.tabUrl,
                  user: state.user
                });
              });
            }, 300);
          } catch (injectErr) {
            console.warn("[EzyMeta] Script injection failed:", injectErr.message);
            state.metaAiReady = false;
            broadcastState();
          }
        } else {
          state.metaAiReady = !!res.ready;
          state.user = res.user || null;
          broadcastState();
          sendToServer("STATUS_UPDATE", {
            metaAiReady: state.metaAiReady,
            tabId: state.tabId,
            tabUrl: state.tabUrl,
            user: state.user
          });
        }
      });
    } else {
      metaAiTabId = null;
      state.tabId = null;
      state.tabUrl = null;
      state.metaAiReady = false;
      broadcastState();
      sendToServer("STATUS_UPDATE", {
        metaAiReady: false,
        tabId: null,
        tabUrl: null,
        user: null
      });
    }
  } catch (err) {
    console.error("[EzyMeta] Error in checkMetaAiTab:", err);
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "INIT_ACK":
    case "SNAPSHOT_UPDATE":
    case "QUEUE_UPDATED": {
      const snap = msg.payload?.snapshot || msg.payload;
      if (snap) {
        if (snap.stats) state.stats = snap.stats;
        if (snap.activeTask) state.activeTask = snap.activeTask;
        if (snap.queue) state.queue = snap.queue;
        if (snap.history) state.history = snap.history;
        broadcastState();
      }
      break;
    }

    case "TASK_ASSIGN": {
      executeTaskOnMetaAi(msg.payload);
      break;
    }

    case "TASK_FINALIZED": {
      const { taskId, localVideoPath, videoUrl, meta, score } = msg.payload || {};
      state.stats.totalGenerated = (state.stats.totalGenerated || 0) + 1;
      const histItem = {
        id: taskId,
        videoUrl,
        localVideoPath,
        meta,
        score,
        completedAt: new Date().toISOString()
      };
      // Prevent duplicate entries for the same task in storage
      state.history = state.history.filter(h => h.id !== taskId);
      state.history.unshift(histItem);
      chrome.storage.local.set({ stats: state.stats, history: state.history.slice(0, 50) });
      state.activeTask = null;
      state.queue = (state.queue || []).filter(q => q.id !== taskId);
      capturedTaskUrls.delete(taskId);
      consecutiveGenerations++;
      state.session.consecutiveGenerations = consecutiveGenerations;
      broadcastState();
      break;
    }

    case "RELOAD_SESSION": {
      const { reqId, newChat } = msg.payload || {};
      reloadMetaAiTab({ newChat: !!newChat }).then(res => {
        sendToServer("RELOAD_RESULT", { reqId, ...res });
      }).catch(err => {
        sendToServer("RELOAD_RESULT", { reqId, ok: false, error: err.message });
      });
      break;
    }

    case "INSPECT_PAGE": {
      const reqId = msg.payload?.reqId;
      if (!metaAiTabId) {
        sendToServer("INSPECT_RESULT", { reqId, error: "No Meta AI tab ID found" });
        break;
      }
      chrome.scripting.executeScript({
        target: { tabId: metaAiTabId },
        func: () => {
          const buttons = Array.from(document.querySelectorAll("button")).map(b => ({
            text: b.innerText.trim().slice(0, 50),
            ariaLabel: b.getAttribute("aria-label"),
            disabled: b.disabled
          })).filter(b => b.text || b.ariaLabel);

          const videos = Array.from(document.querySelectorAll("video")).map(v => ({
            src: v.src,
            currentSrc: v.currentSrc
          }));

          const composer = document.querySelector('[data-testid="composer-input"], [contenteditable="true"], textarea, div[role="textbox"]');
          const composerText = composer ? (composer.innerText || composer.value || "") : "";

          const chatText = document.body ? document.body.innerText.slice(-2500) : "";

          const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map(i => ({
            accept: i.accept,
            id: i.id,
            className: i.className,
            parentTag: i.parentElement ? i.parentElement.tagName : null
          }));

          const addAttachBtn = document.querySelector('button[aria-label*="attachment" i]');

          return {
            url: window.location.href,
            title: document.title,
            composerText,
            fileInputs,
            hasAddAttachmentBtn: !!addAttachBtn,
            buttonsCount: buttons.length,
            buttons: buttons.slice(-25),
            videos,
            chatText
          };
        }
      }, (results) => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
        sendToServer("INSPECT_RESULT", {
          reqId,
          data: results && results[0] ? results[0].result : null,
          error: err
        });
      });
      break;
    }

    case "RELOAD_EXTENSION": {
      console.log("[EzyMeta] Reloading extension via command...");
      chrome.runtime.reload();
      break;
    }

    case "TEST_INJECTION": {
      const reqId = msg.payload?.reqId;
      chrome.scripting.executeScript({
        target: { tabId: metaAiTabId },
        func: () => {
          const diag = {};
          try {
            const textarea = document.querySelector('textarea[data-testid="composer-input"], [data-testid="composer-input"], textarea');
            if (textarea) {
              textarea.focus();
              textarea.value = '';
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
              if (setter) {
                setter.call(textarea, "Animate this cat into a video");
              }
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
              textarea.dispatchEvent(new Event("change", { bubbles: true }));
              diag.afterInputVal = textarea.value;
            }

            const sendBtn = document.querySelector('button[data-testid="composer-send-button"], button[aria-label*="Send" i]');
            if (sendBtn) {
              diag.sendBtnDisabled = sendBtn.disabled;
              if (!sendBtn.disabled) {
                sendBtn.click();
                diag.submitted = true;
              }
            }

          } catch (outerErr) {
            diag.outerError = outerErr.message;
          }
          return diag;
        }
      }, (results) => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
        sendToServer("INSPECT_RESULT", {
          reqId,
          data: results && results[0] ? results[0].result : null,
          error: err
        });
      });
      break;
    }

    default:
      break;
  }
}

async function executeTaskOnMetaAi(task) {
  if (!metaAiTabId) {
    await checkMetaAiTab();
  }

  if (!metaAiTabId) {
    sendToServer("TASK_FAILED", {
      taskId: task.taskId,
      error: "No active https://www.meta.ai tab found."
    });
    return;
  }

  // Session check: clean chat requested or memory threshold reached
  if (task.freshSession || task.newChat || consecutiveGenerations >= MAX_CONSECUTIVE_BEFORE_REFRESH) {
    state.activeTask = {
      id: task.taskId,
      prompt: task.prompt,
      progress: "Resetting to clean Meta AI chat session..."
    };
    broadcastState();
    try {
      console.log("[EzyMeta] Refreshing Meta AI session before task execution...");
      await reloadMetaAiTab({ newChat: true });
    } catch (sessionErr) {
      console.warn("[EzyMeta] Session reset warning:", sessionErr.message);
    }
  }

  state.activeTask = {
    id: task.taskId,
    prompt: task.prompt,
    progress: "Starting in Meta AI tab..."
  };
  broadcastState();

  // Always re-inject latest content.js before executing task
  try {
    await chrome.scripting.executeScript({
      target: { tabId: metaAiTabId },
      files: ["content.js"]
    });
  } catch (e) {
    console.log("[EzyMeta] Injection note:", e.message);
  }

  // Send execution instruction to content script
  chrome.tabs.sendMessage(metaAiTabId, {
    type: "RUN_ANIMATE_TASK",
    payload: task
  }, (response) => {
    if (chrome.runtime.lastError) {
      sendToServer("TASK_FAILED", {
        taskId: task.taskId,
        error: "Content script communication failed: " + chrome.runtime.lastError.message
      });
    }
  });
}

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "CONTENT_READY") {
    state.metaAiReady = true;
    state.user = request.user || null;
    metaAiTabId = sender.tab ? sender.tab.id : metaAiTabId;
    state.tabId = metaAiTabId;
    state.tabUrl = sender.tab ? sender.tab.url : state.tabUrl;
    broadcastState();
    sendToServer("STATUS_UPDATE", {
      metaAiReady: true,
      tabId: state.tabId,
      tabUrl: state.tabUrl,
      user: state.user
    });
    sendResponse({ ok: true });
    return;
  }

  if (request.type === "TASK_PROGRESS") {
    if (state.activeTask) {
      state.activeTask.progress = request.message;
    }
    broadcastState();
    sendToServer("TASK_PROGRESS", {
      taskId: request.taskId,
      step: request.step,
      message: request.message
    });
    sendResponse({ ok: true });
    return;
  }

  if (request.type === "TASK_COMPLETED") {
    sendToServer("TASK_COMPLETED", {
      taskId: request.taskId,
      videoUrl: request.videoUrl
    });
    sendResponse({ ok: true });
    return;
  }

  if (request.type === "TASK_FAILED") {
    sendToServer("TASK_FAILED", {
      taskId: request.taskId,
      error: request.error
    });
    sendResponse({ ok: true });
    return;
  }

  if (request.type === "GET_STATE") {
    sendResponse(state);
    return;
  }

  if (request.type === "FORCE_RECONNECT") {
    connectWebSocket();
    checkMetaAiTab();
    sendToServer("REQUEST_SNAPSHOT");
    sendResponse({ ok: true });
    return;
  }

  if (request.type === "RELOAD_SESSION") {
    reloadMetaAiTab({ newChat: !!request.newChat })
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

function broadcastState() {
  chrome.storage.local.set({ ezyMetaState: state });
}

// Watch tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url && tab.url.includes("meta.ai")) {
    checkMetaAiTab();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === metaAiTabId) {
    metaAiTabId = null;
    state.metaAiReady = false;
    broadcastState();
    sendToServer("STATUS_UPDATE", { metaAiReady: false });
  }
});

// Start initial connection
connectWebSocket();
setInterval(checkMetaAiTab, 5000);
