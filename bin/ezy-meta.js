#!/usr/bin/env node

import { commandServe, commandStatus, commandAnimate, commandQueue, commandHistory } from "../src/cli/commands.js";

const args = process.argv.slice(2);
const command = args[0] || "status";

function parseFlags(argList) {
  const flags = {};
  for (let i = 0; i < argList.length; i++) {
    const arg = argList[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argList[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

const flags = parseFlags(args.slice(1));
const port = flags.port ? parseInt(flags.port, 10) : 4242;

switch (command) {
  case "serve":
  case "start":
    commandServe(port);
    break;

  case "status":
    commandStatus(port);
    break;

  case "animate":
  case "video":
    const imagePath = args[1] && !args[1].startsWith("--") ? args[1] : null;
    commandAnimate(imagePath, {
      port,
      prompt: flags.prompt,
      output: flags.output || flags.out
    });
    break;

  case "queue":
    commandQueue(port);
    break;

  case "history":
    commandHistory(port);
    break;

  case "help":
  case "--help":
  case "-h":
  default:
    console.log(`
ezy-meta - CLI Bridge for Meta AI Image-to-Video Generation

Usage:
  ezy-meta [command] [options]

Commands:
  status                   Check health of Daemon, Extension & Meta AI tab
  animate <image-path>     Submit an image to generate video via Meta AI
  queue                    List pending and active generation tasks
  history                  List finished tasks and generated videos
  serve                    Run the WebSocket daemon bridge in the foreground

Options:
  --prompt "<text>"        Custom prompt (default: "Turn this photo into a video")
  --output "<path>"        Custom output file path for the generated MP4
  --port <number>          Port for WebSocket & HTTP bridge (default: 4242)
  --help, -h               Show this help message

Examples:
  ezy-meta status
  ezy-meta animate ./photo.jpg
  ezy-meta animate ./cat.png --prompt "Make the cat run fast" --output ./cat_running.mp4
  ezy-meta queue
`);
    break;
}
