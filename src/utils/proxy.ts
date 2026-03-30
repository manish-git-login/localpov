import http from 'http';
import httpProxy from 'http-proxy';
import WebSocket from 'ws';
import path from 'path';
import fs from 'fs';
import os from 'os';
import zlib from 'zlib';
import { getInjectScript } from './inject';
import { TerminalCapture } from '../collectors/terminal';
import { BrowserCapture } from '../collectors/browser-capture';
import { SessionManager } from './session-manager';

const DASHBOARD_PREFIX = '/__localpov__';
const DASHBOARD_DIR = path.join(__dirname, '..', '..', 'dashboard');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const IFRAME_BLOCKED = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only'];

interface AppInfo {
  port: number;
  framework: string;
}

interface CreateServerOptions {
  targetPort: number;
  listenPort: number;
  getApps?: () => AppInfo[];
  onLog?: (level: string, message: string | number) => void;
  onReady?: (actualPort: number) => void;
  terminal?: TerminalCapture | null;
  browserCapture?: BrowserCapture | null;
  sessionManager?: SessionManager | null;
}

interface ProxyServer {
  server: http.Server;
  readonly currentTarget: number;
  setTarget(port: number): void;
  close(): void;
}

function parseCookies(str: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (str || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function getHeaderValue(value: string | string[] | undefined): string {
  if (!value) return '';
  return Array.isArray(value) ? value.join(', ') : value;
}

function decodeBody(buffer: Buffer, contentEncoding: string): Buffer {
  const encoding = contentEncoding.trim().toLowerCase();
  if (!encoding || encoding === 'identity') return buffer;
  if (encoding.includes('br')) return zlib.brotliDecompressSync(buffer);
  if (encoding.includes('gzip')) return zlib.gunzipSync(buffer);
  if (encoding.includes('deflate')) return zlib.inflateSync(buffer);
  throw new Error(`Unsupported content-encoding: ${contentEncoding}`);
}

export function createServer({ targetPort, listenPort, getApps, onLog, onReady, terminal, browserCapture, sessionManager }: CreateServerOptions): ProxyServer {
  let defaultTarget = targetPort;

  // Clear stale browser data from previous sessions
  if (browserCapture) browserCapture.clear();

  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: true });

  proxy.on('proxyReq', (proxyReq: http.ClientRequest) => {
    // Ask upstream for uncompressed HTML when possible to avoid decode/encode mismatch.
    proxyReq.setHeader('accept-encoding', 'identity');
  });

  const injectSnippet = getInjectScript();

  proxy.on('proxyRes', (proxyRes: http.IncomingMessage, req: http.IncomingMessage, res: http.ServerResponse) => {
    for (const h of IFRAME_BLOCKED) delete proxyRes.headers[h];

    const ct = getHeaderValue(proxyRes.headers['content-type']);
    if (!ct.includes('text/html')) return;

    const origWrite = res.write;
    const origEnd = res.end;
    const chunks: Buffer[] = [];

    const contentEncoding = getHeaderValue(proxyRes.headers['content-encoding']);

    delete proxyRes.headers['content-length'];
    delete proxyRes.headers['content-encoding'];

    res.write = function(chunk: unknown, encoding?: BufferEncoding): boolean {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else chunks.push(Buffer.from(String(chunk), encoding));
      return true;
    } as typeof res.write;

    res.end = function(chunk?: unknown, encoding?: BufferEncoding): http.ServerResponse {
      if (chunk) {
        if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        else chunks.push(Buffer.from(String(chunk), encoding));
      }

      let decoded = Buffer.from(Buffer.concat(chunks));
      try {
        decoded = Buffer.from(decodeBody(decoded, contentEncoding));
      } catch (e: unknown) {
        const eMsg = e instanceof Error ? e.message : String(e);
        if (onLog) onLog('warn', `HTML decode skipped: ${eMsg}`);
        (origEnd as Function).call(res, Buffer.concat(chunks));
        return res;
      }

      let body = decoded.toString('utf8');

      if (body.includes('</head>')) {
        body = body.replace('</head>', injectSnippet + '</head>');
      } else if (body.includes('</body>')) {
        body = body.replace('</body>', injectSnippet + '</body>');
      } else if (body.includes('<html') || body.includes('<!DOCTYPE') || body.includes('<!doctype')) {
        body += injectSnippet;
      }

      origWrite.call(res, body, 'utf8');
      (origEnd as Function).call(res);
      return res;
    } as typeof res.end;
  });

  let _lastProxyError = '';
  let _lastProxyErrorTime = 0;
  proxy.on('error', (err: Error, req: http.IncomingMessage, res: http.ServerResponse | import('net').Socket) => {
    // Suppress repeated identical errors (e.g. ECONNREFUSED spam when target is down)
    const now = Date.now();
    if (err.message === _lastProxyError && now - _lastProxyErrorTime < 5000) {
      // Skip logging, still serve error page
    } else {
      _lastProxyError = err.message;
      _lastProxyErrorTime = now;
      if (onLog) onLog('error', `Proxy error: ${err.message}`);
    }
    if (res && 'writeHead' in res && !('headersSent' in res && (res as http.ServerResponse).headersSent)) {
      (res as http.ServerResponse).writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      (res as http.ServerResponse).end(errorPage(defaultTarget));
    }
  });

  function resolvePort(req: http.IncomingMessage): number {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    const cookies = parseCookies(req.headers.cookie);

    const _port = urlObj.searchParams.get('_port');
    if (_port) {
      const p = parseInt(_port, 10);
      if (p > 0 && p < 65536) return p;
    }

    if (cookies.lpov_port) {
      const p = parseInt(cookies.lpov_port, 10);
      if (p > 0 && p < 65536) return p;
    }

    return defaultTarget;
  }

  function setPortCookie(res: http.ServerResponse, port: number, extraHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = Object.assign({}, extraHeaders || {});
    headers['Set-Cookie'] = `lpov_port=${port}; Path=/; SameSite=Strict`;
    return headers;
  }

  const termClients = new Set<WebSocket>();
  const browserClients = new Set<WebSocket>();

  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url || '/', 'http://localhost');

    if (urlObj.pathname === '/__localpov__/api/apps') {
      const cookies = parseCookies(req.headers.cookie);
      const sessionPort = parseInt(cookies.lpov_port, 10) || defaultTarget;
      return json(res, { apps: getApps ? getApps() : [], currentTarget: sessionPort });
    }

    if (urlObj.pathname === '/__localpov__/api/switch') {
      const port = parseInt(urlObj.searchParams.get('port') || '', 10);
      if (port > 0 && port < 65536) {
        if (onLog) onLog('switch', port);
        res.writeHead(200, setPortCookie(res, port, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        }));
        return res.end(JSON.stringify({ ok: true, target: port }));
      }
      return json(res, { error: 'Invalid port' }, 400);
    }

    if (urlObj.pathname === '/__localpov__/api/ping') {
      return json(res, { ok: true, uptime: process.uptime() | 0 });
    }

    if (urlObj.pathname === '/__localpov__/api/sessions') {
      if (!sessionManager) return json(res, { sessions: [], errors: [] });
      const sessions = sessionManager.listSessions();
      const pidParam = urlObj.searchParams.get('pid');
      if (pidParam) {
        const pid = parseInt(pidParam, 10);
        const lines = parseInt(urlObj.searchParams.get('lines') || '50', 10);
        const result = sessionManager.readSession(pid, { lines });
        return json(res, result);
      }
      return json(res, { sessions });
    }

    if (urlObj.pathname === '/__localpov__/api/sessions/errors') {
      if (!sessionManager) return json(res, { errors: [] });
      const errors = sessionManager.getErrors({ maxPerSession: 10 });
      return json(res, { errors });
    }

    if (urlObj.pathname === '/__localpov__/api/terminal') {
      if (terminal) {
        return json(res, terminal.getStatus());
      }
      return json(res, { running: false, command: null });
    }

    if (urlObj.pathname === '/__localpov__/api/browser') {
      if (!browserCapture) return json(res, { console: [], network: [], summary: null });
      const source = urlObj.searchParams.get('source') || 'summary';
      if (source === 'console') {
        return json(res, { entries: browserCapture.getConsoleEntries({ limit: 100 }) });
      }
      if (source === 'network') {
        return json(res, { entries: browserCapture.getNetworkEntries({ limit: 100 }) });
      }
      return json(res, browserCapture.getSummary());
    }

    if (urlObj.pathname === '/__localpov__/api/health') {
      const mem = process.memoryUsage();
      return json(res, {
        memory: Math.round((1 - os.freemem() / os.totalmem()) * 100),
        heapMB: Math.round(mem.heapUsed / 1024 / 1024),
        uptime: Math.floor(process.uptime()),
        platform: process.platform,
        node: process.version,
        wsClients: { browser: browserClients.size, terminal: termClients.size },
      });
    }

    if (urlObj.pathname === '/__localpov__/api/debug') {
      if (process.env.NODE_ENV === 'production' && !process.env.LOCALPOV_DEBUG) {
        return json(res, { error: 'Not found' }, 404);
      }
      return json(res, {
        defaultTarget,
        dashboardReady: fs.existsSync(path.join(DASHBOARD_DIR, 'index.html')),
        platform: process.platform,
        nodeVersion: process.version,
        apps: getApps ? getApps() : [],
      });
    }

    if (urlObj.pathname.startsWith(DASHBOARD_PREFIX)) {
      return serveDashboard(urlObj.pathname, res);
    }

    // Serve an empty favicon to prevent 502 spam when target is down
    if (urlObj.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    const port = resolvePort(req);

    if (urlObj.searchParams.get('_port')) {
      const cleanUrl = (req.url || '/').replace(/[?&]_port=\d+/, '').replace(/\?$/, '') || '/';
      res.writeHead(302, setPortCookie(res, port, { Location: cleanUrl }));
      return res.end();
    }

    // No target server detected yet — serve a waiting page instead of proxying to nothing
    if (!port || port === 0) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>LocalPOV</title><meta http-equiv="refresh" content="3"><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0;flex-direction:column;gap:16px}code{background:#2a2a4a;padding:4px 12px;border-radius:4px;font-size:14px}.spin{animation:spin 1s linear infinite;display:inline-block}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="spin">&#9696;</div><h2>Waiting for dev server...</h2><p>Start your app (e.g. <code>npm run dev</code>) and this page will auto-refresh.</p><p style="opacity:0.5;font-size:13px">Dashboard: <a href="/__localpov__/" style="color:#7b9ef5">/__localpov__/</a></p></body></html>`);
    }

    proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
  });

  const termWss = new WebSocket.Server({ noServer: true });
  const MAX_WS_CLIENTS = 50;
  const browserWss = new WebSocket.Server({ noServer: true });

  if (terminal) {
    terminal.on('data', (data: { type: string; text: string; ts: number }) => {
      const msg = JSON.stringify({ type: 'data', stream: data.type, text: data.text, ts: data.ts });
      for (const ws of termClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    });
  }

  server.on('upgrade', (req: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    const upgradeUrl = new URL(req.url || '/', 'http://localhost');

    if (upgradeUrl.pathname === '/__localpov__/ws/browser') {
      if (browserClients.size >= MAX_WS_CLIENTS) {
        socket.write('HTTP/1.1 429 Too Many Connections\r\n\r\n');
        socket.destroy();
        return;
      }
      browserWss.handleUpgrade(req, socket, head, (ws) => {
        browserClients.add(ws);
        ws.on('message', (data: WebSocket.RawData) => {
          if (browserCapture) {
            try {
              const str = data.toString();
              if (str.length > 65536) return;
              browserCapture.handleMessage(str);
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              if (onLog) onLog('warn', `Browser WS message error: ${msg}`);
            }
          }
        });
        ws.on('close', () => {
          browserClients.delete(ws);
          // Clear stale browser data when last client disconnects
          if (browserClients.size === 0 && browserCapture) {
            browserCapture.clear();
          }
        });
        ws.on('error', (e: Error) => {
          if (onLog) onLog('warn', `Browser WS error: ${e.message}`);
          browserClients.delete(ws);
        });
      });
      return;
    }

    if (upgradeUrl.pathname === '/__localpov__/ws/terminal') {
      if (termClients.size >= MAX_WS_CLIENTS) {
        socket.write('HTTP/1.1 429 Too Many Connections\r\n\r\n');
        socket.destroy();
        return;
      }
      termWss.handleUpgrade(req, socket, head, (ws) => {
        termClients.add(ws);

        if (terminal) {
          const history = terminal.getBuffer();
          ws.send(JSON.stringify({ type: 'history', lines: history }));
        } else {
          ws.send(JSON.stringify({ type: 'status', running: false }));
        }

        ws.on('message', (data: WebSocket.RawData) => {
          if (!terminal || !terminal.interactive) return;
          try {
            const str = data.toString();
            if (str.length > 4096) return;
            const msg = JSON.parse(str);
            if (msg.type === 'input' && typeof msg.text === 'string') {
              terminal.write(msg.text.slice(0, 1024));
            }
          } catch (e: unknown) {
            const eMsg = e instanceof Error ? e.message : String(e);
            if (onLog) onLog('warn', `Terminal WS message error: ${eMsg}`);
          }
        });

        ws.on('close', () => termClients.delete(ws));
        ws.on('error', (e: Error) => {
          if (onLog) onLog('warn', `Terminal WS error: ${e.message}`);
          termClients.delete(ws);
        });
      });
      return;
    }

    if (req.url && req.url.startsWith(DASHBOARD_PREFIX)) return;

    const port = resolvePort(req);
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Try next port automatically
      listenPort++;
      if (listenPort > initialPort + 10) {
        if (onLog) onLog('error', `No available ports found (tried ${initialPort}-${listenPort - 1})`);
        return;
      }
      server.listen(listenPort, '0.0.0.0');
      return;
    }
    if (onLog) onLog('error', `Server error: ${err.message}`);
  });

  const initialPort = listenPort;
  server.listen(listenPort, '0.0.0.0', () => { if (onReady) onReady(listenPort); });

  function serveDashboard(pathname: string, res: http.ServerResponse): void {
    let filePath = pathname.replace(DASHBOARD_PREFIX, '') || '/';
    if (filePath === '' || filePath === '/') filePath = '/index.html';
    const fullPath = path.join(DASHBOARD_DIR, filePath);
    if (!fullPath.startsWith(DASHBOARD_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(fullPath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  function json(res: http.ServerResponse, data: unknown, status: number = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(data));
  }

  return {
    server,
    get currentTarget(): number { return defaultTarget; },
    setTarget(port: number): void { defaultTarget = port; },
    close(): void {
      for (const ws of browserClients) {
        try { ws.close(1001, 'Server shutting down'); } catch {}
      }
      for (const ws of termClients) {
        try { ws.close(1001, 'Server shutting down'); } catch {}
      }
      browserClients.clear();
      termClients.clear();
      server.close();
      proxy.close();
    },
  };
}

function errorPage(port: number): string {
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;box-sizing:border-box}body{font-family:system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.b{text-align:center;max-width:320px}h2{font-size:18px;margin-bottom:8px}p{font-size:14px;line-height:1.5;margin-bottom:6px;opacity:.7}
code{background:#f0f0f0;padding:2px 8px;border-radius:4px;font-size:13px}
button{margin-top:16px;padding:10px 28px;font-size:14px;border-radius:8px;border:1px solid #ddd;background:#fff;cursor:pointer;font-family:inherit}
@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#eee}code{background:#1a1a1a}button{background:#1a1a1a;border-color:#333;color:#ccc}}</style>
</head><body><div class="b"><h2>App not responding</h2><p><code>localhost:${port}</code></p><p>Is your dev server running?</p>
<button onclick="location.reload()">Retry</button><script>setTimeout(()=>location.reload(),5000)</script></div></body></html>`;
}
