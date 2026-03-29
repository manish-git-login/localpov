import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';

const MAX_CONSOLE_ENTRIES = 500;
const MAX_NETWORK_ENTRIES = 500;
const MAX_FILE_LINES = 1000;

export interface ConsoleEntry {
  level: string;
  message: string;
  stack: string | null;
  source: string | null;
  ts: number;
  url: string | null;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  statusText: string;
  duration: number;
  size: number;
  type: string;
  error: string | null;
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  ts: number;
}

interface ConsoleQueryOptions {
  level?: string | string[];
  since?: number;
  limit?: number;
}

interface NetworkQueryOptions {
  errorsOnly?: boolean;
  slowOnly?: boolean;
  slowThreshold?: number;
  since?: number;
  limit?: number;
}

interface ScreenshotData {
  data: string;
  ts: number;
  age: number;
}

interface BrowserSummary {
  console: {
    total: number;
    errors: number;
    warnings: number;
    recentErrors: Array<{
      message: string;
      source: string | null;
      ts: number;
    }>;
  };
  network: {
    total: number;
    failed: number;
    slow: number;
    recentErrors: Array<{
      method: string;
      url: string;
      status: number;
      error: string | null;
      ts: number;
    }>;
  };
  hasScreenshot: boolean;
  screenshotAge: number | null;
}

interface BrowserCaptureOptions {
  persistDir?: string;
}

interface IncomingMessage {
  type: string;
  level?: string;
  message?: string;
  stack?: string;
  source?: string;
  url?: string;
  ts?: number;
  method?: string;
  status?: number;
  statusText?: string;
  duration?: number;
  size?: number;
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  data?: string;
}

/**
 * Stores browser console logs and network requests received from
 * the injected client-side script via WebSocket.
 */
export class BrowserCapture extends EventEmitter {
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  private _screenshotData: string | null;
  private _screenshotTs: number;
  persistDir: string;
  private _consolePath: string;
  private _networkPath: string;
  private _screenshotPath: string;

  constructor(options: BrowserCaptureOptions = {}) {
    super();
    this.consoleEntries = [];
    this.networkEntries = [];
    this._screenshotData = null;
    this._screenshotTs = 0;

    this.persistDir = options.persistDir || path.join(os.homedir(), '.localpov', 'browser');
    this._consolePath = path.join(this.persistDir, 'console.jsonl');
    this._networkPath = path.join(this.persistDir, 'network.jsonl');
    this._screenshotPath = path.join(this.persistDir, 'screenshot.jpg');

    try {
      fs.mkdirSync(this.persistDir, { recursive: true });
    } catch {
      // ignore
    }

    this.cleanStale();
    this.loadFromDisk();
  }

  // ── Cleanup ──

  cleanStale(maxAgeMs: number = 4 * 60 * 60 * 1000): void {
    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    const now = Date.now();

    for (const filePath of [this._consolePath, this._networkPath]) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const stat = fs.statSync(filePath);

        if (now - stat.mtimeMs > maxAgeMs) {
          fs.writeFileSync(filePath, '', 'utf8');
          continue;
        }

        if (stat.size > MAX_FILE_SIZE) {
          const raw = fs.readFileSync(filePath, 'utf8');
          const lines = raw.split('\n').filter(l => l.trim());
          const trimmed = lines.slice(-500).join('\n') + '\n';
          fs.writeFileSync(filePath, trimmed, 'utf8');
        }
      } catch {
        // non-fatal
      }
    }

    try {
      if (fs.existsSync(this._screenshotPath)) {
        const stat = fs.statSync(this._screenshotPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(this._screenshotPath);
        }
      }
    } catch {}
  }

  // ── Persistence helpers ──

  private _appendLine(filePath: string, obj: unknown): void {
    try {
      fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
    } catch {
      // non-fatal
    }
  }

  private _readJsonl<T>(filePath: string): T[] {
    try {
      if (!fs.existsSync(filePath)) return [];
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());
      const trimmed = lines.slice(-MAX_FILE_LINES);
      const items: T[] = [];
      for (const line of trimmed) {
        try {
          items.push(JSON.parse(line) as T);
        } catch {
          // skip malformed lines
        }
      }
      return items;
    } catch {
      return [];
    }
  }

  loadFromDisk(): void {
    this.consoleEntries = this._readJsonl<ConsoleEntry>(this._consolePath);
    this.networkEntries = this._readJsonl<NetworkEntry>(this._networkPath);

    try {
      if (fs.existsSync(this._screenshotPath)) {
        const buf = fs.readFileSync(this._screenshotPath);
        if (buf.length > 0) {
          this._screenshotData = 'data:image/jpeg;base64,' + buf.toString('base64');
          const stat = fs.statSync(this._screenshotPath);
          this._screenshotTs = stat.mtimeMs;
        }
      }
    } catch {
      // non-fatal
    }
  }

  private _persistConsole(item: ConsoleEntry): void {
    this._appendLine(this._consolePath, item);
  }

  private _persistNetwork(item: NetworkEntry): void {
    this._appendLine(this._networkPath, item);
  }

  private _persistScreenshot(dataUrl: string): void {
    try {
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(this._screenshotPath, Buffer.from(base64, 'base64'));
    } catch {
      // non-fatal
    }
  }

  // ── Console ──

  addConsoleEntry(entry: Partial<ConsoleEntry>): ConsoleEntry {
    const item: ConsoleEntry = {
      level: entry.level || 'log',
      message: String(entry.message || '').slice(0, 2000),
      stack: entry.stack || null,
      source: entry.source || null,
      ts: entry.ts || Date.now(),
      url: entry.url || null,
    };
    this.consoleEntries.push(item);
    while (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
      this.consoleEntries.shift();
    }
    this._persistConsole(item);
    this.emit('console', item);
    return item;
  }

  getConsoleEntries(options: ConsoleQueryOptions = {}): ConsoleEntry[] {
    let entries = this.consoleEntries;

    if (options.level) {
      const levels = Array.isArray(options.level) ? options.level : [options.level];
      entries = entries.filter(e => levels.includes(e.level));
    }

    if (options.since) {
      entries = entries.filter(e => e.ts >= options.since!);
    }

    const limit = options.limit || 50;
    return entries.slice(-limit);
  }

  getConsoleErrors(limit: number = 20): ConsoleEntry[] {
    return this.getConsoleEntries({ level: ['error', 'warn'], limit });
  }

  // ── Network ──

  addNetworkEntry(entry: Partial<NetworkEntry>): NetworkEntry {
    const item: NetworkEntry = {
      method: entry.method || 'GET',
      url: String(entry.url || '').slice(0, 500),
      status: entry.status || 0,
      statusText: entry.statusText || '',
      duration: entry.duration || 0,
      size: entry.size || 0,
      type: entry.type || '',
      error: entry.error || null,
      requestHeaders: entry.requestHeaders || null,
      responseHeaders: entry.responseHeaders || null,
      responseBody: entry.responseBody ? String(entry.responseBody).slice(0, 5000) : null,
      ts: entry.ts || Date.now(),
    };
    this.networkEntries.push(item);
    while (this.networkEntries.length > MAX_NETWORK_ENTRIES) {
      this.networkEntries.shift();
    }
    this._persistNetwork(item);
    this.emit('network', item);
    return item;
  }

  getNetworkEntries(options: NetworkQueryOptions = {}): NetworkEntry[] {
    let entries = this.networkEntries;

    if (options.errorsOnly) {
      entries = entries.filter(e => e.status >= 400 || e.error);
    }

    if (options.slowOnly) {
      const threshold = options.slowThreshold || 1000;
      entries = entries.filter(e => e.duration >= threshold);
    }

    if (options.since) {
      entries = entries.filter(e => e.ts >= options.since!);
    }

    const limit = options.limit || 50;
    return entries.slice(-limit);
  }

  getNetworkErrors(limit: number = 20): NetworkEntry[] {
    return this.getNetworkEntries({ errorsOnly: true, limit });
  }

  // ── Screenshots ──

  setScreenshot(dataUrl: string): void {
    this._screenshotData = dataUrl;
    this._screenshotTs = Date.now();
    this._persistScreenshot(dataUrl);
    this.emit('screenshot', { ts: this._screenshotTs });
  }

  getScreenshot(): ScreenshotData | null {
    if (!this._screenshotData) return null;
    return {
      data: this._screenshotData,
      ts: this._screenshotTs,
      age: Date.now() - this._screenshotTs,
    };
  }

  // ── Summary ──

  getSummary(): BrowserSummary {
    const consoleErrors = this.consoleEntries.filter(e => e.level === 'error');
    const consoleWarns = this.consoleEntries.filter(e => e.level === 'warn');
    const networkErrors = this.networkEntries.filter(e => e.status >= 400 || e.error);
    const slowRequests = this.networkEntries.filter(e => e.duration >= 1000);

    return {
      console: {
        total: this.consoleEntries.length,
        errors: consoleErrors.length,
        warnings: consoleWarns.length,
        recentErrors: consoleErrors.slice(-5).map(e => ({
          message: e.message.slice(0, 200),
          source: e.source,
          ts: e.ts,
        })),
      },
      network: {
        total: this.networkEntries.length,
        failed: networkErrors.length,
        slow: slowRequests.length,
        recentErrors: networkErrors.slice(-5).map(e => ({
          method: e.method,
          url: e.url.slice(0, 100),
          status: e.status,
          error: e.error,
          ts: e.ts,
        })),
      },
      hasScreenshot: !!this._screenshotData,
      screenshotAge: this._screenshotData ? Date.now() - this._screenshotTs : null,
    };
  }

  // ── Handle incoming WebSocket message from injected script ──

  handleMessage(msg: string | IncomingMessage): ConsoleEntry | NetworkEntry | { ok: boolean } | null {
    let data: IncomingMessage;
    try {
      data = typeof msg === 'string' ? JSON.parse(msg) : msg;
    } catch {
      return null;
    }

    if (!data || typeof data !== 'object' || !data.type) return null;

    try {
      switch (data.type) {
        case 'console':
          return this.addConsoleEntry(data as Partial<ConsoleEntry>);
        case 'network':
          return this.addNetworkEntry(data as Partial<NetworkEntry>);
        case 'screenshot':
          if (typeof data.data !== 'string' || !data.data.startsWith('data:image/')) return null;
          this.setScreenshot(data.data);
          return { ok: true };
        case 'error':
          return this.addConsoleEntry({
            level: 'error',
            message: data.message || 'Unknown error',
            stack: data.stack || null,
            source: data.source || null,
            url: data.url || null,
            ts: data.ts || Date.now(),
          });
        default:
          return null;
      }
    } catch (e) {
      this.emit('error', e);
      return null;
    }
  }

  clear(): void {
    this.consoleEntries = [];
    this.networkEntries = [];
    this._screenshotData = null;
    this._screenshotTs = 0;

    try { fs.writeFileSync(this._consolePath, '', 'utf8'); } catch { /* ignore */ }
    try { fs.writeFileSync(this._networkPath, '', 'utf8'); } catch { /* ignore */ }
    try { fs.unlinkSync(this._screenshotPath); } catch { /* ignore */ }
  }
}
