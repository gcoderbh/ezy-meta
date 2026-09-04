import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";

/**
 * Pure JavaScript MP4 ISO Base Media Box Parser
 * Extracts track dimensions (width, height), timescale, duration, and calculates bitrate.
 * Does not require ffmpeg or any external dependencies.
 *
 * @param {string|Buffer} source - File path or Buffer containing MP4 data
 * @returns {Object} Extracted metadata { width, height, durationSec, timescale, fileSizeBytes }
 */
export function parseMp4Metadata(source) {
  let buf;
  let fileSizeBytes = 0;

  if (typeof source === "string") {
    const stats = fs.statSync(source);
    fileSizeBytes = stats.size;
    // We only need the moov atom header, but reading up to 8MB is plenty for moov headers
    const readSize = Math.min(fileSizeBytes, 8 * 1024 * 1024);
    const fd = fs.openSync(source, "r");
    buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);
  } else if (Buffer.isBuffer(source)) {
    buf = source;
    fileSizeBytes = source.length;
  } else {
    throw new Error("Invalid source for MP4 parser. Expected file path or Buffer.");
  }

  let timescale = 1000;
  let durationUnits = 0;
  let videoWidth = 0;
  let videoHeight = 0;

  function parseBox(start, end) {
    let pos = start;
    while (pos < end && pos + 8 <= buf.length) {
      const size = buf.readUInt32BE(pos);
      const type = buf.toString("ascii", pos + 4, pos + 8);
      let boxSize = size;

      if (size === 1) {
        if (pos + 16 > buf.length) break;
        boxSize = Number(buf.readBigUInt64BE(pos + 8));
      } else if (size === 0) {
        boxSize = end - pos;
      }

      if (boxSize < 8) break;
      const boxEnd = Math.min(pos + boxSize, end);

      if (type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl") {
        parseBox(pos + 8, boxEnd);
      } else if (type === "mvhd") {
        if (pos + 20 <= buf.length) {
          const version = buf[pos + 8];
          const timeScalePos = pos + 8 + (version === 1 ? 20 : 12);
          if (timeScalePos + 8 <= buf.length) {
            timescale = buf.readUInt32BE(timeScalePos) || 1000;
            durationUnits = version === 1
              ? Number(buf.readBigUInt64BE(timeScalePos + 4))
              : buf.readUInt32BE(timeScalePos + 4);
          }
        }
      } else if (type === "tkhd") {
        // Video track header
        if (boxEnd - 8 >= pos) {
          // Track dimensions are stored as 16.16 fixed-point numbers in the last 8 bytes of tkhd
          const widthPos = boxEnd - 8;
          const heightPos = boxEnd - 4;
          if (widthPos + 2 <= buf.length && heightPos + 2 <= buf.length) {
            const w = buf.readUInt16BE(widthPos);
            const h = buf.readUInt16BE(heightPos);
            if (w > 0 && h > 0) {
              videoWidth = w;
              videoHeight = h;
            }
          }
        }
      }
      pos = boxEnd;
    }
  }

  try {
    parseBox(0, buf.length);
  } catch (err) {
    console.warn("[MP4Parser] Warning during box traversal:", err.message);
  }

  const durationSec = timescale > 0 && durationUnits > 0 ? +(durationUnits / timescale).toFixed(2) : 0;
  const bitrateKbps = durationSec > 0 && fileSizeBytes > 0
    ? Math.round((fileSizeBytes * 8) / durationSec / 1000)
    : 0;

  return {
    width: videoWidth,
    height: videoHeight,
    resolution: videoWidth > 0 && videoHeight > 0 ? `${videoWidth}x${videoHeight}` : "Unknown",
    durationSec,
    timescale,
    fileSizeBytes,
    fileSizeMb: +(fileSizeBytes / (1024 * 1024)).toFixed(2),
    bitrateKbps
  };
}

/**
 * Calculates a quality score for a video candidate
 * Priority:
 * 1. Total resolution pixels (Weight: 1.0)
 * 2. Bitrate kbps (Weight: 100.0) -> higher bitrate means sharper image / less compression
 * 3. Valid duration (Bonus: 50,000)
 *
 * @param {Object} meta
 * @returns {number} Score
 */
export function calculateQualityScore(meta) {
  const pixels = (meta.width || 0) * (meta.height || 0);
  const bitrate = meta.bitrateKbps || 0;
  const validDurationBonus = meta.durationSec > 0 ? 50000 : 0;
  return Math.round(pixels + (bitrate * 100) + validDurationBonus);
}

/**
 * Evaluates multiple video candidates and selects the best one
 *
 * @param {Array<Object>} candidates - List of { filePath, url, meta, hash }
 * @returns {Object} { bestCandidate, discardedCandidates, evaluationSummary }
 */
export function evaluateBestCandidate(candidates) {
  if (!candidates || candidates.length === 0) {
    throw new Error("No video candidates provided for evaluation");
  }

  if (candidates.length === 1) {
    const single = candidates[0];
    const score = calculateQualityScore(single.meta);
    return {
      bestCandidate: { ...single, score },
      discardedCandidates: [],
      evaluationSummary: `Single candidate: ${single.meta.resolution} @ ${single.meta.bitrateKbps} kbps (Score: ${score})`
    };
  }

  // Deduplicate candidates by MD5 hash or URL
  const seenHashes = new Set();
  const uniqueCandidates = [];
  const duplicateCandidates = [];

  for (const c of candidates) {
    const hash = c.hash || (c.filePath && fs.existsSync(c.filePath) ? getFileMd5(c.filePath) : null) || c.url;
    if (seenHashes.has(hash)) {
      duplicateCandidates.push({ ...c, discardReason: "Duplicate stream/hash" });
    } else {
      seenHashes.add(hash);
      const score = calculateQualityScore(c.meta);
      uniqueCandidates.push({ ...c, hash, score });
    }
  }

  // Sort unique candidates by score descending
  uniqueCandidates.sort((a, b) => b.score - a.score);

  const bestCandidate = uniqueCandidates[0];
  const otherCandidates = uniqueCandidates.slice(1).map(c => ({
    ...c,
    discardReason: `Lower quality score (${c.score} vs ${bestCandidate.score})`
  }));

  const discardedCandidates = [...otherCandidates, ...duplicateCandidates];

  const summary = [
    `Selected Best: [${bestCandidate.meta.resolution} @ ${bestCandidate.meta.bitrateKbps} kbps, Score: ${bestCandidate.score}]`,
    discardedCandidates.length > 0
      ? `Discarded ${discardedCandidates.length} candidate(s) (${duplicateCandidates.length} duplicate(s), ${otherCandidates.length} lower quality)`
      : "No candidates discarded"
  ].join(" — ");

  return {
    bestCandidate,
    discardedCandidates,
    evaluationSummary: summary
  };
}

/**
 * Calculates MD5 checksum of a file
 * @param {string} filePath
 * @returns {string} MD5 hex
 */
export function getFileMd5(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("md5").update(buf).digest("hex");
}

/**
 * Performs an HTTP HEAD request to probe remote video headers
 *
 * @param {string} urlString
 * @returns {Promise<Object>} { contentLength, contentType, statusCode }
 */
export function probeRemoteVideo(urlString) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(urlString);
      const client = parsedUrl.protocol === "https:" ? https : http;
      const req = client.request(parsedUrl, { method: "HEAD", timeout: 4000 }, (res) => {
        resolve({
          statusCode: res.statusCode,
          contentLength: parseInt(res.headers["content-length"] || "0", 10),
          contentType: res.headers["content-type"] || "video/mp4"
        });
      });
      req.on("error", () => resolve({ statusCode: 0, contentLength: 0, contentType: "unknown" }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ statusCode: 0, contentLength: 0, contentType: "timeout" });
      });
      req.end();
    } catch (e) {
      resolve({ statusCode: 0, contentLength: 0, contentType: "error" });
    }
  });
}
