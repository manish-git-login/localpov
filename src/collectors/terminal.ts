import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

const MAX_BUFFER_LINES = 1000;

interface TerminalOptions {
  maxLines?: number;
  interactive?: boolean;
}

interface BufferLine {
  type: string;
  text: string;
  ts: number;
}

interface TerminalStatus {
  running: boolean;
  command: string;
  interactive: boolean;
  exitCode: number | null;
  uptime: number;
  bufferSize: number;
}

/**
 * Captures stdout/stderr from a spawned process.
 * Read-only by default. Set `interactive: true` to enable stdin.
 */
export class TerminalCapture extends EventEmitter {
  buffer: BufferLine[];
  maxLines: number;
  interactive: boolean;
  process: ChildProcess | null;
  running: boolean;
  command: string;
  exitCode: number | null;
  startTime: number | null;

  constructor(command: string, options: TerminalOptions = {}) {
    super();
    this.buffer = [];
    this.maxLines = options.maxLines || MAX_BUFFER_LINES;
    this.interactive = !!options.interactive;
    this.process = null;
    this.running = false;
    this.command = command;
    this.exitCode = null;
    this.startTime = null;
  }

  start(): this {
    this.startTime = Date.now();

    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', this.command] : ['-c', this.command];

    this.process = spawn(shell, shellArgs, {
      stdio: [this.interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        FORCE_COLOR: '1',
        TERM: 'xterm-256color',
        npm_config_color: 'always',
      }),
      windowsHide: true,
    });

    this.running = true;
    this._addLine('system', `$ ${this.command}\n`);

    const handleStream = (stream: NodeJS.ReadableStream, type: string): void => {
      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        this._addLine(type, text);
        this.emit('data', { type, text, ts: Date.now() });
      });
    };

    if (this.process.stdout) handleStream(this.process.stdout, 'stdout');
    if (this.process.stderr) handleStream(this.process.stderr, 'stderr');

    this.process.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.running = false;
      this.exitCode = code;
      const msg = `\nProcess exited with code ${code}${signal ? ` (${signal})` : ''}\n`;
      this._addLine('system', msg);
      this.emit('data', { type: 'system', text: msg, ts: Date.now() });
      this.emit('exit', { code, signal });
    });

    this.process.on('error', (err: Error) => {
      this.running = false;
      const msg = `\nFailed to start: ${err.message}\n`;
      this._addLine('system', msg);
      this.emit('data', { type: 'system', text: msg, ts: Date.now() });
      this.emit('error', err);
    });

    return this;
  }

  _addLine(type: string, text: string): void {
    this.buffer.push({ type, text, ts: Date.now() });
    while (this.buffer.length > this.maxLines) {
      this.buffer.shift();
    }
  }

  /** Write to stdin (only works if interactive: true) */
  write(data: string): boolean {
    if (!this.interactive) return false;
    if (!this.process || !this.process.stdin || !this.running) return false;
    try {
      this.process.stdin.write(data);
      return true;
    } catch {
      return false;
    }
  }

  getBuffer(): BufferLine[] {
    return this.buffer;
  }

  getStatus(): TerminalStatus {
    return {
      running: this.running,
      command: this.command,
      interactive: this.interactive,
      exitCode: this.exitCode,
      uptime: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      bufferSize: this.buffer.length,
    };
  }

  stop(): void {
    if (this.process && this.running) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(this.process.pid), '/T', '/F']);
      } else {
        this.process.kill('SIGTERM');
        setTimeout(() => {
          if (this.running) {
            try { this.process!.kill('SIGKILL'); } catch {}
          }
        }, 5000);
      }
    }
  }
}
