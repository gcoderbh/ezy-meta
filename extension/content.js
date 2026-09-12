// Ezy-Meta Content Script (runs on https://www.meta.ai/*)
console.log("[EzyMeta] Content script loaded on Meta AI");

function getLoggedInUser() {
  const userBtn = document.querySelector('[testid="user-menu-button"], [id*="user-menu"]');
  if (userBtn) return userBtn.innerText.trim();
  const avatar = document.querySelector('img[alt*="profile"], img[alt*="avatar"]');
  if (avatar) return avatar.alt;
  return "Logged In User";
}

function isMetaAiReady() {
  const isMetaHost = window.location.hostname.includes("meta.ai");
  const composer = document.querySelector('[data-testid="composer-input"], [contenteditable="true"], textarea, div[role="textbox"]');
  return isMetaHost && (!!composer || document.readyState === "complete" || document.readyState === "interactive");
}

function notifyReady() {
  if (isMetaAiReady()) {
    try {
      chrome.runtime.sendMessage({
        type: "CONTENT_READY",
        user: getLoggedInUser()
      }, () => {
        // Suppress any closed channel errors
        if (chrome.runtime.lastError) {}
      });
    } catch (e) {}
  }
}

// Initial readiness check & observer
notifyReady();
if (document.readyState !== "complete") {
  window.addEventListener("DOMContentLoaded", notifyReady);
  window.addEventListener("load", notifyReady);
}

const readyObserver = new MutationObserver(() => {
  notifyReady();
});
if (document.body) {
  readyObserver.observe(document.body, { childList: true, subtree: true });
} else {
  document.addEventListener("DOMContentLoaded", () => {
    readyObserver.observe(document.body, { childList: true, subtree: true });
  });
}

// Listen for commands from background script (guarded to avoid duplicate executions)
if (!window.__EZY_META_LISTENER_REGISTERED__) {
  window.__EZY_META_LISTENER_REGISTERED__ = true;
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "PING") {
      sendResponse({
        ready: isMetaAiReady(),
        user: getLoggedInUser()
      });
      return true;
    }

    if (request.type === "RUN_ANIMATE_TASK") {
      runAnimateWorkflow(request.payload);
      sendResponse({ started: true });
      return true;
    }
  });
}

async function runAnimateWorkflow(task) {
  const { taskId, imageBase64, mimeType = "image/jpeg", prompt = "Turn this photo into a video" } = task;

  const progress = (message) => {
    console.log(`[EzyMeta][Task ${taskId}] ${message}`);
    chrome.runtime.sendMessage({
      type: "TASK_PROGRESS",
      taskId,
      message
    });
  };

  const fail = (error) => {
    console.error(`[EzyMeta][Task ${taskId}] Error:`, error);
    chrome.runtime.sendMessage({
      type: "TASK_FAILED",
      taskId,
      error: error.message || String(error)
    });
  };

  const complete = (videoUrl, meta = null) => {
    console.log(`[EzyMeta][Task ${taskId}] Completed:`, videoUrl, meta);
    chrome.runtime.sendMessage({
      type: "TASK_COMPLETED",
      taskId,
      videoUrl,
      meta
    });
  };

  try {
    progress("Preparing image payload...");
    const byteCharacters = atob(imageBase64);
    const byteArrays = [];
    for (let offset = 0; offset < byteCharacters.length; offset += 512) {
      const slice = byteCharacters.slice(offset, offset + 512);
      const byteNumbers = new Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      byteArrays.push(new Uint8Array(byteNumbers));
    }
    const blob = new Blob(byteArrays, { type: mimeType });
    const filename = `input_${Date.now()}.${mimeType.includes("png") ? "png" : "jpg"}`;
    const file = new File([blob], filename, { type: mimeType });

    // Step 1: Inject image attachment into Meta AI composer
    progress("Attaching image to Meta AI composer...");
    let fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) {
      const addAttachBtn = document.querySelector('button[aria-label*="attachment" i], button[aria-label*="แนบ" i]');
      if (addAttachBtn) {
        addAttachBtn.click();
        await new Promise(r => setTimeout(r, 400));
        fileInput = document.querySelector('input[type="file"]');
      }
    }

    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }

    // Wait and verify attachment preview chip appears
    progress("Verifying image attachment in Meta AI composer...");
    let attached = false;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 400));
      const chip = document.querySelector('[data-testid*="attachment"], [aria-label*="Remove" i], [aria-label*="Delete" i], img[src*="blob:"], [class*="attachment"]');
      if (chip) {
        attached = true;
        break;
      }
    }

    // Step 2: Format prompt and inject into textarea composer
    progress("Injecting prompt into composer...");
    const promptLower = prompt.toLowerCase();
    const finalPrompt = promptLower.includes("animate") || promptLower.includes("turn this photo") || promptLower.includes("video")
      ? prompt
      : `Turn this photo into a video: ${prompt}`;

    const textarea = document.querySelector('textarea[data-testid="composer-input"], [data-testid="composer-input"], textarea');
    if (textarea) {
      textarea.focus();
      try {
        if (textarea._valueTracker) {
          textarea._valueTracker.setValue("");
        }
      } catch (e) {}

      // Method A: Native property descriptor setter
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) {
        setter.call(textarea, finalPrompt);
      } else {
        textarea.value = finalPrompt;
      }
      textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

      // Method B: execCommand insertText fallback if value wasn't recognized
      if (!textarea.value || textarea.value.length === 0) {
        try {
          document.execCommand("selectAll", false, null);
          document.execCommand("insertText", false, finalPrompt);
        } catch (e) {}
      }
    }

    await new Promise(r => setTimeout(r, 1000));

    // Step 3: Click Send button
    progress("Submitting message to Meta AI...");
    let sent = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const sendBtn = document.querySelector('button[data-testid="composer-send-button"], button[aria-label*="Send" i], button[aria-label*="ส่ง" i]');
      const isDisabled = sendBtn ? (sendBtn.disabled || sendBtn.getAttribute("aria-disabled") === "true") : true;

      if (sendBtn && !isDisabled) {
        sendBtn.click();
        sent = true;
        // Clean composer textarea after submitting
        setTimeout(() => {
          if (textarea) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
            if (setter) setter.call(textarea, "");
            else textarea.value = "";
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            textarea.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, 400);
        break;
      }

      // If button is still disabled after 4 attempts, try Enter key on textarea
      if (attempt >= 4 && textarea) {
        textarea.focus();
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      }

      await new Promise(r => setTimeout(r, 500));
    }

    if (!sent) {
      throw new Error("Could not submit prompt to Meta AI (Send button remained disabled or unclickable). Please reload session.");
    }

    progress("Waiting for Meta AI response & animation trigger...");

    // Record existing video URLs to prevent false triggers
    const existingVideos = new Set(
      Array.from(document.querySelectorAll("video"))
        .map(v => v.currentSrc || v.src || (v.querySelector("source") && v.querySelector("source").src))
        .filter(Boolean)
    );

    // Step 4: Polling loop to find Animate button and capture video stream
    let animationTriggered = false;
    const startTime = Date.now();
    const timeoutMs = 180000; // 3 minutes max

    const checkForVideoOrAnimate = setInterval(() => {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs) {
        clearInterval(checkForVideoOrAnimate);
        fail(new Error("Timeout waiting for video generation (exceeded 3 minutes)"));
        return;
      }

      // Auto-click "Scroll to bottom" button if present so animation is visible
      const scrollBtn = document.querySelector('button[aria-label*="Scroll to bottom" i], button[aria-label*="เลื่อนลง" i]');
      if (scrollBtn) {
        try { scrollBtn.click(); } catch (e) {}
      }

      // Check for Meta AI session errors or rate limits
      const errorEl = document.querySelector('[role="alert"], [data-testid*="error"]');
      if (errorEl && errorEl.innerText) {
        const errText = errorEl.innerText.trim();
        if (errText.toLowerCase().includes("wrong") || errText.toLowerCase().includes("try again") || errText.toLowerCase().includes("limit")) {
          clearInterval(checkForVideoOrAnimate);
          fail(new Error(`Meta AI Session Error: ${errText}`));
          return;
        }
      }

      // Early detection: check if assistant replied that image was not received
      const messages = Array.from(document.querySelectorAll('[data-testid*="message"], [role="presentation"]'));
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const lastText = (lastMsg.innerText || "").toLowerCase();
        if (lastText.includes("didn't receive your") || (lastText.includes("upload") && lastText.includes("again") && lastText.includes("image"))) {
          clearInterval(checkForVideoOrAnimate);
          fail(new Error("Meta AI indicated the image attachment was not received. Please retry."));
          return;
        }
      }

      // 1. Check if "Animate" button appears (on hover or in media action rail)
      if (!animationTriggered) {
        // Trigger hover on image cards
        const images = Array.from(document.querySelectorAll('img[src*="fbcdn"], [role="presentation"], [data-testid*="message"]'));
        if (images.length > 0) {
          const lastEl = images[images.length - 1];
          lastEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
          lastEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        }

        const buttons = Array.from(document.querySelectorAll("button"));
        const animateBtn = buttons.find(b => {
          if (b.disabled) return false;
          const aria = (b.getAttribute("aria-label") || "").toLowerCase();
          const title = (b.getAttribute("title") || "").toLowerCase();
          const text = (b.innerText || "").trim().toLowerCase();
          const testid = (b.getAttribute("data-testid") || "").toLowerCase();

          return (
            aria === "animate" ||
            aria.includes("animate") ||
            title === "animate" ||
            title.includes("animate") ||
            text === "animate" ||
            text.includes("animate") ||
            testid.includes("animate")
          );
        });

        if (animateBtn) {
          progress("Clicking 'Animate' button on Meta AI media card...");
          animateBtn.click();
          animationTriggered = true;
          return;
        }
      }

      // 2. Check for newly rendered video elements
      const videos = Array.from(document.querySelectorAll("video"));
      for (const v of videos) {
        const url = v.currentSrc || v.src || (v.querySelector("source") && v.querySelector("source").src);
        if (url && !existingVideos.has(url)) {
          // If it's a direct mp4 or fbcdn video
          if (url.includes(".mp4") || url.includes("fbcdn.net")) {
            clearInterval(checkForVideoOrAnimate);
            progress("Video generation stream completed!");
            const meta = (v.videoWidth && v.videoHeight) ? {
              width: v.videoWidth,
              height: v.videoHeight,
              duration: v.duration || null
            } : null;
            complete(url, meta);
            return;
          }
        }
      }

      // 3. Check for download links or anchor tags containing .mp4
      const links = Array.from(document.querySelectorAll('a[href*=".mp4"], a[download]'));
      for (const a of links) {
        if (a.href && !existingVideos.has(a.href) && (a.href.includes(".mp4") || a.href.includes("fbcdn.net"))) {
          clearInterval(checkForVideoOrAnimate);
          progress("Video URL extracted from download link!");
          complete(a.href);
          return;
        }
      }

      progress(`Generating video stream... (${Math.round(elapsed / 1000)}s)`);
    }, 2000);

  } catch (err) {
    fail(err);
  }
}
