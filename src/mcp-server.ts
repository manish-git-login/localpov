import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import path from 'path';
import fs from 'fs';
import os from 'os';
import { SessionManager } from './utils/session-manager';
import { BrowserCapture } from './collectors/browser-capture';
import { parse as parseBuildErrors } from './collectors/build-parser';
import { checkPorts, getProcessHealth, checkEnv, checkEnvFile, tailLog } from './utils/system-info';
import { isDockerAvailable, listContainers, getContainerLogs, dockerSummary } from './collectors/docker-watcher';

const pkg: { version: string } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// ── Instances ──
const sessions = new SessionManager();
const browser = new BrowserCapture();

// ── Output size safety ──
const MAX_OUTPUT_BYTES = 50 * 1024;

function truncate(text: string, maxBytes: number = MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid)) <= maxBytes - 100) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '\n\n[... output truncated. Use offset/limit params to paginate.]';
}

function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text: truncate(text) }] };
}

function errorResult(msg: string): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: String(msg) }], isError: true };
}

// ── MCP Server ──
const server = new McpServer({
  name: 'localpov',
  version: pkg.version,
});

// ────────────────────────────────────────────────────────────
// TOOL: get_diagnostics
// ────────────────────────────────────────────────────────────
server.registerTool('get_diagnostics', {
  title: 'Development Environment Health Check',
  description: 'Complete development environment health check. Call this FIRST to understand what is happening. Returns terminal errors, browser console errors, network failures, port status, and process health in a single response.',
  inputSchema: z.object({}),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
  const termDiag = sessions.getDiagnostics();
  browser.loadFromDisk();
  const browserSummary = browser.getSummary();
  const ports = await checkPorts();
  const health = getProcessHealth();
  const docker = dockerSummary();

  const parts: string[] = [];
  if (termDiag.errors.total > 0) parts.push(`${termDiag.errors.total} terminal error(s)`);
  if (browserSummary.console.errors > 0) parts.push(`${browserSummary.console.errors} browser console error(s)`);
  if (browserSummary.console.warnings > 0) parts.push(`${browserSummary.console.warnings} browser warning(s)`);
  if (browserSummary.network.failed > 0) parts.push(`${browserSummary.network.failed} failed network request(s)`);
  if (browserSummary.network.slow > 0) parts.push(`${browserSummary.network.slow} slow request(s)`);
  if (ports.down.length > 0) parts.push(`ports down: ${ports.down.join(', ')}`);
  if (parts.length === 0) parts.push('All clear — no errors detected');

  return textResult({
    summary: parts.join('. ') + '.',
    terminal: {
      activeSessions: termDiag.sessions.active,
      totalSessions: termDiag.sessions.total,
      errors: termDiag.errors.items.slice(0, 10),
      crashed: termDiag.crashed,
    },
    browser: browserSummary,
    ports: { up: ports.up, down: ports.down },
    docker: { available: docker.available, running: docker.running || 0 },
    system: {
      memory: health.system.memoryUsage,
      load: health.system.loadAvg,
    },
  });
});

// ────────────────────────────────────────────────────────────
// TOOL: list_sessions
// ────────────────────────────────────────────────────────────
server.registerTool('list_sessions', {
  title: 'List Terminal Sessions',
  description: 'List all captured terminal sessions. Shows PIDs, shells, working directories, and alive/dead status. Use a PID with read_terminal to see output.',
  inputSchema: z.object({}),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
  return textResult(sessions.listSessions());
});

// ────────────────────────────────────────────────────────────
// TOOL: read_terminal
// ────────────────────────────────────────────────────────────
server.registerTool('read_terminal', {
  title: 'Read Terminal Output',
  description: 'Read the last N lines of a terminal session. Use list_sessions first to get PIDs. Output is capped at 50KB — use offset to paginate large sessions.',
  inputSchema: z.object({
    pid: z.coerce.number().describe('Process ID of the terminal session'),
    lines: z.coerce.number().optional().default(100).describe('Number of lines to read (default: 100, max: 500)'),
    offset: z.coerce.number().optional().default(0).describe('Skip this many lines from end before reading (for pagination)'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ pid, lines, offset }: { pid: number; lines: number; offset: number }) => {
  const cappedLines = Math.min(lines || 100, 500);
  const result = sessions.readSession(pid, { lines: cappedLines + (offset || 0) });
  if (result.error) return errorResult(result.error);

  const outputLines = offset > 0
    ? result.lines.slice(0, -offset || undefined)
    : result.lines;

  return textResult({
    pid: result.pid,
    lineCount: outputLines.length,
    output: outputLines.join('\n'),
    recentCommands: result.commands.slice(-5),
    hasMore: result.lineCount >= cappedLines + (offset || 0),
  });
});

// ────────────────────────────────────────────────────────────
// TOOL: read_command
// ────────────────────────────────────────────────────────────
server.registerTool('read_command', {
  title: 'Read Command Output',
  description: 'Read the output of a specific command from a terminal session. Use index -1 for the last command, -2 for second-to-last, etc.',
  inputSchema: z.object({
    pid: z.coerce.number().describe('Process ID of the terminal session'),
    index: z.coerce.number().optional().default(-1).describe('Command index (0=first, -1=last, -2=second-to-last)'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ pid, index }: { pid: number; index: number }) => {
  const result = sessions.readCommand(pid, index);
  if (result.error) return errorResult(result.error);
  return textResult(result);
});

// ────────────────────────────────────────────────────────────
// TOOL: get_errors
// ────────────────────────────────────────────────────────────
server.registerTool('get_errors', {
  title: 'Find Terminal Errors',
  description: 'Find errors across all captured terminal sessions. Detects JS, TS, Python, Rust, Go, and generic error patterns. Returns up to 20 most recent errors.',
  inputSchema: z.object({
    since: z.coerce.number().optional().describe('Only errors after this Unix timestamp in milliseconds'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ since }: { since?: number }) => {
  const errors = sessions.getErrors({ since });
  return textResult({ total: errors.length, errors: errors.slice(0, 20) });
});

// ────────────────────────────────────────────────────────────
// TOOL: search_all
// ────────────────────────────────────────────────────────────
server.registerTool('search_all', {
  title: 'Search Terminal Sessions',
  description: 'Search for a regex pattern across all captured terminal sessions. Returns matching lines with context.',
  inputSchema: z.object({
    pattern: z.string().max(200).describe('Regex pattern to search for (max 200 chars)'),
    max_results: z.coerce.number().optional().default(20).describe('Maximum results to return (default: 20, max: 50)'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async ({ pattern, max_results }: { pattern: string; max_results: number }) => {
  const capped = Math.min(max_results || 20, 50);
  const result = sessions.searchAll(pattern, { maxResults: capped });
  if (result.error) return errorResult(result.error);
  return textResult(result);
});

// ────────────────────────────────────────────────────────────
// TOOL: read_browser
// ────────────────────────────────────────────────────────────
server.registerTool('read_browser', {
  title: 'Read Browser Console & Network',
  description: 'Read browser console logs and/or network requests captured via LocalPOV proxy injection. Requires `localpov` proxy running with a browser connected. Set source to "console" for JS errors/warnings, "network" for HTTP requests, or "all" for both.',
  inputSchema: z.object({
    source: z.enum(['console', 'network', 'all']).optional().default('all')
      .describe('What to read: "console" (JS errors/logs), "network" (HTTP requests), or "all"'),
    level: z.enum(['error', 'warn', 'log', 'info', 'debug', 'all']).optional().default('all')
      .describe('Console log level filter (only applies when source includes console)'),
    errors_only: z.boolean().optional().default(false)
      .describe('Network: only show failed requests (4xx/5xx)'),
    limit: z.coerce.number().optional().default(50)
      .describe('Max entries per source (default: 50, max: 200)'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ source, level, errors_only, limit }: { source: string; level: string; errors_only: boolean; limit: number }) => {
  browser.loadFromDisk();
  const cappedLimit = Math.min(limit || 50, 200);
  const result: Record<string, unknown> = {};

  if (source === 'console' || source === 'all') {
    const options: { limit: number; level?: string[] } = { limit: cappedLimit };
    if (level !== 'all') {
      options.level = level === 'error' ? ['error'] : level === 'warn' ? ['error', 'warn'] : [level];
    }
    result.console = browser.getConsoleEntries(options);
  }

  if (source === 'network' || source === 'all') {
    result.network = browser.getNetworkEntries({ errorsOnly: errors_only, limit: cappedLimit });
  }

  return textResult(result);
});

// ────────────────────────────────────────────────────────────
// TOOL: take_screenshot
// ────────────────────────────────────────────────────────────
server.registerTool('take_screenshot', {
  title: 'Browser Screenshot',
  description: 'Get a screenshot of the browser viewport. Returns the most recent screenshot captured via LocalPOV proxy. Requires proxy running and a browser connected.',
  inputSchema: z.object({}),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async () => {
  browser.loadFromDisk();
  const existing = browser.getScreenshot();
  if (existing && existing.age < 30000) {
    return {
      content: [{
        type: 'image' as const,
        data: existing.data.replace(/^data:image\/\w+;base64,/, ''),
        mimeType: 'image/jpeg',
      }],
    };
  }
  return errorResult('No recent screenshot available. Ensure LocalPOV proxy is running (`localpov --port 3000`) and a browser is open.');
});

// ────────────────────────────────────────────────────────────
// TOOL: get_build_errors
// ────────────────────────────────────────────────────────────
server.registerTool('get_build_errors', {
  title: 'Structured Build Errors',
  description: 'Parse structured build errors from terminal sessions. Returns {file, line, col, message} for each error. Supports TypeScript, ESLint, Webpack, Vite, Rust, Go, Python.',
  inputSchema: z.object({
    pid: z.coerce.number().optional().describe('Specific session PID (omit to scan all active sessions)'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ pid }: { pid?: number }) => {
  let text = '';
  if (pid) {
    const result = sessions.readSession(pid, { lines: 500 });
    if (result.error) return errorResult(result.error);
    text = result.lines.join('\n');
  } else {
    const list = sessions.listSessions().filter(s => s.alive);
    for (const s of list) {
      const result = sessions.readSession(s.pid, { lines: 200 });
      if (!result.error) text += result.lines.join('\n') + '\n';
    }
  }
  const errors = parseBuildErrors(text);
  return textResult({ total: errors.length, errors: errors.slice(0, 30) });
});

// ────────────────────────────────────────────────────────────
// TOOL: docker
// ────────────────────────────────────────────────────────────
server.registerTool('docker', {
  title: 'Docker Containers & Logs',
  description: 'List running Docker containers or read container logs. Omit "container" param to list all containers. Provide "container" to read its logs.',
  inputSchema: z.object({
    container: z.string().optional().describe('Container name or ID to read logs from. Omit to list all containers.'),
    tail: z.coerce.number().optional().default(100).describe('Number of log lines from end (default: 100, max: 500)'),
    since: z.string().optional().describe('Show logs since (e.g. "10m", "1h")'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ container, tail, since }: { container?: string; tail: number; since?: string }) => {
  if (!container) {
    return textResult(dockerSummary());
  }
  const cappedTail = Math.min(tail || 100, 500);
  const result = getContainerLogs(container, { tail: cappedTail, since });
  if (result.error) return errorResult(result.error);
  return textResult(result);
});

// ────────────────────────────────────────────────────────────
// TOOL: tail_log
// ────────────────────────────────────────────────────────────
server.registerTool('tail_log', {
  title: 'Read Log File',
  description: 'Read the last N lines of a log file. Restricted to files under: current working directory, ~/.localpov/, /var/log/, /tmp/. Blocks sensitive files (.ssh, .env, credentials).',
  inputSchema: z.object({
    path: z.string().describe('Absolute path to the log file'),
    lines: z.coerce.number().optional().default(100).describe('Number of lines from end (default: 100, max: 500)'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ path: filePath, lines }: { path: string; lines: number }) => {
  const resolved = path.resolve(filePath);
  const normalizedLower = resolved.toLowerCase().replace(/\\/g, '/');

  const BLOCKED = ['.ssh', '.gnupg', '.aws', '/etc/shadow', '/etc/passwd', 'credentials', 'secret', '.env'];
  const isSensitive = BLOCKED.some(p => {
    if (p === '.env') return normalizedLower.includes(p) && !normalizedLower.endsWith('.env.example');
    return normalizedLower.includes(p);
  });
  if (isSensitive) return errorResult(`Blocked: '${filePath}' contains sensitive data and cannot be read.`);

  const homeDir = os.homedir();
  const allowed = [
    path.resolve(process.cwd()),
    path.resolve(path.join(homeDir, '.localpov')),
    '/var/log',
    '/tmp',
  ];
  if (!allowed.some(prefix => resolved.startsWith(prefix + path.sep) || resolved === prefix)) {
    return errorResult(`Blocked: '${filePath}' is outside allowed directories (cwd, ~/.localpov/, /var/log/, /tmp/).`);
  }

  const cappedLines = Math.min(lines || 100, 500);
  const result = tailLog(resolved, cappedLines);
  if (result.error) return errorResult(result.error);
  return textResult({
    file: result.file,
    lineCount: result.lineCount,
    size: result.size,
    output: result.lines.join('\n'),
  });
});

// ────────────────────────────────────────────────────────────
// TOOL: check_ports
// ────────────────────────────────────────────────────────────
server.registerTool('check_ports', {
  title: 'Check Localhost Ports',
  description: 'Check which ports are listening on localhost. Scans common dev ports (3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888) by default, or specify a custom list.',
  inputSchema: z.object({
    ports: z.array(z.coerce.number()).optional().describe('Specific ports to check (default: common dev ports)'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ ports }: { ports?: number[] }) => {
  return textResult(await checkPorts(ports));
});

// ────────────────────────────────────────────────────────────
// TOOL: check_env
// ────────────────────────────────────────────────────────────
server.registerTool('check_env', {
  title: 'Check Environment Variables',
  description: 'Check if environment variables are set. Returns ONLY existence (true/false), NEVER values — safe for secrets. Also detects .env files in the current directory.',
  inputSchema: z.object({
    keys: z.array(z.string()).optional().describe('Env var names to check (default: DATABASE_URL, API_KEY, NODE_ENV, PORT, etc.)'),
    check_files: z.boolean().optional().default(true).describe('Also check for .env files in current directory'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ keys, check_files }: { keys?: string[]; check_files: boolean }) => {
  const result: Record<string, unknown> = { variables: checkEnv(keys) };
  if (check_files) result.envFiles = checkEnvFile();
  return textResult(result);
});

// ────────────────────────────────────────────────────────────
// TOOL: process_health
// ────────────────────────────────────────────────────────────
server.registerTool('process_health', {
  title: 'System Resource Usage',
  description: 'Get system resource usage: total/free memory, CPU load averages, uptime, and platform info. Useful for detecting memory leaks or resource exhaustion during development.',
  inputSchema: z.object({}),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
  return textResult(getProcessHealth());
});

// ────────────────────────────────────────────────────────────
// Expose browser capture for proxy integration
// ────────────────────────────────────────────────────────────
(server as any).browserCapture = browser;

// ────────────────────────────────────────────────────────────
// Start
// ────────────────────────────────────────────────────────────
process.on('uncaughtException', (err: Error) => {
  process.stderr.write(`LocalPOV MCP uncaught exception: ${err.message}\n${err.stack || ''}\n`);
});
process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`LocalPOV MCP unhandled rejection: ${msg}\n`);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  sessions.cleanup();
}

main().catch((err: Error) => {
  process.stderr.write('LocalPOV MCP server failed to start: ' + err.message + '\n');
  process.exit(1);
});
