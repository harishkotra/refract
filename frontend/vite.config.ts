import { defineConfig, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT_FILE = join(HERE, '..', '.backend-port');

function backendPort(): number {
  if (process.env.BACKEND_PORT && /^\d+$/.test(process.env.BACKEND_PORT)) return Number(process.env.BACKEND_PORT);
  try {
    if (existsSync(PORT_FILE)) {
      const p = readFileSync(PORT_FILE, 'utf8').trim();
      if (/^\d+$/.test(p)) return Number(p);
    }
  } catch { /* fall through */ }
  return Number(process.env.PORT || 3001);
}

// Dynamic /api forwarder: re-reads the backend port file on EVERY request,
// so it survives backend auto-bumping ports after vite already started.
function apiForwarder() {
  return {
    name: 'refract-api-forwarder',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api')) return next();
        const tryPorts = [backendPort()];
        for (let p = 3001; p < 3011; p++) if (!tryPorts.includes(p)) tryPorts.push(p);
        let chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          const body = Buffer.concat(chunks);
          let lastErr = '';
          for (const port of tryPorts) {
            try {
              const r = await fetch(`http://127.0.0.1:${port}${req.url}`, {
                method: req.method,
                headers: { 'Content-Type': 'application/json' },
                body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
              });
              const buf = Buffer.from(await r.arrayBuffer());
              res.statusCode = r.status;
              const ct = r.headers.get('content-type');
              if (ct) res.setHeader('content-type', ct);
              res.end(buf);
              return;
            } catch (e: any) {
              lastErr = e?.message || String(e);
              continue;
            }
          }
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: `Cannot reach backend (tried :${tryPorts[0]}). Is it running? ${lastErr}` }));
        });
      });
    },
  };
}

export default defineConfig({ plugins: [react(), apiForwarder()], server: { port: 5173 } });
