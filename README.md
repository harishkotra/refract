# REFRACT // shader showdown

Two models. One identical prompt. Live GLSL, compiled in your browser — one side alive, one side black with a compile error. Then the failing model gets **one repair pass** with its own error log fed back. That's the whole show: can it fix its own shader?

https://github.com/user-attachments/assets/d9c7241f-cfca-452d-af0a-a5d04ee93ac2

<img width="1774" height="2071" alt="screencapture-localhost-5173-2026-09-22-23_22_17" src="https://github.com/user-attachments/assets/b1d962fc-f108-4db4-be95-5ba09fc5859f" />
<img width="1766" height="1078" alt="Screenshot at Sep 22 23-22-35" src="https://github.com/user-attachments/assets/41d326ae-2bef-4c70-a6c9-897c1ee1bb85" />
<img width="1774" height="1731" alt="screencapture-localhost-5173-2026-09-22-23_05_18" src="https://github.com/user-attachments/assets/d58e5c3d-70d2-46c6-905e-4222404c5aa8" />

## What it does

You type a scene ("an infinite neon tunnel") and hit **FORGE both**. The app:

1. Sends the **identical prompt** to Model A and Model B concurrently (`Promise.all`).
2. Extracts the GLSL from each reply (```glsl fence preferred, whole-reply fallback if it contains `void main`).
3. Compiles each shader **live in raw WebGL2** — no three.js, no fakes — and renders both side by side on a single `requestAnimationFrame` loop driving `u_time` / `u_resolution`.
4. On failure: black canvas + the **verbatim** `getShaderInfoLog()` + a glowing **Repair** button.
5. Repair re-sends the failing shader + the real error text to the **same** model and re-compiles. Badge flips to REPAIRED.

## Tech stack

| Layer    | Tech |
|----------|------|
| Frontend | Vite 5 + React 18 + TypeScript, raw WebGL2 only |
| Backend  | Node.js + Express + TypeScript (`tsx watch`), port 3001+ auto-detect |
| Models   | Plain `fetch` to OpenAI-compatible `/chat/completions` — no SDK |
| Dev      | `concurrently` runs both; Vite dev middleware forwards `/api` to the backend's live port |

## Architecture

```
┌──────────────┐  identical prompt + nonce   ┌───────────────┐
│   React UI   │ ──────────────────────────▶ │ Express :3001+│
│  :5173(+auto)│  POST /api/forge {prompt,   │               │
│              │   slotA, slotB, temp, toks} │  Promise.all  │
│ ┌────┐ ┌────┐ │ ◀────────────────────────── │  ┌────┐ ┌────┐ │
│ │cv A│ │cv B│ │  {raw, glsl, sha, timings} │  │ A  │ │ B  │ │
│ └────┘ └────┘ │                             │  └┬───┘ └──┬─┘ │
│  one rAF loop │  POST /api/repair           └───┼────────┼───┘
│  u_time/u_res │  {glsl, errorLog, slot}            │  fetch /chat/completions
└──────────────┘                              ┌────▼────────▼───┐
                                              │ Particle / Ollama│
                                              │ LM Studio / OR   │
                                              └──────────────────┘
```

**Key files**

- `backend/src/index.ts` — `/api/forge`, `/api/repair`, `/api/models` proxy, extraction, sha256, retry, port auto-detect (3001–3020, writes `.backend-port`).
- `frontend/src/webgl.ts` — fixed fullscreen-triangle vertex shader (`gl_VertexID`, zero buffers), `compileProgram()` capturing verbatim logs, DPR-aware `fitCanvas()`.
- `frontend/src/App.tsx` — slots, presets, forge/repair flows, history strip, PNG + 1080×1080 share-card export, copy-as-JSON.
- `frontend/vite.config.ts` — dev middleware re-reading the backend port file per request (survives auto-bump races).

## The model-call contract

```ts
// backend/src/index.ts
const body: any = {
  model: slot.model,
  messages: [
    { role: 'system', content: 'You are a precise assistant. Answer the user\'s request directly.' },
    { role: 'user', content: userPrompt }, // identical for A and B, plus a fresh anti-cache nonce
  ],
  temperature,
  max_tokens: budget,
};
// Only Particle deepseek-* understands this field — never send it elsewhere:
if (slot.provider === 'particle' && slot.model.startsWith('deepseek-') && disableThinking)
  body.chat_template_kwargs = { enable_thinking: false };
```

Capability rules the backend enforces:

- **Reasoning tokens** come only from `usage.completion_tokens_details.reasoning_tokens` — absent (Ollama/LM Studio) renders `n/a`, never `0`.
- **`reasoning_content` is stripped** via destructuring and never logged, stored, or returned:
  ```ts
  const { reasoning_content: _strip, reasoning: _strip2, ...safeMsg } = msg;
  ```
- **Empty 200s retry once** at 2× budget (cap 4000) — hidden CoT eats budgets.
- **Fresh nonce per run**, SHA-256 of every raw reply — re-runs must not be byte-identical or you're reading a cache.
- **Model picker never gates a run** — `/models` populates suggestions, but hand-typed names (e.g. `deepseek-v4-flash-0731`) always work.

The shader contract stamped into every prompt:

```glsl
precision highp float;
uniform float u_time;       // seconds, animated
uniform vec2  u_resolution; // pixels
out vec4 outColor;          // must write to outColor
// No textures, no external assets, no includes.
```

## Provider presets

| Preset | Base URL | Key? | Models |
|--------|----------|------|--------|
| Particle.ai | `https://api.particle.ai/v1` | yes | `deepseek-v4.1-flash`, `deepseek-v4-flash-0731`, `glm5.3flash` |
| Ollama | `http://127.0.0.1:11434/v1` | no | live via `GET /v1/models` |
| LM Studio | `http://127.0.0.1:1234/v1` | no | live via `GET /v1/models` |
| OpenRouter | `https://openrouter.ai/api/v1` | yes | live via `GET /v1/models` |
| Custom | you type it | optional | you type it |

All calls go through the backend — that's what makes localhost providers work with zero CORS config and keeps keys out of the client bundle.

## Quickstart

```bash
git clone <this-repo> && cd Refract
npm install          # installs root + both workspaces
npm run dev          # backend :3001 (+auto-bump) · frontend :5173 (+auto-bump)
```

1. Open the frontend URL. 2. Paste API keys into Slot A / Slot B (persisted to `localStorage` only — never committed). 3. Pick a preset, hit **FORGE both**.

> If a port is taken (Vite bumps to :5174, backend to :3002, …) everything still works — the frontend tracks the backend's port live.

## Verification experiments

1. **Neon tunnel** — at least one side compiles and animates.
2. **Broken shader** — paste the prefilled broken example into the repair box; expect the verbatim GLSL log, then a changed code output after repair.
3. **Nonce check** — run preset 1 twice; outputs must differ (else a response cache is faking determinism).

## Fork & contribute

```bash
git fork / git clone your-fork
npm install && npm run dev
```

Ideas worth building:

- **Tournament mode** — round-robin N models, ELO from compile-rate + repair-rate.
- **Diff view** — original vs repaired shader side by side with line highlights.
- **Frame-diff scoring** — perceptual hash of both canvases as an automatic "most interesting shader" vote.
- **Prompt mutation lab** — A/B contract wordings, measure compile-rate deltas.
- **Share links** — encode `{prompt, models, sha}` into a URL that replays a run.
- **WebGPU backend** — same rig, WGSL contract, compare failure modes.

PRs welcome — keep `reasoning_content` stripped, keys out of the repo, and WebGL raw.
