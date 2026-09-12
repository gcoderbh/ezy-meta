// Ezy-Meta Content Script (runs on https://www.meta.ai/*)
console.log("[EzyMeta] Content script loaded on Meta AI");

// 1. Prevent Meta AI from showing native browser "Leave site? Changes you made may not be saved." dialog
window.addEventListener("beforeunload", (e) => {
  e.stopImmediatePropagation();
  delete e.returnValue;
}, true);
try {
  window.onbeforeunload = null;
  Object.defineProperty(window, "onbeforeunload", {
    get: () => null,
    set: () => {}
  });
} catch (e) {}

// 2. Auto-dismiss in-page "Discard prompt?" or "Leave" modals automatically
const autoDiscardObserver = new MutationObserver(() => {
  const modalBtns = Array.from(document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button, [data-testid*="modal"] button'));
  for (const b of modalBtns) {
    const text = (b.innerText || b.getAttribute("aria-label") || "").trim().toLowerCase();
    if (text === "discard" || text.includes("discard") || text.includes("ทิ้ง") || text === "leave") {
      console.log("[EzyMeta] Auto-dismissing in-page discard modal by clicking:", text);
      b.click();
      break;
    }
  }
});
if (document.body) {
  autoDiscardObserver.observe(document.body, { childList: true, subtree: true });
} else {
  document.addEventListener("DOMContentLoaded", () => {
    if (document.body) autoDiscardObserver.observe(document.body, { childList: true, subtree: true });
  });
}

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

    // Step 0: Ensure Meta AI composer is hydrated and ready
    progress("Waiting for Meta AI composer to hydrate...");
    for (let i = 0; i < 30; i++) {
      const fileInp = document.querySelector('input[type="file"]');
      const addBtn = document.querySelector('button[aria-label*="attachment" i], button[aria-label*="แนบ" i]');
      const skeleton = document.querySelector('.composer-add-attachment-button-skeleton');
      if ((fileInp || addBtn) && !skeleton) {
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }

    // Step 1: Inject image attachment into Meta AI composer
    progress("Attaching image to Meta AI composer...");
    const attachImage = async () => {
      // 1. Direct file input
      let fileInput = document.querySelector('input[type="file"]');
      if (!fileInput) {
        const addAttachBtn = document.querySelector('button[aria-label*="attachment" i], button[aria-label*="แนบ" i], [class*="add-attachment"]');
        if (addAttachBtn) {
          addAttachBtn.click();
          await new Promise(r => setTimeout(r, 300));
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

      // 2. ClipboardEvent paste on textarea
      const textarea = document.querySelector('textarea[data-testid="composer-input"], textarea');
      if (textarea) {
        textarea.focus();
        const dtPaste = new DataTransfer();
        dtPaste.items.add(file);
        const pasteEvt = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dtPaste
        });
        textarea.dispatchEvent(pasteEvt);
      }

      // 3. DragEvent drop on composer
      const composer = document.querySelector('[data-testid="composer-input"]') || textarea;
      if (composer) {
        const dtDrop = new DataTransfer();
        dtDrop.items.add(file);
        const dropEvt = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dtDrop
        });
        composer.dispatchEvent(dropEvt);
      }
    };

    await attachImage();

    // Wait and verify attachment preview chip appears
    progress("Verifying image attachment in Meta AI composer...");
    let attached = false;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 400));
      const chip = document.querySelector('button[aria-label*="Remove image" i], [data-testid*="attachment"], [aria-label*="Remove" i], [aria-label*="Delete" i], img[src*="blob:"], [class*="attachment"]');
      if (chip) {
        attached = true;
        // Wait extra 1200ms for image upload to complete on Meta CDN
        await new Promise(r => setTimeout(r, 1200));
        break;
      }
      if (i % 6 === 5) {
        // Retry attach if not seen yet
        await attachImage();
      }
    }

    if (!attached) {
      throw new Error("Could not attach image to Meta AI composer within timeout.");
    }

    // Step 2: Format prompt and inject into textarea composer
    progress("Injecting prompt into composer...");
    const promptLower = prompt.toLowerCase();
    let finalPrompt = prompt;
    if (!promptLower.startsWith("turn this photo into a video") && !promptLower.startsWith("animate this")) {
      finalPrompt = `Turn this photo into a video: ${prompt.replace(/^turn this photo into a 2D game sprite animation:\s*/i, "")}`;
    }

    const textarea = document.querySelector('textarea[data-testid="composer-input"], [data-testid="composer-input"], textarea');
    const setComposerText = (targetText) => {
      const el = document.querySelector('textarea[data-testid="composer-input"], [data-testid="composer-input"], textarea');
      if (!el) return;
      el.focus();
      const currentVal = el.value || "";
      // Preserve any [image:UUID] tokens from composer
      const tokens = currentVal.match(/\[image:[^\]]+\]/g) || [];
      const cleanPrompt = targetText.replace(/Tell me about this image\.?/gi, "").trim();
      const combined = tokens.length > 0 ? `${tokens.join(" ")} ${cleanPrompt}` : cleanPrompt;

      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) {
        setter.call(el, combined);
      } else {
        el.value = combined;
      }
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    };

    setComposerText(finalPrompt);
    await new Promise(r => setTimeout(r, 600));
    // Re-apply in case Meta AI finished upload and inserted default text
    setComposerText(finalPrompt);
    await new Promise(r => setTimeout(r, 600));

    // Step 3: Click Send button
    progress("Submitting message to Meta AI...");
    let sent = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      // Guarantee prompt is still in textarea and not replaced by default text
      const currentArea = document.querySelector('textarea[data-testid="composer-input"], textarea');
      if (currentArea && (!currentArea.value || currentArea.value.includes("Tell me about this image"))) {
        setComposerText(finalPrompt);
      }

      const sendBtn = document.querySelector('button[data-testid="composer-send-button"], button[aria-label*="Send" i], button[aria-label*="ส่ง" i]');
      const isDisabled = sendBtn ? (sendBtn.disabled || sendBtn.getAttribute("aria-disabled") === "true") : true;

      if (sendBtn && !isDisabled) {
        sendBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
        sendBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        sendBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
        sendBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        sendBtn.click();
        if (currentArea) {
          currentArea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13, view: window }));
        }
        sent = true;
        break;
      }

      if (attempt % 3 === 2 && currentArea) {
        currentArea.focus();
        currentArea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }

      await new Promise(r => setTimeout(r, 400));
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
        if (lastText.includes("reached your limit") || lastText.includes("meta one core") || lastText.includes("wait until tomorrow")) {
          clearInterval(checkForVideoOrAnimate);
          fail(new Error("Meta AI Rate Limit: You reached your daily media limit. Get Meta One Core or wait until reset."));
          return;
        }
        if (lastText.includes("server error") || lastText.includes("couldn't be generated") || lastText.includes("could not be generated")) {
          clearInterval(checkForVideoOrAnimate);
          fail(new Error("Meta AI video server error: generation failed on backend."));
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
            aria.includes("animation") ||
            title === "animate" ||
            title.includes("animate") ||
            title.includes("animation") ||
            text === "animate" ||
            text.includes("animate") ||
            text.includes("animation") ||
            testid.includes("animate") ||
            testid.includes("animation")
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
