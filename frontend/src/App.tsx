import { useEffect, useRef, useState } from 'react';
import './styles.css';
import { compileProgram, fitCanvas } from './webgl';

const PRESETS = ['liquid chrome sphere', 'fire on a dark background', 'rain running down a glass window', 'an infinite neon tunnel'];
const PROVIDERS: Record<string, { base: string; needsKey: boolean; builtins: string[] }> = {
  particle: { base: 'https://api.particle.ai/v1', needsKey: true, builtins: ['deepseek-v4.1-flash', 'deepseek-v4-flash-0731', 'glm5.3flash'] },
  ollama: { base: 'http://127.0.0.1:11434/v1', needsKey: false, builtins: [] },
  lmstudio: { base: 'http://127.0.0.1:1234/v1', needsKey: false, builtins: [] },
  openrouter: { base: 'https://openrouter.ai/api/v1', needsKey: true, builtins: [] },
  custom: { base: '', needsKey: false, builtins: [] },
};
const CONTRACT = `Write a complete GLSL ES 3.00 fragment shader. It must declare exactly:
  precision highp float;
  uniform float u_time;      // seconds, animated
  uniform vec2  u_resolution; // pixels
  out vec4 outColor;
and must write to outColor. No textures, no external assets, no includes. Output only the shader inside one \`\`\`glsl code fence.`;

interface Slot { provider: string; baseUrl: string; apiKey: string; model: string; }
interface ForgeSide { rawReply: string; extractedGlsl: string; extractionPath: string; sha256: string; latencyMs: number; promptTokens: number | null; completionTokens: number | null; reasoningTokens: number | null; }
interface Hist { prompt: string; modelA: string; modelB: string; aOk: boolean; bOk: boolean; at: string; }

const def = (v: string | null, fb: string) => v ?? fb;
function load(): any {
  try { return JSON.parse(localStorage.getItem('refract') || '{}'); } catch { return {}; }
}

export default function App() {
  const saved = useRef(load()).current;
  const [slotA, setSlotA] = useState<Slot>({
    provider: def(saved.slotA?.provider, 'particle'), baseUrl: def(saved.slotA?.baseUrl, PROVIDERS.particle.base),
    apiKey: def(saved.slotA?.apiKey, ''), model: def(saved.slotA?.model, 'deepseek-v4-flash-0731'),
  });
  const [slotB, setSlotB] = useState<Slot>({
    provider: def(saved.slotB?.provider, 'particle'), baseUrl: def(saved.slotB?.baseUrl, PROVIDERS.particle.base),
    apiKey: def(saved.slotB?.apiKey, ''), model: def(saved.slotB?.model, 'deepseek-v4.1-flash'),
  });
  const [temperature, setTemperature] = useState(saved.temperature ?? 0);
  const [maxTokens, setMaxTokens] = useState(saved.maxTokens ?? 1600);
  const [disA, setDisA] = useState(saved.disA ?? false);
  const [disB, setDisB] = useState(saved.disB ?? false);
  const [prompt, setPrompt] = useState('an infinite neon tunnel');
  const [phase, setPhase] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [resA, setResA] = useState<ForgeSide | null>(null);
  const [resB, setResB] = useState<ForgeSide | null>(null);
  const [logA, setLogA] = useState(''); const [logB, setLogB] = useState('');
  const [okA, setOkA] = useState('IDLE'); const [okB, setOkB] = useState('IDLE');
  const [repairGlsl, setRepairGlsl] = useState('');
  const [hist, setHist] = useState<Hist[]>(saved.hist || []);
  const [err, setErr] = useState('');
  const [modelsA, setModelsA] = useState<string[]>([]); const [modelsB, setModelsB] = useState<string[]>([]);
  const cA = useRef<HTMLCanvasElement>(null); const cB = useRef<HTMLCanvasElement>(null);
  const progA = useRef<WebGLProgram | null>(null); const progB = useRef<WebGLProgram | null>(null);
  const glA = useRef<WebGL2RenderingContext | null>(null); const glB = useRef<WebGL2RenderingContext | null>(null);

  useEffect(() => {
    localStorage.setItem('refract', JSON.stringify({ slotA, slotB, temperature, maxTokens, disA, disB, hist }));
  }, [slotA, slotB, temperature, maxTokens, disA, disB, hist]);

  // single rAF loop driving both canvases
  useEffect(() => {
    let raf = 0; const t0 = performance.now();
    const frame = () => {
      const t = (performance.now() - t0) / 1000;
      for (const [c, gl, prog] of [[cA.current, glA.current, progA.current], [cB.current, glB.current, progB.current]] as const) {
        if (!c || !gl || !prog) continue;
        const { w, h } = fitCanvas(c);
        gl.viewport(0, 0, w, h); gl.useProgram(prog);
        const lt = gl.getUniformLocation(prog, 'u_time'); const lr = gl.getUniformLocation(prog, 'u_resolution');
        if (lt) gl.uniform1f(lt, t); if (lr) gl.uniform2f(lr, w, h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  async function fetchModels(slot: Slot, set: (m: string[]) => void) {
    try {
      const r = await fetch(`/api/models?baseUrl=${encodeURIComponent(slot.baseUrl)}&apiKey=${encodeURIComponent(slot.apiKey || '')}`);
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'models fetch failed'); return; }
      const ids = (j.data || []).map((m: any) => m.id);
      set(ids);
    } catch (e: any) { alert(`Cannot reach ${slot.baseUrl} — is the server running? ${e?.message}`); }
  }

  function compileSide(which: 'A' | 'B', code: string, repaired: boolean) {
    const canvas = which === 'A' ? cA.current! : cB.current!;
    const gl = canvas.getContext('webgl2');
    if (!gl) { (which === 'A' ? setLogA : setLogB)('WebGL2 not available'); return false; }
    if (which === 'A') glA.current = gl; else glB.current = gl;
    const r = compileProgram(gl, code);
    if (r.ok) {
      if (which === 'A') { progA.current = r.program; setOkA(repaired ? 'REPAIRED' : 'COMPILED'); setLogA(''); }
      else { progB.current = r.program; setOkB(repaired ? 'REPAIRED' : 'COMPILED'); setLogB(''); }
      return true;
    } else {
      if (which === 'A') { progA.current = null; setOkA('FAILED'); setLogA(r.log); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      else { progB.current = null; setOkB('FAILED'); setLogB(r.log); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      return false;
    }
  }

  async function forge() {
    setErr(''); setPhase('calling'); setProgress(15);
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const fullPrompt = `Write a GLSL fragment shader that renders ${prompt}.\n${CONTRACT}`;
    try {
      const r = await fetch('/api/forge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: fullPrompt, slotA, slotB, temperature, maxTokens, disableThinkingA: disA, disableThinkingB: disB, nonce }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'forge failed');
      setProgress(70); setPhase('compiling');
      setResA(j.a); setResB(j.b);
      const aOk = compileSide('A', j.a.extractedGlsl, false);
      const bOk = compileSide('B', j.b.extractedGlsl, false);
      setHist(h => [{ prompt, modelA: slotA.model, modelB: slotB.model, aOk, bOk, at: new Date().toLocaleTimeString() }, ...h].slice(0, 30));
      setPhase(aOk && bOk ? 'rendering' : 'failed');
      setProgress(100);
    } catch (e: any) { setErr(e.message); setPhase('failed'); }
  }

  async function repair(which: 'A' | 'B') {
    const slot = which === 'A' ? slotA : slotB;
    const glsl = which === 'A' ? resA?.extractedGlsl : resB?.extractedGlsl;
    const errorLog = which === 'A' ? logA : logB;
    if (!glsl || !errorLog) return;
    setPhase('calling'); setProgress(30);
    try {
      const r = await fetch('/api/repair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ glsl, errorLog, slot, temperature, maxTokens }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      if (which === 'A') setResA(j); else setResB(j);
      const ok = compileSide(which, j.extractedGlsl, true);
      setPhase(ok ? 'rendering' : 'failed'); setProgress(100);
    } catch (e: any) { setErr(e.message); setPhase('failed'); }
  }

  async function repairBox() {
    if (!repairGlsl) return;
    // compile the pasted broken shader on slot A context to surface verbatim log
    const canvas = cA.current!;
    const gl = canvas.getContext('webgl2')!; glA.current = gl;
    const r = compileProgram(gl, repairGlsl);
    if (!r.ok) { progA.current = null; setOkA('FAILED'); setLogA(r.log); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  }

  function download(canvas: HTMLCanvasElement | null, name: string) {
    if (!canvas) return;
    const a = document.createElement('a'); a.download = name; a.href = canvas.toDataURL('image/png'); a.click();
  }
  function downloadBoth() {
    const out = document.createElement('canvas'); out.width = 1080; out.height = 1080;
    const ctx = out.getContext('2d')!; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1080, 1080);
    const draw = (src: HTMLCanvasElement | null, x: number, label: string) => {
      if (src) ctx.drawImage(src, x, 140, 520, 520);
      ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif'; ctx.fillText(label, x + 10, 100);
    };
    draw(cA.current, 10, `A: ${slotA.model}`);
    draw(cB.current, 550, `B: ${slotB.model}`);
    ctx.font = '24px sans-serif'; ctx.fillText(`Refract — "${prompt}"`, 10, 740);
    const a = document.createElement('a'); a.download = 'refract-share.png'; a.href = out.toDataURL('image/png'); a.click();
  }
  function copyJSON() {
    navigator.clipboard.writeText(JSON.stringify({ prompt, slotA: { ...slotA, apiKey: '[redacted]' }, slotB: { ...slotB, apiKey: '[redacted]' }, resA, resB, logA, logB }, null, 2));
  }

  const slotUI = (s: Slot, set: (x: Slot) => void, models: string[], setModels: (m: string[]) => void, tag: string, dis: boolean, setDis: (b: boolean) => void, canThink: boolean, reasoning: number | null | undefined) => (
    <div className="slot">
      <h3>Slot {tag}</h3>
      <label>Provider preset</label>
      <select value={s.provider} onChange={e => { const p = e.target.value; set({ ...s, provider: p, baseUrl: PROVIDERS[p].base || s.baseUrl }); }}>
        {Object.keys(PROVIDERS).map(k => <option key={k} value={k}>{k}</option>)}
      </select>
      <label>Base URL</label>
      <input value={s.baseUrl} onChange={e => set({ ...s, baseUrl: e.target.value })} placeholder="https://..." />
      <label>API Key {(PROVIDERS[s.provider]?.needsKey) ? '(required)' : '(not needed for local)'}</label>
      <input type="password" value={s.apiKey} onChange={e => set({ ...s, apiKey: e.target.value })} placeholder="paste key — never committed" />
      <label>Model name (typeable; /models never gates a run)</label>
      <input value={s.model} onChange={e => set({ ...s, model: e.target.value })} list={`dl-${tag}`} />
      <datalist id={`dl-${tag}`}>{[...PROVIDERS[s.provider]?.builtins || [], ...models].map(m => <option key={m} value={m} />)}</datalist>
      <div className="toolbar">
        <button className="ghost" onClick={() => fetchModels(s, setModels)}>Refresh models</button>
        <small className="hint">{models.length ? `${models.length} live models` : 'manual entry always allowed'}</small>
      </div>
      <label><input type="checkbox" checked={dis} disabled={!canThink} onChange={e => setDis(e.target.checked)} /> Disable reasoning {canThink ? '' : '(only Particle deepseek-*)'} </label>
      <div className="meta">reasoning tokens: {reasoning === null || reasoning === undefined ? 'n/a' : reasoning}</div>
    </div>
  );

  const thinkA = slotA.provider === 'particle' && slotA.model.startsWith('deepseek-');
  const thinkB = slotB.provider === 'particle' && slotB.model.startsWith('deepseek-');

  return (
    <>
      <header><h1>REFRACT <span>// shader showdown</span></h1><small className="hint">Identical prompt → both models → live WebGL2. One side alive, one side black with a compile error.</small></header>
      <main>
        <div className="slots">
          {slotUI(slotA, setSlotA, modelsA, setModelsA, 'A', disA, setDisA, thinkA, resA?.reasoningTokens)}
          {slotUI(slotB, setSlotB, modelsB, setModelsB, 'B', disB, setDisB, thinkB, resB?.reasoningTokens)}
        </div>
        <div className="toolbar">
          <label>Temperature <input type="number" value={temperature} min={0} max={2} step={0.1} onChange={e => setTemperature(Number(e.target.value))} style={{ width: 70 }} /></label>
          <label>Max Tokens <input type="number" value={maxTokens} min={100} max={4000} step={50} onChange={e => setMaxTokens(Number(e.target.value))} style={{ width: 90 }} /></label>
          <small className="hint">Reasoning models need ≥900 budget; empty 200s auto-retry at 2× (cap 4000).</small>
        </div>
        <div className="promptrow">
          <input value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe a scene…" />
          <button onClick={forge} disabled={phase === 'calling'}>FORGE both</button>
        </div>
        <div className="presets">{PRESETS.map(p => <button key={p} className="ghost" onClick={() => setPrompt(p)}>{p}</button>)}</div>
        <div className="progress"><div style={{ width: `${progress}%` }} /></div>
        <div className="meta">state: {phase}{err ? ` — ${err}` : ''}</div>

        <div className="stages">
          {([['A', resA, okA, logA, slotA], ['B', resB, okB, logB, slotB]] as const).map(([tag, res, ok, log, slot]) => (
            <div className="stage" key={tag}>
              <div className="toolbar"><strong>Slot {tag}: {slot.model}</strong><span className={`badge ${ok}`}>{ok}</span>
                <span className="meta">{res ? `${new Blob([res.extractedGlsl]).size} bytes · sha ${res.sha256.slice(0, 10)} · {res.latencyMs}ms`.replace('{res.latencyMs}', String(res.latencyMs)) : ''}</span></div>
              <canvas ref={tag === 'A' ? cA : cB} className="shader" />
              {res && <div className="meta">prompt {res.promptTokens ?? '?'} · completion {res.completionTokens ?? '?'} · reasoning {res.reasoningTokens ?? 'n/a'} · via {res.extractionPath}</div>}
              {log && <div className="err">{log}</div>}
              {res && <div className="raw">{res.extractedGlsl.slice(0, 1200)}</div>}
              <div className="toolbar">
                <button className="ghost" onClick={() => download(tag === 'A' ? cA.current : cB.current, `refract-${tag}.png`)}>Download PNG</button>
                {ok === 'FAILED' && <button onClick={() => repair(tag as 'A' | 'B')} style={{ background: '#c22525' }}>Repair with same model</button>}
              </div>
            </div>
          ))}
        </div>

        <div className="toolbar">
          <button className="ghost" onClick={downloadBoth}>Download both (1080×1080 share card)</button>
          <button className="ghost" onClick={copyJSON}>Copy results as JSON</button>
        </div>

        <h3>Deliberately broken shader → repair box</h3>
        <div className="promptrow">
          <input value={repairGlsl} onChange={e => setRepairGlsl(e.target.value)} placeholder="Paste broken GLSL here, then compile…" />
          <button className="ghost" onClick={repairBox}>Compile pasted shader</button>
          <button className="ghost" onClick={() => setRepairGlsl('precision highp float;\nvoid main(){ gl_FragColor = vec3(1.0); }')}>Fill broken example</button>
        </div>

        <div className="history"><h3>Run history</h3>
          <table><thead><tr><th>time</th><th>prompt</th><th>A</th><th>B</th><th>A✓</th><th>B✓</th></tr></thead>
            <tbody>{hist.map((h, i) => <tr key={i}><td>{h.at}</td><td>{h.prompt}</td><td>{h.modelA}</td><td>{h.modelB}</td><td>{h.aOk ? '✓' : '✗'}</td><td>{h.bOk ? '✓' : '✗'}</td></tr>)}</tbody></table>
        </div>
        <footer className="footer">
          Built by <a href="https://harishkotra.me" target="_blank" rel="noreferrer">Harish Kotra</a>
          {' · '}Checkout my other builds at <a href="https://dailybuild.xyz" target="_blank" rel="noreferrer">dailybuild.xyz</a>
        </footer>
      </main>
    </>
  );
}
