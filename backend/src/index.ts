import express from 'express';
import cors from 'cors';
import { createHash, randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const SYSTEM = "You are a precise assistant. Answer the user's request directly.";

export const SHADER_CONTRACT = `Write a complete GLSL ES 3.00 fragment shader. It must declare exactly:
  precision highp float;
  uniform float u_time;      // seconds, animated
  uniform vec2  u_resolution; // pixels
  out vec4 outColor;
and must write to outColor. No textures, no external assets, no includes. Output only the shader inside one \`\`\`glsl code fence.`;

interface SlotConfig { provider: string; baseUrl: string; apiKey?: string; model: string; }

function normalizeBase(u: string) { return (u || '').trim().replace(/\/+$/, ''); }

function extractGlsl(reply: string): { code: string; path: string } {
  const fence = reply.match(/```(?:glsl|c|cpp)?\s*\n([\s\S]*?)```/i);
  if (fence && fence[1] && /void\s+main/i.test(fence[1])) return { code: fence[1].trim(), path: 'fence:glsl' };
  if (reply.includes('void main')) return { code: reply.trim(), path: 'fallback:whole-reply' };
  if (fence) return { code: fence[1].trim(), path: 'fence:unverified' };
  return { code: reply.trim(), path: 'fallback:raw' };
}

async function callModel(slot: SlotConfig, userPrompt: string, temperature: number, maxTokens: number, disableThinking: boolean) {
  const base = normalizeBase(slot.baseUrl);
  const t0 = Date.now();
  let budget = Math.max(maxTokens, 1);
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const body: any = {
      model: slot.model,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt }],
      temperature,
      max_tokens: budget,
    };
    if (slot.provider === 'particle' && slot.model.startsWith('deepseek-') && disableThinking) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(slot.apiKey ? { Authorization: `Bearer ${slot.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new Error(`Cannot reach ${base} — is ${slot.provider === 'ollama' ? 'Ollama' : slot.provider === 'lmstudio' ? 'LM Studio' : 'the server'} running? ${e?.cause ? String((e.cause as any)?.message || e.cause) : String(e?.message || e)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${slot.provider} error ${res.status}: ${text.slice(0, 800)}`);
    let json: any;
    try { json = JSON.parse(text); } catch { throw new Error(`${slot.provider} returned non-JSON: ${text.slice(0, 400)}`); }
    const msg = json?.choices?.[0]?.message || {};
    // STRIP reasoning_content: never log/store/return it
    const { reasoning_content: _strip, reasoning: _strip2, ...safeMsg } = msg;
    const content: string = (typeof safeMsg.content === 'string' ? safeMsg.content : Array.isArray(safeMsg.content) ? safeMsg.content.map((p: any) => p?.text || '').join('') : '') || '';
    const reasoningTokens: number | null = json?.usage?.completion_tokens_details?.reasoning_tokens ?? null;
    if (!content.trim()) {
      // hidden CoT ate the budget — retry once with double, cap 4000
      lastErr = `HTTP 200 with empty content (attempt ${attempt + 1}, budget ${budget})`;
      budget = Math.min(budget * 2, 4000);
      if (attempt === 1) throw new Error(lastErr + ' — hidden reasoning consumed the budget. Raised max_tokens; still empty.');
      continue;
    }
    const { code, path } = extractGlsl(content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    return {
      rawReply: content, extractedGlsl: code, extractionPath: path,
      sha256, latencyMs: Date.now() - t0,
      promptTokens: json?.usage?.prompt_tokens ?? null,
      completionTokens: json?.usage?.completion_tokens ?? null,
      reasoningTokens,
      model: slot.model, provider: slot.provider,
    };
  }
  throw new Error(lastErr);
}

// List models via backend (avoids CORS, keeps keys server-side)
app.get('/api/models', async (req, res) => {
  const base = normalizeBase(String(req.query.baseUrl || ''));
  const apiKey = String(req.query.apiKey || '');
  if (!base) return res.status(400).json({ error: 'baseUrl required' });
  try {
    const r = await fetch(`${base}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    const t = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: t.slice(0, 800) });
    res.type('json').send(t);
  } catch (e: any) {
    res.status(502).json({ error: `Cannot reach ${base} — is the server running? ${e?.message || e}` });
  }
});

app.post('/api/forge', async (req, res) => {
  const { prompt, slotA, slotB, temperature = 0, maxTokens = 1600, disableThinkingA = false, disableThinkingB = false, nonce } = req.body || {};
  if (!prompt || !slotA || !slotB) return res.status(400).json({ error: 'prompt, slotA, slotB required' });
  // Nonce guard: server asserts nonce present to defeat response caches
  const nA = `${prompt}\n\nRun nonce: ${nonce || randomUUID()}-A`;
  const nB = `${prompt}\n\nRun nonce: ${nonce || randomUUID()}-B`;
  try {
    const [a, b] = await Promise.all([
      callModel(slotA, nA, temperature, Math.max(maxTokens, 900), disableThinkingA),
      callModel(slotB, nB, temperature, Math.max(maxTokens, 900), disableThinkingB),
    ]);
    res.json({ a, b, contract: SHADER_CONTRACT });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || String(e) });
  }
});

app.post('/api/repair', async (req, res) => {
  const { glsl, errorLog, slot, temperature = 0, maxTokens = 1600, disableThinking = false } = req.body || {};
  if (!glsl || !errorLog || !slot) return res.status(400).json({ error: 'glsl, errorLog, slot required' });
  const repairPrompt = `The following GLSL ES 3.00 fragment shader failed to compile. Fix it so it compiles under WebGL2 and satisfies the shader contract.\n\n${SHADER_CONTRACT}\n\nFailing shader:\n\`\`\`glsl\n${glsl}\n\`\`\`\n\nVerbatim compiler log:\n${errorLog}\n\nOutput only the corrected shader inside one \`\`\`glsl code fence. Run nonce: ${randomUUID()}`;
  try {
    const result = await callModel(slot, repairPrompt, temperature, Math.max(maxTokens, 900), disableThinking);
    res.json(result);
  } catch (e: any) {
    res.status(502).json({ error: e?.message || String(e) });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

const preferred = Number(process.env.PORT || 3001);
async function listenAuto() {
  for (let port = preferred; port < preferred + 20; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = app.listen(port, () => {
          console.log(`refract backend on :${port}`);
          try {
            const dir = dirname(fileURLToPath(import.meta.url));
            writeFileSync(join(dir, '..', '..', '.backend-port'), String(port));
          } catch { /* best effort */ }
          resolve();
        });
        server.on('error', reject);
      });
      return;
    } catch (e: any) {
      if (e?.code === 'EADDRINUSE') { console.log(`port ${port} in use, trying ${port + 1}...`); continue; }
      throw e;
    }
  }
  throw new Error(`no free port in ${preferred}..${preferred + 19}`);
}
listenAuto().catch((e) => { console.error(e); process.exit(1); });
