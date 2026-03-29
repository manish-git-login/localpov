import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';

// ── Port checking ──

export function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(800);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

interface PortCheckResult {
  up: number[];
  down: number[];
}

export async function checkPorts(ports?: number[]): Promise<PortCheckResult> {
  if (!ports || ports.length === 0) {
    ports = [3000, 3001, 4000, 4200, 5173, 5174, 8000, 8080, 8888, 5432, 6379, 27017];
  }
  const results = await Promise.all(
    ports.map(async (port) => ({
      port,
      listening: await checkPort(port),
    }))
  );
  return {
    up: results.filter(r => r.listening).map(r => r.port),
    down: results.filter(r => !r.listening).map(r => r.port),
  };
}

// ── Process health ──

interface ProcessHealth {
  node: {
    pid: number;
    uptime: number;
    memory: {
      rss: string;
      heapUsed: string;
      heapTotal: string;
      external: string;
    };
    version: string;
  };
  system: {
    platform: NodeJS.Platform;
    arch: string;
    cpus: number;
    totalMemory: string;
    freeMemory: string;
    memoryUsage: string;
    loadAvg: string[];
    uptime: number;
  };
}

export function getProcessHealth(): ProcessHealth {
  const mem = process.memoryUsage();
  const cpus = os.cpus();

  return {
    node: {
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
      memory: {
        rss: formatBytes(mem.rss),
        heapUsed: formatBytes(mem.heapUsed),
        heapTotal: formatBytes(mem.heapTotal),
        external: formatBytes(mem.external),
      },
      version: process.version,
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus.length,
      totalMemory: formatBytes(os.totalmem()),
      freeMemory: formatBytes(os.freemem()),
      memoryUsage: Math.round((1 - os.freemem() / os.totalmem()) * 100) + '%',
      loadAvg: os.loadavg().map(n => n.toFixed(2)),
      uptime: Math.floor(os.uptime()),
    },
  };
}

// ── Environment checking ──

interface EnvCheckResult {
  key: string;
  set: boolean;
}

export function checkEnv(keys?: string[]): EnvCheckResult[] {
  if (!keys || keys.length === 0) {
    keys = [
      'NODE_ENV', 'PORT', 'DATABASE_URL', 'REDIS_URL',
      'API_KEY', 'SECRET_KEY', 'JWT_SECRET',
      'AWS_ACCESS_KEY_ID', 'GOOGLE_APPLICATION_CREDENTIALS',
      'DOCKER_HOST', 'CI',
    ];
  }

  return keys.map(key => ({
    key,
    set: key in process.env,
  }));
}

interface EnvFileResult {
  file: string;
  exists: boolean;
  keys: string[];
}

export function checkEnvFile(dir?: string): EnvFileResult[] {
  const envFiles = ['.env', '.env.local', '.env.development', '.env.production'];
  const results: EnvFileResult[] = [];

  for (const file of envFiles) {
    const filePath = path.join(dir || process.cwd(), file);
    try {
      fs.accessSync(filePath, fs.constants.R_OK);
      const content = fs.readFileSync(filePath, 'utf8');
      const keys = content.split('\n')
        .filter(l => l.trim() && !l.startsWith('#'))
        .map(l => l.split('=')[0].trim())
        .filter(Boolean);
      results.push({ file, exists: true, keys });
    } catch {
      results.push({ file, exists: false, keys: [] });
    }
  }

  return results;
}

// ── Log file tailing ──

interface TailLogResult {
  file: string;
  lines: string[];
  lineCount?: number;
  size?: number;
  modified?: number;
  error?: string;
}

export function tailLog(filePath: string, lines: number = 100): TailLogResult {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { error: `${filePath} is not a file`, file: filePath, lines: [] };
    if (stat.size === 0) return { file: filePath, lines: [], size: 0 };

    const CHUNK = 16384;
    if (stat.size < CHUNK * 2) {
      const content = fs.readFileSync(filePath, 'utf8');
      const allLines = content.split('\n');
      return {
        file: filePath,
        lines: allLines.slice(-lines),
        lineCount: Math.min(lines, allLines.length),
        size: stat.size,
        modified: stat.mtimeMs,
      };
    }

    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: `Cannot open file: ${msg}`, file: filePath, lines: [] };
    }
    let pos = Math.max(0, stat.size - CHUNK);
    let text = '';
    let lineCount = 0;

    try {
      while (pos >= 0 && lineCount < lines) {
        const readSize = Math.min(CHUNK, stat.size - pos);
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, pos);
        text = buf.toString('utf8') + text;
        lineCount = text.split('\n').length;
        if (pos === 0) break;
        pos = Math.max(0, pos - CHUNK);
      }
    } finally {
      fs.closeSync(fd);
    }

    const allLines = text.split('\n').slice(-lines);
    return {
      file: filePath,
      lines: allLines,
      lineCount: allLines.length,
      size: stat.size,
      modified: stat.mtimeMs,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg, file: filePath, lines: [] };
  }
}

// ── Helpers ──

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
}
