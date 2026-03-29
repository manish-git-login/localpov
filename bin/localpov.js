#!/usr/bin/env node

// Suppress http-proxy's util._extend deprecation warning (their code, not ours)
const _origEmit = process.emit;
process.emit = function (name, data) {
  if (name === 'warning' && typeof data === 'object' && data.name === 'DeprecationWarning' && data.code === 'DEP0060') return false;
  return _origEmit.apply(process, arguments);
};

const pkg = require('../package.json');
const { scanPorts, checkPort } = require('../dist/utils/scanner');
const { createServer } = require('../dist/utils/proxy');
const { getLocalIP, getAllIPs } = require('../dist/utils/network');
const { TerminalCapture } = require('../dist/collectors/terminal');
const { getInitScript, setup, unsetup, detectShell, cleanSessions } = require('../dist/utils/shell-init');
const { SessionManager } = require('../dist/utils/session-manager');
const { BrowserCapture } = require('../dist/collectors/browser-capture');

// Terminal color helpers (no-op when piped)
const noColor = !process.stdout.isTTY;
const c = {
  g: (s) => noColor ? s : `\x1b[32m${s}\x1b[0m`,
  r: (s) => noColor ? s : `\x1b[31m${s}\x1b[0m`,
  y: (s) => noColor ? s : `\x1b[33m${s}\x1b[0m`,
  b: (s) => noColor ? s : `\x1b[1m${s}\x1b[0m`,
  d: (s) => noColor ? s : `\x1b[2m${s}\x1b[0m`,
  c: (s) => noColor ? s : `\x1b[36m${s}\x1b[0m`,
};

// Parse args
const args = process.argv.slice(2);
const flags = {};

// ─── Subcommands that exit immediately ───

// localpov --mcp | localpov mcp — start MCP server (stdio transport for AI agents)
if (args[0] === '--mcp' || args[0] === 'mcp') {
  flags.__mcp = true;
  require('../dist/mcp-server');
}

// localpov mcp-config — print MCP config JSON for AI agents
if (args[0] === 'mcp-config') {
  const which = args[1] || 'claude';
  const config = {
    localpov: {
      command: 'npx',
      args: ['-y', 'localpov', '--mcp'],
    },
  };

  console.log('');
  if (which === 'cursor') {
    console.log(`  ${c.b('Add to .cursor/mcp.json:')}`);
    console.log('');
    console.log(JSON.stringify({ mcpServers: config }, null, 2));
  } else {
    console.log(`  ${c.b('Add to .mcp.json (project root):')}`);
    console.log('');
    console.log(JSON.stringify({ mcpServers: config }, null, 2));
  }
  console.log('');
  console.log(`  ${c.d('Or if installed globally (npm i -g localpov):')}`);
  console.log(JSON.stringify({ mcpServers: { localpov: { command: 'localpov-mcp' } } }, null, 2));
  console.log('');
  process.exit(0);
}

// localpov init <shell> — print shell init script to stdout
if (args[0] === 'init') {
  const shell = args[1] || detectShell();
  const script = getInitScript(shell);
  if (!script) {
    console.error(`  ${c.r('Error:')} Unsupported shell: ${shell}`);
    console.error(`  Supported: bash, zsh, fish, powershell`);
    process.exit(1);
  }
  process.stdout.write(script);
  process.exit(0);
}

// localpov setup [--shell <shell>] — install shell integration
if (args[0] === 'setup') {
  let shell = null;
  if (args[1] === '--shell' && args[2]) shell = args[2];
  else if (args[1] && !args[1].startsWith('-')) shell = args[1];

  console.log('');
  console.log(`  ${c.b('localpov setup')}`);
  console.log('');

  if (!shell) shell = detectShell();
  console.log(`  Detected shell: ${c.c(shell)}`);

  const result = setup(shell);

  if (!result.success) {
    console.log(`  ${c.r('✗')} ${result.error}`);
    process.exit(1);
  }

  if (result.already) {
    console.log(`  ${c.g('✓')} Already installed in ${c.d(result.profilePath)}`);
  } else {
    console.log(`  ${c.g('✓')} Init script written to ${c.d(result.initPath)}`);
    console.log(`  ${c.g('✓')} Source line added to ${c.d(result.profilePath)}`);
  }

  // Warn Git Bash users about tee fallback
  if (shell === 'bash' && process.platform === 'win32' && process.env.MSYSTEM) {
    console.log(`  ${c.y('⚠')} Git Bash detected — using tee-based capture fallback`);
    console.log(`  ${c.d('  Output capture works, but minor readline display glitches are possible.')}`);
    console.log(`  ${c.d('  For full capture fidelity, use PowerShell: localpov setup powershell')}`);
  }

  console.log('');
  console.log(`  ${c.b('What happens now:')}`);
  console.log(`  Every new terminal session will be automatically captured.`);
  console.log(`  Output is saved to ${c.d('~/.localpov/sessions/')}`);
  console.log('');
  console.log(`  ${c.b('To activate now:')}`);
  if (shell === 'powershell') {
    console.log(`  Restart PowerShell, or run:`);
    console.log(`  ${c.c(`. "${result.initPath}"`)}`);
  } else {
    console.log(`  Restart your terminal, or run:`);
    console.log(`  ${c.c(`source "${result.initPath}"`)}`);
  }
  console.log('');
  console.log(`  ${c.b('To remove:')}`);
  console.log(`  ${c.c('localpov unsetup')}`);
  console.log('');
  process.exit(0);
}

// localpov unsetup — remove shell integration
if (args[0] === 'unsetup') {
  let shell = null;
  if (args[1] === '--shell' && args[2]) shell = args[2];
  else if (args[1] && !args[1].startsWith('-')) shell = args[1];

  const result = unsetup(shell);

  console.log('');
  if (result.success) {
    console.log(`  ${c.g('✓')} Removed localpov from ${c.d(result.profilePath)}`);
    console.log(`  ${c.d('Restart your terminal for changes to take effect.')}`);
  } else {
    console.log(`  ${c.r('✗')} ${result.error}`);
  }
  console.log('');
  process.exit(0);
}

// localpov sessions — list captured terminal sessions
if (args[0] === 'sessions') {
  const mgr = new SessionManager();

  if (args[1] === 'clean') {
    const cleaned = mgr.cleanup();
    console.log('');
    console.log(`  ${c.g('✓')} Cleaned ${cleaned} stale session file(s)`);
    console.log('');
    process.exit(0);
  }

  if (args[1] === 'read' && args[2]) {
    const pid = parseInt(args[2], 10);
    const lines = parseInt(args[3] || '50', 10);
    const result = mgr.readSession(pid, { lines });

    if (result.error) {
      console.error(`  ${c.r('Error:')} ${result.error}`);
      process.exit(1);
    }

    console.log('');
    console.log(`  ${c.b(`Session ${pid}`)} ${c.d(`(last ${result.lineCount} lines)`)}`);
    console.log(`  ${'─'.repeat(60)}`);
    for (const line of result.lines) {
      console.log(`  ${line}`);
    }

    if (result.commands.length > 0) {
      console.log('');
      console.log(`  ${c.b('Recent commands:')}`);
      for (const cmd of result.commands.slice(-5)) {
        const status = cmd.exitCode === null ? c.y('running')
          : cmd.exitCode === 0 ? c.g('ok')
          : c.r(`exit ${cmd.exitCode}`);
        console.log(`  ${status} ${c.c(cmd.command)}`);
      }
    }
    console.log('');
    process.exit(0);
  }

  if (args[1] === 'errors') {
    const errors = mgr.getErrors();
    console.log('');
    if (errors.length === 0) {
      console.log(`  ${c.g('✓')} No errors detected across sessions`);
    } else {
      console.log(`  ${c.r(`${errors.length} error(s) found:`)}`);
      console.log('');
      for (const err of errors.slice(0, 10)) {
        const status = err.alive ? c.g('●') : c.r('●');
        console.log(`  ${status} ${c.d(`[PID ${err.pid}]`)} ${err.text}`);
      }
    }
    console.log('');
    process.exit(0);
  }

  // Default: list sessions
  const sessions = mgr.listSessions();
  console.log('');

  if (sessions.length === 0) {
    console.log(`  ${c.y('⚠')} No captured sessions found`);
    console.log(`  ${c.d('Run `localpov setup` to start capturing terminal sessions')}`);
  } else {
    console.log(`  ${c.b('Captured terminal sessions:')}`);
    console.log('');
    for (const s of sessions) {
      const status = s.alive ? c.g('● alive') : c.d('● dead ');
      const size = s.logSize > 1024 * 1024
        ? `${(s.logSize / 1024 / 1024).toFixed(1)}MB`
        : `${(s.logSize / 1024).toFixed(0)}KB`;
      console.log(`  ${status}  PID ${c.b(String(s.pid).padEnd(7))} ${c.c(s.shell.padEnd(12))} ${c.d(size.padStart(8))}  ${s.cwd}`);
    }
    console.log('');
    console.log(`  ${c.d('localpov sessions read <pid> [lines]  — view session output')}`);
    console.log(`  ${c.d('localpov sessions errors               — find errors across all')}`);
    console.log(`  ${c.d('localpov sessions clean                — remove stale sessions')}`);
  }
  console.log('');
  process.exit(0);
}

// Check for 'run' subcommand: localpov run [flags] -- <command>
if (args[0] === 'run') {
  flags.run = true;
  const sepIdx = args.indexOf('--');
  const flagArgs = sepIdx >= 0 ? args.slice(1, sepIdx) : args.slice(1);
  const cmdArgs = sepIdx >= 0 ? args.slice(sepIdx + 1) : [];

  if (cmdArgs.length === 0) {
    console.error('  \x1b[31mError:\x1b[0m Usage: localpov run [flags] -- <command>');
    console.error('  Example: localpov run -- npm run dev');
    process.exit(1);
  }
  flags.runCommand = cmdArgs.join(' ');

  for (let i = 0; i < flagArgs.length; i++) {
    if (flagArgs[i] === '--port' || flagArgs[i] === '-p') { flags.port = parseInt(flagArgs[++i], 10); }
    else if (flagArgs[i] === '--listen' || flagArgs[i] === '-l') { flags.listen = parseInt(flagArgs[++i], 10); }
    else if (flagArgs[i] === '--terminal-rw') { flags.terminalRw = true; }
    else if (flagArgs[i] === '--help' || flagArgs[i] === '-h') { flags.help = true; }
  }
} else {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') { flags.port = parseInt(args[++i], 10); }
    else if (args[i] === '--listen' || args[i] === '-l') { flags.listen = parseInt(args[++i], 10); }
    else if (args[i] === '--help' || args[i] === '-h') { flags.help = true; }
    else if (args[i] === '--version' || args[i] === '-v') { flags.version = true; }
    else if (args[i] === 'doctor') { flags.doctor = true; }
  }
}

// Load .localpovrc config file
const configPath = require('path').join(process.cwd(), '.localpovrc');
try {
  const configRaw = require('fs').readFileSync(configPath, 'utf8');
  const config = JSON.parse(configRaw);
  if (config.port && flags.port === undefined) flags.port = parseInt(config.port, 10);
  if (config.listen && flags.listen === undefined) flags.listen = parseInt(config.listen, 10);
  if (config.ports && !flags.port) flags.customPorts = config.ports;
} catch {
  // No config file or invalid JSON — that's fine
}

if (flags.version) { console.log(`localpov v${pkg.version}`); process.exit(0); }

// Validate arguments
if (flags.port !== undefined && (isNaN(flags.port) || flags.port < 1 || flags.port > 65535)) {
  console.error(`  ${c.r('Error:')} --port must be a number between 1 and 65535`);
  process.exit(1);
}
if (flags.listen !== undefined && (isNaN(flags.listen) || flags.listen < 1 || flags.listen > 65535)) {
  console.error(`  ${c.r('Error:')} --listen must be a number between 1 and 65535`);
  process.exit(1);
}

if (flags.help) {
  console.log(`
  ${c.b('localpov')} — development context bridge for AI coding agents

  ${c.b('Usage:')}
    localpov                            Start proxy and auto-detect dev servers
    localpov --port 3000                Proxy a specific port
    localpov run -- npm run dev         Run command + capture terminal output
    localpov setup                      Install shell integration (auto-capture all terminals)
    localpov unsetup                    Remove shell integration
    localpov sessions                   List captured terminal sessions
    localpov sessions read <pid>        View a session's output
    localpov sessions errors            Find errors across all sessions
    localpov mcp-config                 Print MCP config for AI agents
    localpov doctor                     Check your system setup

  ${c.b('Run command:')}
    localpov run [flags] -- <command>
    Starts the command, captures stdout/stderr, and streams it
    to the Terminal tab in the dashboard (read-only by default).

    --terminal-rw     Allow remote input (interactive mode, use with caution)

  ${c.b('Shell integration:')}
    localpov setup                Auto-capture every terminal session
    localpov sessions             List captured sessions + find errors
    Sessions are saved to ~/.localpov/sessions/ and can be read by
    AI coding agents via the LocalPOV MCP server.

  ${c.b('MCP (AI agent integration):')}
    localpov mcp-config           Print config JSON for Claude Code / Cursor
    localpov --mcp                Start MCP server directly (stdio transport)

  ${c.b('Config file:')}
    Create .localpovrc in your project root:
    { "port": 3000 }

  ${c.b('Options:')}
    -p, --port <port>     Target a specific localhost port
    -l, --listen <port>   Port for LocalPOV to listen on (default: 4000)
    -h, --help            Show this help
    -v, --version         Show version
`);
  process.exit(0);
}

if (flags.doctor) {
  console.log(`\n  ${c.b('localpov doctor')}\n`);
  const ips = getAllIPs();
  console.log(`  Node.js:  ${c.g('✓')} ${process.version}`);
  console.log(`  Platform: ${process.platform} ${process.arch}`);
  console.log(`  IPs:`);
  for (const ip of ips) console.log(`    ${ip.name}: ${c.c(ip.address)}`);
  if (ips.length === 0) console.log(`    ${c.y('⚠ No network interfaces found')}`);
  console.log('');
  process.exit(0);
}

const LISTEN_PORT = flags.listen || parseInt(process.env.LOCALPOV_PORT || '4000', 10);
const SCAN_INTERVAL = 3000;
let detectedApps = [];
let srv = null;
let terminal = null;
const browserCapture = new BrowserCapture();

// Clean stale sessions on startup
try { cleanSessions(); } catch {}

// ─── First-run detection ───
function isFirstRun() {
  const fs = require('fs');
  const { LOCALPOV_DIR } = require('../dist/utils/shell-init');
  const markerPath = require('path').join(LOCALPOV_DIR, '.setup-done');
  return !fs.existsSync(markerPath);
}

function markSetupDone() {
  const fs = require('fs');
  const { LOCALPOV_DIR } = require('../dist/utils/shell-init');
  const markerPath = require('path').join(LOCALPOV_DIR, '.setup-done');
  try {
    fs.mkdirSync(LOCALPOV_DIR, { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
  } catch {}
}

function ask(question) {
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function firstRunSetup() {
  const fs = require('fs');
  const { setup, detectShell } = require('../dist/utils/shell-init');

  console.log('');
  console.log(`  ${c.b('Welcome to LocalPOV')} ${c.d(`v${pkg.version}`)}`);
  console.log(`  ${c.d('First-time setup — takes 30 seconds')}`);
  console.log('');

  // ─── Step 1: Shell integration ───
  const shell = detectShell();
  console.log(`  ${c.b('1.')} Shell integration ${c.d('(auto-capture all terminals for AI agents)')}`);
  console.log(`     Detected: ${c.c(shell)}`);

  const shellAnswer = await ask(`     Add auto-capture to ${shell} profile? [Y/n] `);
  if (shellAnswer !== 'n' && shellAnswer !== 'no') {
    const result = setup(shell);
    if (result.success) {
      if (result.already) {
        console.log(`     ${c.g('✓')} Already installed`);
      } else {
        console.log(`     ${c.g('✓')} Added to ${c.d(result.profilePath)}`);
        console.log(`     ${c.d('New terminals will be auto-captured after restart')}`);
      }
    } else {
      console.log(`     ${c.y('⚠')} ${result.error}`);
      console.log(`     ${c.d('You can run `localpov setup` later to retry')}`);
    }
  } else {
    console.log(`     ${c.d('Skipped. Run `localpov setup` anytime to enable.')}`);
  }
  console.log('');

  // ─── Step 2: MCP config for AI agents ───
  console.log(`  ${c.b('2.')} AI agent integration ${c.d('(MCP server for Claude Code, Cursor, etc.)')}`);

  const mcpPath = require('path').join(process.cwd(), '.mcp.json');
  let mcpExists = false;
  try {
    const content = fs.readFileSync(mcpPath, 'utf8');
    mcpExists = content.includes('localpov');
  } catch {}

  if (mcpExists) {
    console.log(`     ${c.g('✓')} Already configured in ${c.d('.mcp.json')}`);
  } else {
    const mcpAnswer = await ask(`     Create .mcp.json in this project? [Y/n] `);
    if (mcpAnswer !== 'n' && mcpAnswer !== 'no') {
      const mcpConfig = {
        mcpServers: {
          localpov: {
            command: 'npx',
            args: ['-y', 'localpov', '--mcp'],
          },
        },
      };
      try {
        const existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        existing.mcpServers = existing.mcpServers || {};
        existing.mcpServers.localpov = mcpConfig.mcpServers.localpov;
        fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
      } catch {
        fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');
      }
      console.log(`     ${c.g('✓')} Created ${c.d('.mcp.json')}`);
      console.log(`     ${c.d('Restart your AI agent to activate the MCP server')}`);
    } else {
      console.log(`     ${c.d('Skipped. Run `localpov mcp-config` to see the config.')}`);
    }
  }
  console.log('');

  markSetupDone();
  console.log(`  ${c.g('✓')} Setup complete. Starting LocalPOV...\n`);
}

async function main() {
  console.log('');
  console.log(`  ${c.b('localpov')} ${c.d(`v${pkg.version}`)}`);
  console.log('');

  // ─── First-run: guided setup ───
  if (isFirstRun() && !flags.run && !process.env.LOCALPOV_SKIP_SETUP) {
    if (process.stdin.isTTY) {
      await firstRunSetup();
    } else {
      console.log(`  ${c.d('First time? Run `localpov setup` for shell integration + MCP config.')}`);
      console.log('');
      markSetupDone();
    }
  }

  // ─── Run mode: spawn command + capture terminal ───
  if (flags.run) {
    console.log(`  ${c.b('Running:')} ${c.c(flags.runCommand)}`);
    console.log(`  ${c.d(flags.terminalRw ? 'Interactive mode (stdin enabled)' : 'Read-only terminal capture')}`);
    console.log('');

    terminal = new TerminalCapture(flags.runCommand, {
      interactive: !!flags.terminalRw,
    });

    terminal.start();

    terminal.on('data', (data) => {
      if (data.type === 'stdout') process.stdout.write(data.text);
      else if (data.type === 'stderr') process.stderr.write(data.text);
    });

    terminal.on('exit', ({ code, signal }) => {
      console.log('');
      console.log(`  ${code === 0 ? c.g('✓') : c.r('✗')} Process exited with code ${code}${signal ? ` (${signal})` : ''}`);
      console.log(`  ${c.d('Dashboard still running — terminal output preserved')}`);
    });

    await new Promise(r => setTimeout(r, 2000));
  }

  // Scan or use explicit port
  if (flags.port) {
    const alive = await checkPort(flags.port);
    if (alive) {
      const { detectFramework } = require('../dist/utils/scanner');
      const fw = await detectFramework(flags.port);
      detectedApps = [{ port: flags.port, framework: fw }];
      console.log(`  ${c.g('✓')} localhost:${c.b(flags.port)} ${c.d(`(${fw})`)}`);
    } else {
      console.log(`  ${c.y('⚠')} localhost:${flags.port} not responding — will keep checking`);
      detectedApps = [{ port: flags.port, framework: 'Not started' }];
    }
  } else {
    process.stdout.write(`  ${c.d('Scanning ports...')}`);
    detectedApps = await scanPorts(flags.customPorts);
    process.stdout.write('\r\x1b[K');

    if (detectedApps.length === 0) {
      console.log(`  ${c.y('⚠')} No dev servers found`);
      if (flags.run) {
        console.log(`  ${c.d('Waiting for the command to start a server...')}`);
      } else {
        console.log(`  ${c.d("Start one (e.g. npm run dev) — we'll detect it.")}`);
      }
    } else {
      for (const app of detectedApps) {
        console.log(`  ${c.g('✓')} localhost:${c.b(app.port)} ${c.d(`(${app.framework})`)}`);
      }
    }
  }

  console.log('');
  const defaultPort = detectedApps.length > 0 ? detectedApps[0].port : 3000;

  srv = createServer({
    targetPort: defaultPort,
    listenPort: LISTEN_PORT,
    getApps: () => detectedApps,
    terminal: terminal,
    browserCapture: browserCapture,
    onLog: (type, msg) => {
      if (type === 'switch') console.log(`  ${c.g('→')} Preview: localhost:${c.b(msg)}`);
      else if (type === 'error') console.log(`  ${c.r('✗')} ${msg}`);
    },
    onReady: () => {
      const localURL = `http://localhost:${LISTEN_PORT}/__localpov__/`;

      console.log(`  ${c.g('✓')} Running on :${LISTEN_PORT}`);
      if (terminal) {
        console.log(`  ${c.g('✓')} Terminal capture active`);
      }
      console.log('');
      console.log(`  ${c.b('Dashboard:')} ${c.c(localURL)}`);
      console.log('');
      console.log(`  ${c.d('Ctrl+C to stop')}`);
      console.log('');
    },
  });

  // Background scan (skip if explicit port)
  if (!flags.port) {
    setInterval(async () => {
      const fresh = await scanPorts(flags.customPorts);
      for (const app of fresh) {
        if (!detectedApps.find(a => a.port === app.port)) {
          console.log(`  ${c.g('+')} localhost:${c.b(app.port)} ${c.d(`(${app.framework})`)}`);
        }
      }
      for (const app of detectedApps) {
        if (!fresh.find(a => a.port === app.port)) {
          console.log(`  ${c.r('−')} localhost:${app.port} stopped`);
        }
      }
      detectedApps = fresh;
    }, SCAN_INTERVAL);
  }
}

function cleanup() {
  if (terminal) terminal.stop();
  if (srv) srv.close();
}

process.on('SIGINT', () => { console.log(''); cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// MCP server handles its own lifecycle — skip main()
if (!flags.__mcp) {
  main().catch((err) => { console.error(`  ${c.r('Error:')} ${err.message}`); process.exit(1); });
}
