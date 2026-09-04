---
name: ezy-meta
description: Automated Meta AI Image-to-Video generation using the Ezy-Meta CLI and Chrome Extension Bridge. Activate this skill whenever the user wants to convert an image into a video/animation, generate motion scenes using Meta AI, or automate Meta AI workflows.
---

# Ezy-Meta — Meta AI Image-to-Video Automation Guide

Ezy-Meta is an automated bridge connecting command-line workflows with **Meta AI (https://www.meta.ai/)** to generate high-quality AI videos from static images using Meta's video models.

---

## Architecture Overview

```
[ Antigravity Agent / Terminal ]
             │
             ▼
   [ ezy-meta CLI / Daemon ]  ◄── ws://127.0.0.1:4242 ──►  [ Ezy-Meta Chrome Extension ]
             │                                                                │
             ▼                                                                ▼
   [ Output MP4 Videos ]                                          [ Active Meta.ai Tab ]
```

1. **CLI / Daemon**: Manages task queue, serves WebSocket on port `4242`, receives image paths, and auto-downloads generated MP4 videos.
2. **Chrome Extension**: Runs in Google Chrome, syncs with local daemon, detects active `meta.ai` tab, uploads image attachments, clicks "Animate", and captures the stream video URL.

---

## Prerequisites

Before running animation tasks, ensure:
1. **Chrome Extension Loaded**:
   - Open Chrome at `chrome://extensions`.
   - Enable **Developer mode** (toggle at top right).
   - Click **Load unpacked** and select the `/Users/mbkkprajukk/Documents/poc/ezy-meta/extension` directory.
2. **Meta AI Tab Open**:
   - Make sure at least one tab with `https://www.meta.ai/` is open and signed in.

---

## Core Commands

Always execute commands within the workspace `/Users/mbkkprajukk/Documents/poc/ezy-meta`:

```bash
# Check system and bridge status (CLI, Extension, and Meta.ai tab health)
node bin/ezy-meta.js status

# Start the bridge daemon in the foreground (if running as dedicated service)
node bin/ezy-meta.js serve

# Generate a video from an image
node bin/ezy-meta.js animate ./path/to/image.jpg

# Custom prompt & output path
node bin/ezy-meta.js animate ./character.png \
  --prompt "Animate character breathing and looking around" \
  --output ./output/character_motion.mp4

# Inspect current queue
node bin/ezy-meta.js queue

# Inspect generation history
node bin/ezy-meta.js history
```

---

## Workflow Guide for Agents

When requested to convert an image to video:

### Step 1: Health Check
Run status check first to verify the extension and tab are ready:
```bash
node bin/ezy-meta.js status
```
- If CLI Daemon is offline, run `node bin/ezy-meta.js serve` or the `animate` command will automatically initialize a standalone session.
- If Extension is disconnected, remind the user to load or reload the extension in Chrome.
- If Meta AI tab is not found, open `https://www.meta.ai/` in Chrome.

### Step 2: Trigger Video Generation
Invoke `animate` with the target image:
```bash
node bin/ezy-meta.js animate <image-path> --prompt "<prompt>"
```
The command will:
1. Enqueue the task and send it to the extension over WebSocket.
2. Inject the image into Meta AI's composer.
3. Automatically trigger the "Animate" button.
4. Stream progress until completion (typically 30-90 seconds).
5. Download the final `.mp4` into `./output/`.

### Step 3: Return Output
Report the saved MP4 file path to the user and confirm generation results.
