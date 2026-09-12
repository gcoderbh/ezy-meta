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
- **Composer Hydration**: Waits for `.composer-add-attachment-button-skeleton` to resolve before attempting file injection.
- **Attachment Token Preservation**: Preserves `[image:UUID]` attachment tokens in the textarea composer to ensure the file remains linked when prompt text is inserted.
- **Full Pointer & Keyboard Simulation**: Dispatches complete event sequence (`pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`, and `Enter` key on textarea) to reliably trigger React 18 synthetic form submission.
- **Fail-Fast Quota & Error Detection**: Instantly detects backend server errors and daily media rate limit notices (`"reached your limit"` / `"Meta One Core"`) without hanging on timeouts.

### 4. Aspect Ratio & Canvas Optimization for Video Models
- Meta AI's video model natively expects landscape media (16:9, ~1376x768 or 1216x672).
- **Avoid Raw Square Inputs**: Submitting square 1:1 images directly can cause Meta AI's backend to fail with *"Adjusting video dimensions"* or server errors.
- **Best Practice for 2D Sprites**: Pad the character onto a 16:9 canvas (e.g. 1376x768) filled with solid `#FF00FF` magenta. This also gives characters horizontal room to slide, slash, and throw without clipping out of frame.

### 5. Prompt Construction Guidelines
- **Mandatory Video Intent Prefix**: The prompt **must** start with:
  ```text
  Turn this photo into a video: <action description>
  ```
  *(Note: Prompts starting with "Turn this photo into a 2D game sprite animation" can trigger Meta AI's text chat assistant instead of the video engine).*
- **Chroma Background Locking Clause**: Always append the strict background lock clause:
  ```text
  2D side-scroller sprite in-place motion. CRITICAL: Solid static flat pure magenta #FF00FF background, strictly zero gradients, no white glow, no lighting changes, no background animation, camera locked.
  ```

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
node bin/ezy-meta.js animate ./work/thief_16x9.jpg \
  --prompt "Turn this photo into a video: The pixel-art rogue dashes forward into a low ground slide facing right in place, sliding low with front leg extended, then recovers back up to crouching combat stance. 2D side-scroller sprite in-place motion. CRITICAL: Solid static flat pure magenta #FF00FF background, strictly zero gradients, no white glow, no lighting changes, no background animation, camera locked." \
  --output ./work/set1_slide/slide.mp4

# 5. Generate Video with Brand New Chat Session
node bin/ezy-meta.js animate ./work/thief_16x9.jpg \
  --prompt "Turn this photo into a video: The pixel-art rogue draws steel sword and slashes forward in place facing right..." \
  --fresh

# 6. Session Management
node bin/ezy-meta.js session reload   # Refresh current tab
node bin/ezy-meta.js session new      # Start fresh clean chat session

# 7. Inspect Task Queue & History
node bin/ezy-meta.js queue            # View active & pending queue
node bin/ezy-meta.js history          # View completed generations with quality stats
```

---

## Pipeline Integration: Ezy-Meta + Agent-Sprite-Forge (`video2dsprite`)

When converting Meta AI videos into 2D game spritesheets:

1. **Base Still Setup**:
   - Pad the sprite onto a 1376x768 canvas with `#FF00FF` magenta background.
2. **Generate Video via Ezy-Meta**:
   - Run `node bin/ezy-meta.js animate <padded-image> --prompt "<prompt>" --output <path>`
3. **Postprocess with `video2dsprite.py`**:
   ```bash
   PATH="/opt/homebrew/bin:$PATH" /Users/mbkkprajukk/Documents/devkit/agent-sprite-forge/.venv/bin/python \
     /Users/mbkkprajukk/Documents/devkit/agent-sprite-forge/skills/video2dsprite/scripts/video2dsprite.py process \
     --video ./work/set1_slide/slide.mp4 \
     --out-dir ./work/set1_slide/processed \
     --name slide \
     --frame-counts 8,16,24 \
     --cell-size 192 \
     --body-height 110 \
     --foot-y 170
   ```
4. **Key Pipeline Fixes**:
   - **Modern FFmpeg**: Uses `-fps_mode passthrough` for FFmpeg 9.0+ compatibility.
   - **Background Pulsing Defense**: Chroma keying handles video brightness oscillations between `#FF00FF` (`[250, 1, 253]`) and dark purple (`[208, 6, 211]`).
   - **Consistent Global Scale**: Uses a unified sequence scale so characters never shrink or stretch when ducking, sliding, or falling dead.

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
| `POST` | `/api/send-message` | Send raw follow-up text prompt to current Meta AI conversation |

---

## Known Limits & Quotas

- **Daily Media Limit**: Free Meta AI accounts are limited to approximately 6–8 video generations per 24 hours.
- When the quota is reached, Meta AI returns:
  > *"Upgrade to do more. You reached your limit. Get Meta One Core for more media with AI, or wait until tomorrow."*
- To continue immediately, log into a secondary Meta account in Chrome or wait for the daily quota to reset.
