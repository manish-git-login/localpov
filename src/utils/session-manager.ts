import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

export const SESSION_DIR: string = path.join(os.homedir(), '.localpov', 'sessions');

function _readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}

const MARKER_RE = /\x1b\]localpov;([^;]+);([^;]*);(\d+)\x07/g;

interface ErrorPattern {
  re: RegExp;
  lang: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  { re: /(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|URIError):\s*.+/, lang: 'js' },
  { re: /at\s+.+\(.+:\d+:\d+\)/, lang: 'js' },
  { re: /ENOENT|EACCES|EADDRINUSE|ECONNREFUSED|ECONNRESET/, lang: 'node' },
  { re: /UnhandledPromiseRejection/, lang: 'node' },
  { re: /error TS\d+:/, lang: 'ts' },
  { re: /\.tsx?\(\d+,\d+\):\s*error/, lang: 'ts' },
  { re: /ERROR\s+in\s+/, lang: 'build' },
  { re: /Module not found/, lang: 'build' },
  { re: /Cannot find module/, lang: 'build' },
  { re: /Failed to compile/, lang: 'build' },
  { re: /Build failed/, lang: 'build' },
  { re: /Traceback \(most recent call last\)/, lang: 'python' },
  { re: /^\s*\w+Error:/, lang: 'python' },
  { re: /^error\[E\d+\]:/, lang: 'rust' },
  { re: /^\.\/\w+\.go:\d+:\d+:/, lang: 'go' },
  { re: /cannot use .+ as .+ in/, lang: 'go' },
  { re: /\b(?:FATAL|CRITICAL|PANIC)\b/i, lang: 'generic' },
  { re: /npm ERR!/, lang: 'npm' },
  { re: /exited with code [1-9]/, lang: 'generic' },
  { re: /segmentation fault/i, lang: 'generic' },
  { re: /killed|OOM|out of memory/i, lang: 'generic' },
];

interface SessionInfo {
  pid: number;
  shell: string;
  cwd: string;
  started: number;
  user: string;
  term: string;
  alive: boolean;
  logSize: number;
  lastActivity: number;
  hasLog: boolean;
}

interface SessionReadResult {
  pid: number;
  lines: string[];
  lineCount: number;
  commands: ParsedCommand[];
  error?: string;
}

interface CommandReadResult {
  command?: string;
  exitCode?: number | null;
  started?: number;
  ended?: number | null;
  duration?: number | null;
  output?: string;
  running?: boolean;
  error?: string;
}

interface ReadSessionOptions {
  lines?: number;
  raw?: boolean;
}

interface ParsedCommand {
  command: string;
  started: number;
  exitCode: number | null;
  ended: number | null;
  output: string;
}

interface InternalCommand extends ParsedCommand {
  _lines?: string[];
}

interface SessionError {
  pid: number;
  alive: boolean;
  cwd: string;
  line: number;
  text: string;
  context: string;
  lang: string;
}

interface GetErrorsOptions {
  since?: number;
  maxPerSession?: number;
}

interface SearchOptions {
  maxResults?: number;
  ignoreCase?: boolean;
}

interface SearchResult {
  pid: number;
  alive: boolean;
  line: number;
  text: string;
  context: string;
}

interface SearchResponse {
  results?: SearchResult[];
  total?: number;
  pattern?: string;
  error?: string;
}

interface DiagnosticsResult {
  sessions: {
    active: number;
    dead: number;
    total: number;
  };
  errors: {
    total: number;
    items: SessionError[];
    bySession: Record<string, number>;
  };
  crashed: Array<{
    pid: number;
    cwd: string;
    shell: string;
    errors: SessionError[];
  }>;
  summary: string;
}

/**
 * Manages terminal session logs captured by shell integration.
 */
export class SessionManager extends EventEmitter {
  private _fileWatchers: Map<number, ReturnType<typeof setInterval>>;

  constructor() {
    super();
    this._fileWatchers = new Map();
  }

  listSessions(): SessionInfo[] {
    const sessions: SessionInfo[] = [];

    try {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    } catch {}

    let files: string[];
    try {
      files = fs.readdirSync(SESSION_DIR);
    } catch {
      return sessions;
    }

    for (const file of files) {
      if (!file.endsWith('.meta')) continue;

      const pid = parseInt(path.basename(file, '.meta'), 10);
      if (isNaN(pid)) continue;

      const metaPath = path.join(SESSION_DIR, file);
      const logPath = path.join(SESSION_DIR, `${pid}.log`);

      try {
        const raw = fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, '');
        const meta = JSON.parse(raw);
        const alive = _isProcessAlive(pid);

        let logSize = 0;
        let lastActivity = meta.started * 1000 || 0;
        let hasLog = false;

        try {
          const stat = fs.statSync(logPath);
          logSize = stat.size;
          lastActivity = stat.mtimeMs;
          hasLog = true;
        } catch {}

        sessions.push({
          pid,
          shell: meta.shell || 'unknown',
          cwd: meta.cwd || '',
          started: meta.started || 0,
          user: meta.user || '',
          term: meta.term || '',
          alive,
          logSize,
          lastActivity,
          hasLog,
        });
      } catch {
        // Corrupt meta file — skip
      }
    }

    sessions.sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return b.lastActivity - a.lastActivity;
    });

    return sessions;
  }

  readSession(pid: number, options: ReadSessionOptions = {}): SessionReadResult {
    const lines = options.lines || 100;
    const raw = !!options.raw;
    const logPath = path.join(SESSION_DIR, `${pid}.log`);

    if (!fs.existsSync(logPath)) {
      return { error: 'Session log not found', pid, lines: [], lineCount: 0, commands: [] };
    }

    const content = _tailFile(logPath, lines + 20);
    const commands = _parseMarkers(content);

    let display = content;
    if (!raw) {
      display = _stripAnsi(display);
      display = display.replace(/\x1b\]localpov;[^\x07]*\x07/g, '');
    }

    display = display
      .replace(/^Script started.*\n/m, '')
      .replace(/\nScript done.*$/m, '');

    const psNoisePatterns: RegExp[] = [
      /^\*{4,}$/,
      /^Windows PowerShell transcript/,
      /^(Start|End) time:/,
      /^Username:/,
      /^RunAs User:/,
      /^Configuration Name:/,
      /^Machine:/,
      /^Host Application:/,
      /^Process ID:/,
      /^PSVersion:/,
      /^PSEdition:/,
      /^PSCompatibleVersions:/,
      /^BuildVersion:/,
      /^CLRVersion:/,
      /^WSManStackVersion:/,
      /^PSRemotingProtocolVersion:/,
      /^SerializationVersion:/,
    ];
    display = display.split('\n')
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        return !psNoisePatterns.some(p => p.test(trimmed));
      })
      .join('\n');
    // Strip VS Code shell integration markers (]633;...) — they appear inline
    display = display.replace(/\]633;[^\x07\n]*(\x07)?/g, '');
    // Clean PS> transcript command echo prefix → show as bare command
    display = display.replace(/^PS>/gm, '> ');
    // Clean leftover prompt fragments like "PS C:\path\here> " on otherwise empty lines
    display = display.replace(/^PS [A-Z]:\\[^>]*>\s*$/gm, '');
    // Collapse 3+ consecutive blank lines into 1
    display = display.replace(/\n{3,}/g, '\n\n');

    const outputLines = display.split('\n').slice(-lines);

    return {
      pid,
      lines: outputLines,
      lineCount: outputLines.length,
      commands: commands.slice(-20),
    };
  }

  readCommand(pid: number, commandIndex: number): CommandReadResult {
    const logPath = path.join(SESSION_DIR, `${pid}.log`);
    if (!fs.existsSync(logPath)) return { error: 'Session not found' };

    const content = _readFile(logPath);
    const commands = _parseMarkers(content);

    if (commands.length === 0) return { error: 'No commands found in session' };

    if (commandIndex < 0) commandIndex = commands.length + commandIndex;
    if (commandIndex < 0 || commandIndex >= commands.length) {
      return { error: `Command index out of range (0 to ${commands.length - 1}, or -1 for last)` };
    }

    const cmd = commands[commandIndex];
    return {
      command: cmd.command,
      exitCode: cmd.exitCode,
      started: cmd.started,
      ended: cmd.ended,
      duration: cmd.ended && cmd.started ? cmd.ended - cmd.started : null,
      output: _stripAnsi(cmd.output),
      running: cmd.exitCode === null,
    };
  }

  readLastCommand(pid: number): CommandReadResult {
    return this.readCommand(pid, -1);
  }

  searchAll(pattern: string, options: SearchOptions = {}): SearchResponse {
    const maxResults = options.maxResults || 20;
    const ignoreCase = options.ignoreCase !== false;
    const results: SearchResult[] = [];

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: `Invalid regex: ${msg}` };
    }

    const sessions = this.listSessions();

    for (const session of sessions) {
      if (!session.hasLog) continue;

      const logPath = path.join(SESSION_DIR, `${session.pid}.log`);
      let content: string;
      try {
        content = _stripAnsi(_readFile(logPath));
      } catch { continue; }

      const lines = content.split('\n');

      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        if (regex.test(lines[i])) {
          results.push({
            pid: session.pid,
            alive: session.alive,
            line: i + 1,
            text: lines[i].trim().slice(0, 200),
            context: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n'),
          });
          regex.lastIndex = 0;
        }
      }

      if (results.length >= maxResults) break;
    }

    return { results, total: results.length, pattern };
  }

  getErrors(options: GetErrorsOptions = {}): SessionError[] {
    const since = options.since || 0;
    const maxPerSession = options.maxPerSession || 10;
    const sessions = this.listSessions();
    const errors: SessionError[] = [];

    for (const session of sessions) {
      if (!session.hasLog) continue;
      if (since && session.lastActivity < since) continue;

      const logPath = path.join(SESSION_DIR, `${session.pid}.log`);
      let content: string;
      try {
        content = _stripAnsi(_readFile(logPath));
      } catch { continue; }

      const lines = content.split('\n');
      let sessionErrors = 0;

      for (let i = 0; i < lines.length; i++) {
        if (sessionErrors >= maxPerSession) break;

        const line = lines[i];
        for (const { re, lang } of ERROR_PATTERNS) {
          if (re.test(line)) {
            const contextStart = Math.max(0, i - 2);
            const contextEnd = Math.min(lines.length, i + 6);
            errors.push({
              pid: session.pid,
              alive: session.alive,
              cwd: session.cwd,
              line: i + 1,
              text: line.trim().slice(0, 300),
              context: lines.slice(contextStart, contextEnd).join('\n'),
              lang,
            });
            sessionErrors++;
            break;
          }
        }
      }
    }

    return errors;
  }

  getDiagnostics(): DiagnosticsResult {
    const sessions = this.listSessions();
    const alive = sessions.filter(s => s.alive);
    const dead = sessions.filter(s => !s.alive);
    const errors = this.getErrors({ maxPerSession: 5 });

    const errorsBySession: Record<string, SessionError[]> = {};
    for (const err of errors) {
      if (!errorsBySession[err.pid]) errorsBySession[err.pid] = [];
      errorsBySession[err.pid].push(err);
    }

    const crashed = dead.filter(s => {
      const sessionErrors = errorsBySession[s.pid];
      return sessionErrors && sessionErrors.length > 0;
    });

    const summary: string[] = [];
    if (errors.length > 0) summary.push(`${errors.length} error(s) detected`);
    if (crashed.length > 0) summary.push(`${crashed.length} session(s) crashed`);
    if (alive.length > 0) summary.push(`${alive.length} active session(s)`);
    if (errors.length === 0 && crashed.length === 0) summary.push('All clear — no errors detected');

    return {
      sessions: {
        active: alive.length,
        dead: dead.length,
        total: sessions.length,
      },
      errors: {
        total: errors.length,
        items: errors.slice(0, 15),
        bySession: Object.fromEntries(
          Object.entries(errorsBySession).map(([pid, errs]) => [pid, errs.length])
        ),
      },
      crashed: crashed.map(s => ({
        pid: s.pid,
        cwd: s.cwd,
        shell: s.shell,
        errors: (errorsBySession[s.pid] || []).slice(0, 3),
      })),
      summary: summary.join('. ') + '.',
    };
  }

  watchSession(pid: number, callback: (data: string) => void): (() => void) | null {
    const logPath = path.join(SESSION_DIR, `${pid}.log`);
    if (!fs.existsSync(logPath)) return null;

    let lastSize: number;
    try {
      lastSize = fs.statSync(logPath).size;
    } catch {
      return null;
    }

    const interval = setInterval(() => {
      try {
        const stat = fs.statSync(logPath);
        if (stat.size > lastSize) {
          const fd = fs.openSync(logPath, 'r');
          const buf = Buffer.alloc(stat.size - lastSize);
          fs.readSync(fd, buf, 0, buf.length, lastSize);
          fs.closeSync(fd);
          lastSize = stat.size;
          callback(_stripAnsi(buf.toString('utf8')));
        }
      } catch {}
    }, 500);

    this._fileWatchers.set(pid, interval);

    return () => {
      clearInterval(interval);
      this._fileWatchers.delete(pid);
    };
  }

  cleanup(): number {
    let cleaned = 0;
    let files: string[];
    try {
      files = fs.readdirSync(SESSION_DIR);
    } catch {
      return 0;
    }

    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(SESSION_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        const pid = parseInt(path.basename(file).split('.')[0], 10);
        const age = now - stat.mtimeMs;
        const dead = !_isProcessAlive(pid);

        if (age > 24 * 60 * 60 * 1000 || (dead && age > 60 * 60 * 1000)) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {}
    }

    return cleaned;
  }

  destroy(): void {
    for (const interval of this._fileWatchers.values()) {
      clearInterval(interval);
    }
    this._fileWatchers.clear();
  }
}

// ── Internal helpers ──

function _isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function _tailFile(filePath: string, numLines: number): string {
  const CHUNK = 16384;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return '';
  }
  if (stat.size === 0) return '';

  if (stat.size < CHUNK * 2) {
    const content = _readFile(filePath);
    return content.split('\n').slice(-numLines).join('\n');
  }

  const fd = fs.openSync(filePath, 'r');
  let pos = Math.max(0, stat.size - CHUNK);
  let text = '';
  let lines = 0;

  while (pos >= 0 && lines < numLines) {
    const readSize = Math.min(CHUNK, stat.size - pos);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, pos);
    text = buf.toString('utf8') + text;
    lines = text.split('\n').length;
    if (pos === 0) break;
    pos = Math.max(0, pos - CHUNK);
  }

  fs.closeSync(fd);
  return text.split('\n').slice(-numLines).join('\n');
}

function _parseMarkers(content: string): ParsedCommand[] {
  const commands: ParsedCommand[] = [];
  let current: InternalCommand | null = null;

  for (const line of content.split('\n')) {
    const markerRe = /\x1b\]localpov;([^;]+);([^;]*);(\d+)\x07/g;
    let match: RegExpExecArray | null;

    while ((match = markerRe.exec(line)) !== null) {
      const [, type, value, ts] = match;

      if (type === 'cmd-start') {
        if (current) {
          current.output = (current._lines || []).join('\n');
          delete current._lines;
          commands.push(current as ParsedCommand);
        }
        current = {
          command: value,
          started: parseInt(ts, 10),
          exitCode: null,
          ended: null,
          output: '',
          _lines: [],
        };
      } else if (type === 'cmd-end') {
        if (current) {
          current.exitCode = parseInt(value, 10);
          current.ended = parseInt(ts, 10);
          current.output = (current._lines || []).join('\n');
          delete current._lines;
          commands.push(current as ParsedCommand);
          current = null;
        }
      }
    }

    if (current) {
      const clean = line.replace(/\x1b\]localpov;[^\x07]*\x07/g, '');
      if (!current._lines) current._lines = [];
      current._lines.push(clean);
    }
  }

  if (current) {
    current.output = (current._lines || []).join('\n');
    delete current._lines;
    commands.push(current as ParsedCommand);
  }

  return commands;
}

function _stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\(B/g, '')
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r/g, '');
}
