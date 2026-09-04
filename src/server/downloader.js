import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";

export async function downloadVideo(url, targetPath) {
  const fullPath = path.resolve(targetPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const fetchUrl = (currentUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        return reject(new Error("Too many redirects downloading video"));
      }

      const client = currentUrl.startsWith("https:") ? https : http;
      const req = client.get(currentUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
          "Referer": "https://www.meta.ai/"
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchUrl(res.headers.location, redirectCount + 1);
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          return reject(new Error(`Failed to download video: HTTP status ${res.statusCode}`));
        }

        const fileStream = fs.createWriteStream(fullPath);
        res.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close(() => resolve(fullPath));
        });

        fileStream.on("error", (err) => {
          fs.unlink(fullPath, () => {});
          reject(err);
        });
      });

      req.on("error", (err) => {
        reject(err);
      });
    };

    fetchUrl(url);
  });
}
