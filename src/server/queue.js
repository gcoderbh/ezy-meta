import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export class TaskQueue extends EventEmitter {
  constructor(historyPath = "./output/.ezy-meta-history.json") {
    super();
    this.historyPath = path.resolve(historyPath);
    this.queue = [];
    this.activeTask = null;
    this.history = this.loadHistory();
  }

  loadHistory() {
    try {
      if (fs.existsSync(this.historyPath)) {
        const raw = fs.readFileSync(this.historyPath, "utf8");
        return JSON.parse(raw);
      }
    } catch (e) {
      // ignore
    }
    return [];
  }

  saveHistory() {
    try {
      const dir = path.dirname(this.historyPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.historyPath, JSON.stringify(this.history.slice(-100), null, 2));
    } catch (e) {
      // ignore
    }
  }

  enqueue({ id, imagePath, imageBase64, mimeType, prompt, outputPath, freshSession = false }) {
    const task = {
      id: id || "task_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
      imagePath,
      imageBase64,
      mimeType: mimeType || "image/jpeg",
      prompt: prompt || "Turn this photo into a video",
      outputPath,
      freshSession: !!freshSession,
      status: "PENDING", // PENDING, PROCESSING, COMPLETED, FAILED
      progress: "Queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      videoUrl: null,
      localVideoPath: null,
      error: null
    };

    this.queue.push(task);
    this.emit("task_enqueued", task);
    return task;
  }

  getNextPending() {
    if (this.activeTask) return null;
    const task = this.queue.find(t => t.status === "PENDING");
    if (task) {
      task.status = "PROCESSING";
      task.updatedAt = new Date().toISOString();
      this.activeTask = task;
      this.emit("task_started", task);
    }
    return task;
  }

  updateProgress(taskId, progressText) {
    const task = this.getTask(taskId);
    if (task) {
      task.progress = progressText;
      task.updatedAt = new Date().toISOString();
      this.emit("task_progress", task);
    }
  }

  completeTask(taskId, { videoUrl, localVideoPath, meta = null, score = null }) {
    const task = this.getTask(taskId);
    if (!task || task.status === "COMPLETED") return;
    
    task.status = "COMPLETED";
    task.progress = "Completed";
    task.videoUrl = videoUrl;
    task.localVideoPath = localVideoPath;
    task.meta = meta;
    task.score = score;
    task.completedAt = new Date().toISOString();
    task.updatedAt = new Date().toISOString();

    // Remove from queue and ensure no duplicates in history
    this.queue = this.queue.filter(t => t.id !== taskId);
    if (this.activeTask && this.activeTask.id === taskId) {
      this.activeTask = null;
    }
    this.history = this.history.filter(t => t.id !== taskId);
    this.history.unshift(task);
    this.saveHistory();
    this.emit("task_completed", task);
  }

  failTask(taskId, error) {
    const task = this.getTask(taskId);
    if (task) {
      task.status = "FAILED";
      task.progress = "Failed";
      task.error = error;
      task.failedAt = new Date().toISOString();
      task.updatedAt = new Date().toISOString();

      this.queue = this.queue.filter(t => t.id !== taskId);
      if (this.activeTask && this.activeTask.id === taskId) {
        this.activeTask = null;
      }
      this.history.unshift(task);
      this.saveHistory();
      this.emit("task_failed", task);
    }
  }

  getTask(taskId) {
    if (this.activeTask && this.activeTask.id === taskId) return this.activeTask;
    return this.queue.find(t => t.id === taskId) || this.history.find(t => t.id === taskId);
  }

  getStats() {
    const completed = this.history.filter(t => t.status === "COMPLETED").length;
    const failed = this.history.filter(t => t.status === "FAILED").length;
    return {
      pendingCount: this.queue.filter(t => t.status === "PENDING").length,
      isProcessing: !!this.activeTask,
      totalCompleted: completed,
      totalFailed: failed,
      totalGenerated: completed
    };
  }

  getSnapshot() {
    return {
      stats: this.getStats(),
      activeTask: this.activeTask,
      queue: this.queue,
      history: this.history.slice(0, 20)
    };
  }
}
