---
name: ezy-meta
description: Automated Meta AI Image-to-Video generation using the Ezy-Meta CLI and Chrome Extension Bridge. Activate this skill whenever the user wants to convert an image into a video/animation, generate motion scenes using Meta AI, or automate Meta AI workflows.
---

# Ezy-Meta — Meta AI Image-to-Video Automation Guide

Ezy-Meta is an automated high-performance bridge connecting command-line workflows with **Meta AI (https://www.meta.ai/)** to generate high-quality AI animations and videos from static images using Meta's video models.

---

## System Architecture

```
[ Terminal / AI Agent ]
         │
         ▼
[ ezy-meta CLI / Daemon ] ◄── ws://127.0.0.1:4242 ──► [ Ezy-Meta Chrome Extension ]
         │                                                           │
         ▼                                                           ▼
[ Evaluator / MP4 Engine ]                                 [ Active Meta.ai Tab ]
         │
         ▼
[ Best Quality Video in ./output/ ]
```

### Core Components
1. **CLI / Bridge Daemon (`src/server/daemon.js`, port 4242)**:
   - WebSocket & REST HTTP server.
   - Dual-window queue manager (`queue.js`).
   - Multi-stream video downloader & quality evaluator (`evaluator.js`).
2. **Chrome Extension (`extension/`)**:
   - Background service worker (`background.js`): listens for CDN network requests, tracks tab state, manages session lifecycles, and dispatches tasks.
   - Content script (`content.js`): handles file attachment, React 18 composer injection, send trigger, and video generation observation.
   - Side panel UI (`sidepanel.html`, `sidepanel.js`): real-time dashboard displaying system status, queue, and completed generations.

---

## Key Features & Capabilities

### 1. Multi-Stream Quality Evaluator
Meta AI often streams multiple parallel candidate renditions for a single generation. Ezy-Meta's Evaluator:
- Opens a debounce window (2.5s) to capture all candidate CDN stream URLs.
- Downloads candidates into scratch files and parses native MP4 box atoms (`moov`, `mvhd`, `tkhd`, `mdhd`) to extract exact resolution (width x height), duration, and bitrate.
- Applies a quality formula:
  $$\text{Score} = (\text{Resolution}) \times \left(\frac{\text{Bitrate}}{1000}\right) \times 0.7 + \left(\frac{\text{FileSize}}{1024}\right) \times 0.3$$
- Automatically selects the highest quality stream, saves to `./output/`, and cleans up scratch files.

### 2. Session Lifecycle & Clean New Chat
To prevent memory bloat and stale context in Meta AI:
- **`ezy-meta session new`** or **`--fresh`**:
  - Automatically clicks and dismisses any pending discard / leave modals (`"Discard"`, `"Leave"`, `"ทิ้ง"`, `"Confirm"`, `"OK"`).
  - Navigates the tab to a clean `https://www.meta.ai/` URL.
  - Clears any draft leftover in the textarea composer.
- **Auto-Refresh**: Automatically reloads the session after 5 consecutive generations to prevent memory leakage.

### 3. React 18 DOM & Synthetic Event Reliability
- Injects attachments via native `DataTransfer` on hidden file inputs and verifies chip appearance (up to 4.8s).
- Dispatches prompt text using both descriptor setters and `document.execCommand("insertText")` with Enter fallback so React's internal `_valueTracker` activates the Send button.
- Singleton listener guard (`window.__EZY_META_LISTENER_REGISTERED__`) ensures no duplicate task executions.

---

## Core Commands

Always execute commands within the workspace `/Users/mbkkprajukk/Documents/poc/ezy-meta`:

```bash
# 1. System Health Check
node bin/ezy-meta.js status

# 2. Run Daemon in Foreground (if not already running in background)
node bin/ezy-meta.js serve

# 3. Generate Video from Image (Default prompt)
node bin/ezy-meta.js animate ./examples/calico_cat.jpg

# 4. Generate Video with Custom Prompt & Output Path
node bin/ezy-meta.js animate ./character.png \
  --prompt "Animate character breathing and looking around with curious eyes" \
  --output ./output/character_motion.mp4

# 5. Generate Video with Brand New Chat Session
node bin/ezy-meta.js animate ./examples/panda.jpg \
  --prompt "Turn this photo into a video: panda sitting and chewing bamboo slowly" \
  --fresh

# 6. Session Management
node bin/ezy-meta.js session reload   # Refresh current tab
node bin/ezy-meta.js session new      # Start fresh clean chat session

# 7. Inspect Task Queue & History
node bin/ezy-meta.js queue            # View active & pending queue
node bin/ezy-meta.js history          # View completed generations with quality stats
```

---

## REST API Endpoints (Port 4242)

The daemon exposes HTTP REST endpoints for external integrations and scripting:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/status` | System health, extension connection, and tab readiness |
| `POST` | `/api/animate` | Enqueue video animation (`imagePath`, `prompt`, `outputPath`, `freshSession`) |
| `GET` | `/api/queue` | Inspect active and pending task queues |
| `POST` | `/api/queue/clear` | Cancel active task and clear all pending queue items |
| `GET` | `/api/history` | List finished tasks with resolution, bitrate, and scores |
| `POST` | `/api/session/new` | Trigger fresh chat navigation and modal discard on tab |
| `POST` | `/api/session/reload` | Reload active Meta AI tab |
| `GET` | `/api/inspect` | Dump active DOM elements, buttons, and composer state |

---

## Workflow Guide for Agents

When requested to convert an image to video or automate Meta AI:

### Step 1: Health Check
Run status check first:
```bash
node bin/ezy-meta.js status
```
- If Daemon is offline, run `node bin/ezy-meta.js serve` as a daemon or let `animate` auto-spawn.
- If Extension is disconnected, ensure Chrome is open with the unpacked extension loaded.
- If Meta AI tab is not ready, ensure `https://www.meta.ai/` is open and logged in.

### Step 2: Animate Image
Run animation command with appropriate options:
```bash
node bin/ezy-meta.js animate <image-path> --prompt "<prompt>" [--output <path>] [--fresh]
```
- Use `--fresh` whenever a clean conversation context is preferred.
- Generation typically takes 40-75 seconds.

### Step 3: Verify & Return Output
- Output MP4 will be saved to `./output/` (or the specified `--output` path).
- Report the local file path, resolution, bitrate, and duration to the user.
