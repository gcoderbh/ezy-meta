import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { EzyMetaServer } from "../server/daemon.js";
import { logger, colors } from "./logger.js";

const DEFAULT_PORT = 4242;

function fetchApi(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const port = options.port || DEFAULT_PORT;
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: endpoint,
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      timeout: 3000
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out. Daemon might be offline."));
    });

    if (options.body) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

export async function commandServe(port = DEFAULT_PORT) {
  logger.banner();
  logger.info(`Starting Ezy-Meta WebSocket Daemon on port ${port}...`);

  const server = new EzyMetaServer(port);
  try {
    const info = await server.start();
    logger.success(`WebSocket Bridge running at ${colors.neonGreen}${info.wsUrl}${colors.reset}`);
    logger.success(`HTTP API running at ${colors.neonGreen}${info.httpUrl}${colors.reset}`);
    console.log(`\n${colors.dim}Ready for Chrome Extension connection. Press Ctrl+C to terminate.${colors.reset}\n`);

    server.queue.on("task_enqueued", (t) => {
      logger.info(`[Queue] Task enqueued: ${t.id} (${t.prompt})`);
    });

    server.queue.on("task_started", (t) => {
      logger.info(`[Active] Task started: ${t.id}`);
    });

    server.queue.on("task_progress", (t) => {
      logger.info(`[Progress] Task ${t.id}: ${t.progress}`);
    });

    server.queue.on("task_completed", (t) => {
      logger.success(`[Completed] Video generated: ${t.localVideoPath || t.videoUrl}`);
    });

    server.queue.on("task_failed", (t) => {
      logger.error(`[Failed] Task ${t.id}: ${t.error}`);
    });
  } catch (err) {
    logger.error(`Failed to start daemon: ${err.message}`);
    process.exit(1);
  }
}

export async function commandStatus(port = DEFAULT_PORT) {
  logger.banner();
  try {
    const res = await fetchApi("/api/status", { port });
    if (res.status !== 200 || !res.data) {
      throw new Error(`Unexpected response code: ${res.status}`);
    }

    const { bridge, stats, activeTask } = res.data;

    const extStatus = bridge.extensionConnected
      ? `${colors.brightGreen}● CONNECTED${colors.reset}`
      : `${colors.red}○ DISCONNECTED${colors.reset}`;

    const metaStatus = bridge.metaAiReady
      ? `${colors.brightGreen}● READY (Tab #${bridge.tabId})${colors.reset}`
      : bridge.extensionConnected
        ? `${colors.yellow}◐ WAITING (Tab not open)${colors.reset}`
        : `${colors.muted}○ N/A${colors.reset}`;

    const userDisplay = bridge.user
      ? `${colors.cyan}${bridge.user}${colors.reset}`
      : `${colors.dim}Anonymous${colors.reset}`;

    const lines = [
      `Bridge Daemon    : ${colors.brightGreen}ONLINE${colors.reset} (Port ${bridge.port})`,
      `Chrome Extension : ${extStatus}`,
      `Meta AI Tab      : ${metaStatus}`,
      `Logged In User   : ${userDisplay}`,
      `Total Generated  : ${colors.neonGreen}${stats.totalGenerated}${colors.reset} videos`,
      `Queue Pending    : ${colors.yellow}${stats.pendingCount}${colors.reset} tasks`,
      `Active Generator : ${activeTask ? `${colors.cyan}${activeTask.id}${colors.reset} (${activeTask.progress})` : `${colors.dim}Idle${colors.reset}`}`
    ];

    logger.box("EZY-META SYSTEM STATUS", lines);
  } catch (err) {
    logger.error(`Daemon is not running (${err.message}).`);
    logger.info(`Run ${colors.neonGreen}ezy-meta serve${colors.reset} to start the local bridge.`);
  }
}

export async function commandAnimate(imagePath, options = {}) {
  logger.banner();
  const port = options.port || DEFAULT_PORT;
  const prompt = options.prompt || "Turn this photo into a video";
  const outputPath = options.output ? path.resolve(options.output) : null;

  if (!imagePath) {
    logger.error("Please provide an image file path. Example: ezy-meta animate photo.jpg");
    process.exit(1);
  }

  const resolvedImagePath = path.resolve(imagePath);
  if (!fs.existsSync(resolvedImagePath)) {
    logger.error(`Image file not found: ${resolvedImagePath}`);
    process.exit(1);
  }

  logger.info(`Preparing image: ${colors.neonGreen}${resolvedImagePath}${colors.reset}`);
  logger.info(`Prompt: "${colors.cyan}${prompt}${colors.reset}"`);

  // First verify daemon is online
  let statusData;
  try {
    const check = await fetchApi("/api/status", { port });
    statusData = check.data;
  } catch (err) {
    logger.warn(`Daemon is not running. Starting standalone daemon automatically...`);
    // Start daemon inline
    const server = new EzyMetaServer(port);
    await server.start();
    statusData = { bridge: server.metaAiState };
  }

  if (!statusData.bridge?.extensionConnected) {
    logger.warn("Chrome Extension is currently disconnected!");
    logger.info("Make sure Google Chrome is open with the Ezy-Meta Extension active.");
  } else if (!statusData.bridge?.metaAiReady) {
    logger.warn("Meta AI tab is not ready yet!");
    logger.info("Please open https://www.meta.ai/ in Chrome and ensure you are logged in.");
  }

  // Send animate request
  logger.info("Submitting task to bridge queue...");
  try {
    const res = await fetchApi("/api/animate", {
      port,
      method: "POST",
      body: {
        imagePath: resolvedImagePath,
        prompt,
        outputPath
      }
    });

    if (res.status !== 200 || !res.data.ok) {
      throw new Error(res.data?.error || `HTTP ${res.status}`);
    }

    const taskId = res.data.taskId;
    logger.success(`Task accepted! ID: ${colors.neonGreen}${taskId}${colors.reset}`);
    logger.info("Waiting for video generation stream (this typically takes 30-90 seconds)...");

    // Poll status until completion
    let lastProgress = "";
    const startTime = Date.now();

    while (true) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const check = await fetchApi("/api/queue", { port });
        const history = await fetchApi("/api/history", { port });

        // Check if finished in history
        const finished = (history.data || []).find(t => t.id === taskId);
        if (finished) {
          if (finished.status === "COMPLETED") {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log("\n");
            logger.success(`Video generation finished in ${elapsed}s!`);
            if (finished.meta) {
              logger.success(`Quality Selected: ${colors.neonGreen}${finished.meta.resolution}${colors.reset} @ ${colors.cyan}${finished.meta.bitrateKbps} kbps${colors.reset} (${finished.meta.durationSec}s, ${finished.meta.fileSizeMb} MB, Score: ${finished.score || 'N/A'})`);
            }
            logger.success(`Local Video Saved: ${colors.brightGreen}${finished.localVideoPath}${colors.reset}`);
            logger.info(`CDN URL: ${colors.dim}${finished.videoUrl}${colors.reset}`);
            return finished;
          } else if (finished.status === "FAILED") {
            console.log("\n");
            logger.error(`Generation failed: ${finished.error}`);
            process.exit(1);
          }
        }

        // Check active task progress
        const active = check.data?.active;
        if (active && active.id === taskId) {
          if (active.progress !== lastProgress) {
            lastProgress = active.progress;
            process.stdout.write(`\r${colors.matrixGreen}⚡ Status:${colors.reset} ${colors.white}${active.progress}...${colors.reset}   `);
          }
        }
      } catch (e) {
        // keep polling
      }
    }
  } catch (err) {
    logger.error(`Failed to submit animation task: ${err.message}`);
    process.exit(1);
  }
}

export async function commandQueue(port = DEFAULT_PORT) {
  logger.banner();
  try {
    const res = await fetchApi("/api/queue", { port });
    const { active, queue } = res.data || {};

    console.log(`${colors.bold}${colors.neonGreen}ACTIVE TASK:${colors.reset}`);
    if (active) {
      console.log(`  ID       : ${active.id}`);
      console.log(`  Prompt   : ${active.prompt}`);
      console.log(`  Progress : ${colors.cyan}${active.progress}${colors.reset}`);
      console.log(`  Image    : ${active.imagePath}`);
    } else {
      console.log(`  ${colors.dim}No task currently generating.${colors.reset}`);
    }

    console.log(`\n${colors.bold}${colors.neonGreen}PENDING QUEUE (${queue ? queue.length : 0}):${colors.reset}`);
    if (queue && queue.length > 0) {
      queue.forEach((t, i) => {
        console.log(`  [${i + 1}] ${t.id} - ${t.prompt} (${t.imagePath})`);
      });
    } else {
      console.log(`  ${colors.dim}Queue is empty.${colors.reset}`);
    }
  } catch (err) {
    logger.error(`Failed to connect to daemon: ${err.message}`);
  }
}

export async function commandHistory(port = DEFAULT_PORT) {
  logger.banner();
  try {
    const res = await fetchApi("/api/history", { port });
    const history = res.data || [];

    console.log(`${colors.bold}${colors.neonGreen}GENERATION HISTORY (${history.length}):${colors.reset}\n`);
    if (history.length === 0) {
      console.log(`  ${colors.dim}No generation history yet.${colors.reset}`);
      return;
    }

    history.forEach((t, i) => {
      const statusColor = t.status === "COMPLETED" ? colors.brightGreen : colors.red;
      console.log(`${colors.matrixGreen}[${i + 1}]${colors.reset} ${statusColor}${t.status}${colors.reset} | ${colors.white}${t.id}${colors.reset} | ${colors.dim}${t.createdAt}${colors.reset}`);
      console.log(`    Prompt : "${t.prompt}"`);
      if (t.meta) {
        console.log(`    Quality: ${colors.neonGreen}${t.meta.resolution}${colors.reset} @ ${colors.cyan}${t.meta.bitrateKbps} kbps${colors.reset} (${t.meta.durationSec}s, ${t.meta.fileSizeMb} MB, Score: ${t.score || 'N/A'})`);
      }
      if (t.localVideoPath) {
        console.log(`    File   : ${colors.neonGreen}${t.localVideoPath}${colors.reset}`);
      } else if (t.error) {
        console.log(`    Error  : ${colors.red}${t.error}${colors.reset}`);
      }
      console.log("");
    });
  } catch (err) {
    logger.error(`Failed to connect to daemon: ${err.message}`);
  }
}
