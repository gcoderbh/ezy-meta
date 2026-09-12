import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { TaskQueue } from "./queue.js";
import { downloadVideo } from "./downloader.js";
import { parseMp4Metadata, calculateQualityScore, evaluateBestCandidate } from "./evaluator.js";

export class EzyMetaServer {
  constructor(port = 4242, historyPath = "./output/.ezy-meta-history.json") {
    this.port = port;
    this.queue = new TaskQueue(historyPath);
    this.server = null;
    this.wss = null;
    this.extensionSocket = null;
    this.candidateWindows = new Map();
    this.metaAiState = {
      connected: false,
      metaAiReady: false,
      tabId: null,
      tabUrl: null,
      user: null,
      lastHeartbeat: null
    };
    this.pendingInspects = {};
    this.pendingReloads = {};

    this.queue.on("task_enqueued", () => this.dispatchNextTask());
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttp(req, res));
      this.wss = new WebSocketServer({ server: this.server });

      this.wss.on("connection", (ws, req) => this.handleWsConnection(ws, req));

      this.server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.port} is already in use.`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        resolve({
          port: this.port,
          httpUrl: `http://127.0.0.1:${this.port}`,
          wsUrl: `ws://127.0.0.1:${this.port}`
        });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close();
      }
      if (this.server) {
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }

  handleWsConnection(ws, req) {
    this.extensionSocket = ws;
    this.metaAiState.connected = true;
    this.metaAiState.lastHeartbeat = Date.now();

    // Send initial handshake with current queue & stats
    this.sendToExtension({
      type: "INIT_ACK",
      payload: {
        serverVersion: "1.0.0",
        snapshot: this.queue.getSnapshot()
      }
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleWsMessage(ws, msg);
      } catch (err) {
        console.error("[WS] Failed to parse incoming message:", err.message);
      }
    });

    ws.on("close", () => {
      if (this.extensionSocket === ws) {
        this.extensionSocket = null;
        this.metaAiState.connected = false;
        this.metaAiState.metaAiReady = false;
      }
    });

    ws.on("error", (err) => {
      console.error("[WS Error]", err.message);
    });
  }

  handleWsMessage(ws, msg) {
    this.metaAiState.lastHeartbeat = Date.now();

    switch (msg.type) {
      case "HEARTBEAT":
      case "STATUS_UPDATE": {
        this.metaAiState.connected = true;
        this.metaAiState.metaAiReady = !!msg.payload?.metaAiReady;
        this.metaAiState.tabId = msg.payload?.tabId || null;
        this.metaAiState.tabUrl = msg.payload?.tabUrl || null;
        this.metaAiState.user = msg.payload?.user || null;

        // Try dispatching if ready
        if (this.metaAiState.metaAiReady) {
          this.dispatchNextTask();
        }
        break;
      }

      case "TASK_PROGRESS": {
        const { taskId, message, step } = msg.payload || {};
        if (taskId) {
          this.queue.updateProgress(taskId, message || step);
        }
        break;
      }

      case "VIDEO_CANDIDATE":
      case "TASK_COMPLETED": {
        const { taskId, videoUrl, meta } = msg.payload || {};
        if (taskId && videoUrl) {
          this.handleCandidateVideo(taskId, videoUrl, meta);
        }
        break;
      }

      case "TASK_FAILED": {
        const { taskId, error } = msg.payload || {};
        if (taskId) {
          this.queue.failTask(taskId, error || "Unknown extension execution error");
          this.sendToExtension({
            type: "SNAPSHOT_UPDATE",
            payload: this.queue.getSnapshot()
          });
          // Proceed to next pending task
          setTimeout(() => this.dispatchNextTask(), 1000);
        }
        break;
      }

      case "REQUEST_SNAPSHOT": {
        ws.send(JSON.stringify({
          type: "SNAPSHOT_UPDATE",
          payload: this.queue.getSnapshot()
        }));
        break;
      }

      case "INSPECT_RESULT": {
        const { reqId, data, error } = msg.payload || {};
        if (reqId && this.pendingInspects[reqId]) {
          if (error) {
            this.pendingInspects[reqId]({ error });
          } else {
            this.pendingInspects[reqId](data);
          }
          delete this.pendingInspects[reqId];
        }
        break;
      }

      case "RELOAD_RESULT": {
        const { reqId, ok, tabId, newChat, error } = msg.payload || {};
        if (reqId && this.pendingReloads[reqId]) {
          if (error) {
            this.pendingReloads[reqId]({ ok: false, error });
          } else {
            this.pendingReloads[reqId]({ ok: true, tabId, newChat });
          }
          delete this.pendingReloads[reqId];
        }
        break;
      }

      default:
        break;
    }
  }

  sendToExtension(message) {
    if (this.extensionSocket && this.extensionSocket.readyState === 1) {
      this.extensionSocket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  inspectPage() {
    return new Promise((resolve, reject) => {
      if (!this.extensionSocket || this.extensionSocket.readyState !== 1) {
        return reject(new Error("Extension not connected via WebSocket"));
      }
      const reqId = "insp_" + Date.now();
      const timer = setTimeout(() => {
        delete this.pendingInspects[reqId];
        reject(new Error("Timeout inspecting page (extension did not respond within 5s)"));
      }, 5000);

      this.pendingInspects[reqId] = (data) => {
        clearTimeout(timer);
        resolve(data);
      };

      this.sendToExtension({
        type: "INSPECT_PAGE",
        payload: { reqId }
      });
    });
  }

  testInjection(imagePath = "work/thief_16x9.jpg") {
    return new Promise((resolve, reject) => {
      if (!this.extensionSocket || this.extensionSocket.readyState !== 1) {
        return reject(new Error("Extension not connected via WebSocket"));
      }
      let imageBase64 = null;
      let mimeType = "image/jpeg";
      if (imagePath && fs.existsSync(path.resolve(imagePath))) {
        imageBase64 = fs.readFileSync(path.resolve(imagePath)).toString("base64");
        mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
      }

      const reqId = "test_" + Date.now();
      const timer = setTimeout(() => {
        delete this.pendingInspects[reqId];
        reject(new Error("Timeout testing injection"));
      }, 8000);

      this.pendingInspects[reqId] = (data) => {
        clearTimeout(timer);
        resolve(data);
      };

      this.sendToExtension({
        type: "TEST_INJECTION",
        payload: { reqId, imageBase64, mimeType }
      });
    });
  }

  reloadSession(newChat = false) {
    return new Promise((resolve, reject) => {
      if (!this.extensionSocket || this.extensionSocket.readyState !== 1) {
        return reject(new Error("Chrome Extension not connected via WebSocket"));
      }
      const reqId = "rel_" + Date.now();
      const timer = setTimeout(() => {
        delete this.pendingReloads[reqId];
        reject(new Error("Timeout waiting for Meta AI tab session reload (15s)"));
      }, 15000);

      this.pendingReloads[reqId] = (result) => {
        clearTimeout(timer);
        resolve(result);
      };

      this.sendToExtension({
        type: "RELOAD_SESSION",
        payload: { reqId, newChat }
      });
    });
  }

  async dispatchNextTask() {
    if (!this.metaAiState.connected || !this.metaAiState.metaAiReady) {
      return false;
    }

    const task = this.queue.getNextPending();
    if (!task) return false;

    // Send task assignment to extension
    const sent = this.sendToExtension({
      type: "TASK_ASSIGN",
      payload: {
        taskId: task.id,
        imageBase64: task.imageBase64,
        mimeType: task.mimeType,
        prompt: task.prompt,
        freshSession: !!task.freshSession
      }
    });

    if (!sent) {
      task.status = "PENDING";
      this.queue.activeTask = null;
      return false;
    }

    this.queue.updateProgress(task.id, "Dispatched to Meta AI tab");
    return true;
  }

  handleCandidateVideo(taskId, videoUrl, meta = null) {
    const task = this.queue.getTask(taskId);
    if (!task || task.status === "COMPLETED" || task.status === "FAILED") return;

    if (!this.candidateWindows.has(taskId)) {
      const session = {
        taskId,
        candidates: new Map(), // url -> meta or null
        timer: null
      };
      session.candidates.set(videoUrl, meta);
      this.candidateWindows.set(taskId, session);

      this.queue.updateProgress(taskId, "Video stream detected. Evaluating quality & candidates...");

      // Window debounce: wait 2.5s for any parallel renditions/chunks to arrive
      session.timer = setTimeout(async () => {
        this.candidateWindows.delete(taskId);
        const collected = Array.from(session.candidates.entries()).map(([url, candidateMeta]) => ({
          url,
          meta: candidateMeta
        }));
        await this.processFinalCandidates(taskId, collected);
      }, 2500);
    } else {
      const session = this.candidateWindows.get(taskId);
      if (!session.candidates.has(videoUrl)) {
        session.candidates.set(videoUrl, meta);
        this.queue.updateProgress(taskId, `Collecting stream candidates (${session.candidates.size} found)...`);
      }
    }
  }

  async processFinalCandidates(taskId, candidateItems) {
    const task = this.queue.getTask(taskId);
    if (!task || task.status === "COMPLETED") return;

    try {
      const outputDir = path.resolve("./output");
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      const filename = `video_${Date.now()}_${taskId.slice(-5)}.mp4`;
      const localPath = task.outputPath || path.join(outputDir, filename);

      let bestCandidateUrl = candidateItems[0].url;
      let bestMeta = null;
      let bestScore = null;

      if (candidateItems.length === 1) {
        // Single unique stream
        this.queue.updateProgress(taskId, "Downloading final MP4 video...");
        await downloadVideo(bestCandidateUrl, localPath);

        bestMeta = parseMp4Metadata(localPath);
        bestScore = calculateQualityScore(bestMeta);
        console.log(`✔ [Evaluator] Single stream: ${bestMeta.resolution} @ ${bestMeta.bitrateKbps} kbps (Score: ${bestScore})`);
      } else {
        // Multiple candidate streams: evaluate quality across all candidates
        this.queue.updateProgress(taskId, `Evaluating ${candidateItems.length} candidate stream(s)...`);
        const downloadedCandidates = [];

        for (let i = 0; i < candidateItems.length; i++) {
          const item = candidateItems[i];
          const scratchPath = path.join(outputDir, `.scratch_${taskId}_${i}.mp4`);
          try {
            await downloadVideo(item.url, scratchPath);
            const meta = parseMp4Metadata(scratchPath);
            downloadedCandidates.push({
              url: item.url,
              filePath: scratchPath,
              meta
            });
          } catch (e) {
            console.warn(`[Evaluator] Failed downloading candidate ${i}:`, e.message);
            if (fs.existsSync(scratchPath)) {
              try { fs.unlinkSync(scratchPath); } catch (_) {}
            }
          }
        }

        if (downloadedCandidates.length === 0) {
          throw new Error("Failed to download any video stream candidates");
        }

        const evalResult = evaluateBestCandidate(downloadedCandidates);
        console.log(`✔ [Evaluator] ${evalResult.evaluationSummary}`);

        // Promote the best candidate to the final localPath
        fs.renameSync(evalResult.bestCandidate.filePath, localPath);
        bestCandidateUrl = evalResult.bestCandidate.url;
        bestMeta = evalResult.bestCandidate.meta;
        bestScore = evalResult.bestCandidate.score;

        // Clean up discarded scratch files
        for (const disc of evalResult.discardedCandidates) {
          if (disc.filePath && fs.existsSync(disc.filePath)) {
            try { fs.unlinkSync(disc.filePath); } catch (_) {}
          }
        }
      }

      this.queue.completeTask(taskId, {
        videoUrl: bestCandidateUrl,
        localVideoPath: localPath,
        meta: bestMeta,
        score: bestScore
      });

      // Broadcast update to extension side panel
      this.sendToExtension({
        type: "TASK_FINALIZED",
        payload: {
          taskId,
          videoUrl: bestCandidateUrl,
          localVideoPath: localPath,
          meta: bestMeta,
          score: bestScore
        }
      });

      // Always broadcast updated queue snapshot so Side Panel UI is 100% in sync
      this.sendToExtension({
        type: "SNAPSHOT_UPDATE",
        payload: this.queue.getSnapshot()
      });
    } catch (err) {
      console.error(`[Download / Evaluator Error] Task ${taskId}:`, err.message);
      this.queue.completeTask(taskId, {
        videoUrl: candidateItems[0]?.url,
        localVideoPath: null
      });
      this.sendToExtension({
        type: "SNAPSHOT_UPDATE",
        payload: this.queue.getSnapshot()
      });
    }

    // Run next task in queue
    setTimeout(() => this.dispatchNextTask(), 1500);
  }

  async handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    // CORS headers for local tools
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const json = (data, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data, null, 2));
    };

    if (url.pathname === "/api/status" && req.method === "GET") {
      return json({
        ok: true,
        bridge: {
          port: this.port,
          extensionConnected: this.metaAiState.connected,
          metaAiReady: this.metaAiState.metaAiReady,
          tabId: this.metaAiState.tabId,
          tabUrl: this.metaAiState.tabUrl,
          user: this.metaAiState.user,
          lastHeartbeat: this.metaAiState.lastHeartbeat
        },
        stats: this.queue.getStats(),
        activeTask: this.queue.activeTask
      });
    }

    if (url.pathname === "/api/queue" && req.method === "GET") {
      return json({
        active: this.queue.activeTask,
        queue: this.queue.queue
      });
    }

    if (url.pathname === "/api/queue/clear" && req.method === "POST") {
      if (this.queue.activeTask) {
        this.queue.failTask(this.queue.activeTask.id, "Manually cancelled");
      }
      this.queue.queue = [];
      this.sendToExtension({
        type: "SNAPSHOT_UPDATE",
        payload: this.queue.getSnapshot()
      });
      return json({ ok: true, message: "Queue cleared" });
    }

    if (url.pathname === "/api/history" && req.method === "GET") {
      return json(this.queue.history);
    }

    if (url.pathname === "/api/inspect" && req.method === "GET") {
      try {
        const data = await this.inspectPage();
        return json({ ok: true, data });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/session/reload" && req.method === "POST") {
      try {
        const result = await this.reloadSession(false);
        return json({ ok: true, message: "Meta AI tab reloaded successfully", ...result });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/session/new" && req.method === "POST") {
      try {
        const result = await this.reloadSession(true);
        return json({ ok: true, message: "Fresh Meta AI chat session started", ...result });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/reload" && req.method === "POST") {
      this.sendToExtension({ type: "RELOAD_EXTENSION" });
      return json({ ok: true, message: "Reload signal sent to extension" });
    }

    if (url.pathname === "/api/send-message" && req.method === "POST") {
      let bodyStr = "";
      req.on("data", chunk => { bodyStr += chunk; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(bodyStr || "{}");
          this.sendToExtension({ type: "SEND_RAW_MESSAGE", payload: body });
          return json({ ok: true, message: "Raw message dispatched to tab" });
        } catch (err) {
          return json({ ok: false, error: err.message }, 400);
        }
      });
      return;
    }

    if (url.pathname === "/api/test-injection" && req.method === "GET") {
      try {
        const data = await this.testInjection();
        return json({ ok: true, data });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/animate" && req.method === "POST") {
      let bodyStr = "";
      req.on("data", chunk => { bodyStr += chunk; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(bodyStr || "{}");
          let { imagePath, imageBase64, mimeType, prompt, outputPath, freshSession } = body;

          if (!imageBase64 && imagePath) {
            const resolvedPath = path.resolve(imagePath);
            if (!fs.existsSync(resolvedPath)) {
              return json({ ok: false, error: `Image file not found: ${resolvedPath}` }, 400);
            }
            const buffer = fs.readFileSync(resolvedPath);
            imageBase64 = buffer.toString("base64");
            const ext = path.extname(resolvedPath).toLowerCase();
            mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
          }

          if (!imageBase64) {
            return json({ ok: false, error: "Either imagePath or imageBase64 is required" }, 400);
          }

          const task = this.queue.enqueue({
            imagePath,
            imageBase64,
            mimeType,
            prompt,
            outputPath,
            freshSession: !!freshSession
          });

          // Broadcast to extension if active
          this.sendToExtension({
            type: "QUEUE_UPDATED",
            payload: this.queue.getSnapshot()
          });

          return json({
            ok: true,
            taskId: task.id,
            status: task.status,
            message: "Task added to queue"
          });
        } catch (err) {
          return json({ ok: false, error: err.message }, 500);
        }
      });
      return;
    }

    json({ error: "Not Found", path: url.pathname }, 404);
  }
}
