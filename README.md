# LocalPOV

Development context bridge for AI coding agents. Terminal output, browser console, network failures, Docker logs, build errors — one MCP server.

```
npx -y localpov --mcp
```

Your AI agent (Claude Code, Cursor, Windsurf, Claude Desktop) can now see everything happening in your dev environment — terminal errors, browser console output, failed network requests, build failures, Docker logs — without you copy-pasting anything.

## Why

AI coding agents are blind. They can read and write files, but they can't see:

- What your terminal just printed
- That the browser console is full of CORS errors
- That `fetch('/api/users')` is returning 500
- That the Docker container crashed 30 seconds ago
- That TypeScript found 12 errors on build

You end up copy-pasting error messages into chat. LocalPOV fixes this — the agent reads your dev environment directly.

## Quick start

```bash
# Install globally (optional — npx works without installing)
npm i -g localpov

# Interactive setup (shell integration + MCP config)
localpov setup

# Or just start the MCP server directly
npx -y localpov --mcp
```

## Setup for your AI client

LocalPOV works with every major AI coding tool. Pick yours:

### Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "localpov": {
      "command": "npx",
      "args": ["-y", "localpov", "--mcp"]
    }
  }
}
```

Or run `localpov mcp-config` to generate this automatically.

### Claude Desktop

Add to your `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "localpov": {
      "command": "npx",
      "args": ["-y", "localpov", "--mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` for global):

```json
{
  "mcpServers": {
    "localpov": {
      "command": "npx",
      "args": ["-y", "localpov", "--mcp"]
    }
  }
}
```

### Windsurf

Add to your MCP config:

- **macOS/Linux**: `~/.codeium/windsurf/mcp_config.json`
- **Windows**: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`

```json
{
  "mcpServers": {
    "localpov": {
      "command": "npx",
      "args": ["-y", "localpov", "--mcp"]
    }
  }
}
```

Or configure via Windsurf UI: Cascade panel → MCPs icon → Add server.

### Any other MCP client

LocalPOV uses **stdio transport** — the universal standard. Any MCP client that supports stdio works with:

```json
{
  "command": "npx",
  "args": ["-y", "localpov", "--mcp"]
}
```

### Local development (from source)

If you've cloned the repo:

```json
{
  "mcpServers": {
    "localpov": {
      "command": "node",
      "args": ["bin/localpov-mcp.js"]
    }
  }
}
```

## What the AI agent sees

14 tools available via MCP:

| Tool | What it does |
|------|-------------|
| `get_diagnostics` | One-call health check: terminal errors, browser console, network failures, port status, memory |
| `list_sessions` | All captured terminal sessions (PID, shell, alive/dead) |
| `read_terminal` | Last N lines from any terminal session, with pagination |
| `read_command` | Output of a specific command by index (supports negative indexing) |
| `get_errors` | Errors across all sessions (JS, TS, Python, Rust, Go patterns) |
| `search_all` | Regex search across all terminal output |
| `read_browser` | Browser console errors + failed/slow network requests |
| `take_screenshot` | Capture browser viewport |
| `get_build_errors` | Structured build errors: `{file, line, col, message}` |
| `docker` | List containers or read container logs |
| `tail_log` | Read last N lines of any log file |
| `check_ports` | What's listening, what's down |
| `check_env` | Which env vars exist (never exposes values) |
| `process_health` | System memory, CPU, uptime |

## How it works

### Terminal capture

Shell integration hooks into your shell startup (`bash`, `zsh`, `fish`, `powershell`). Every terminal session's output is captured to `~/.localpov/sessions/` as plain text logs.

```bash
# Install shell integration
localpov setup

# List captured sessions
localpov sessions

# Read a session
localpov sessions read <pid> [lines]

# Find errors across all sessions
localpov sessions errors

# Remove shell integration
localpov unsetup
```

The agent calls `read_terminal` or `get_errors` — it reads these logs directly. No copy-pasting needed.

### Browser capture

When the LocalPOV proxy is running, it injects a lightweight capture script into HTML responses. This gives the agent access to:

- **Console output** — `console.error`, `console.warn`, unhandled exceptions, promise rejections
- **Network requests** — failed fetches (4xx/5xx) with response bodies, slow requests, CORS errors
- **Screenshots** — on-demand viewport capture

No browser extension needed. Works in any browser.

```bash
# Start the proxy (auto-detects running dev servers)
localpov

# Or target a specific port
localpov --port 3000

# Change proxy listen port (default: 4000)
localpov --listen 8080
```

Then open `http://localhost:4000` instead of `http://localhost:3000` — your app works exactly the same, but the agent can now see console and network activity.

### Dashboard

Open `http://localhost:4000/__localpov__/` to see a visual debug panel:

- **Apps** — detected dev servers with one-click preview
- **Terminal** — live terminal output stream
- **Debug** — console errors, network failures, and system health in real-time

### Architecture

```
Terminal sessions          LocalPOV MCP Server          AI Agent
  (bash/zsh/ps)                   |                  (Claude Code,
       |                          |                   Cursor, etc.)
       |  ~/.localpov/sessions/   |   read_terminal         |
       |------------------------->|<------------------------|
                                  |                         |
Browser --> localpov proxy (:4000)|   read_browser          |
              |  injects capture  |<------------------------|
              |  script into HTML |                         |
              |                   |   take_screenshot       |
              |  console + fetch  |<------------------------|
              |  errors captured  |                         |
                                  |   get_diagnostics       |
Docker containers                 |<------------------------|
  |  docker logs                  |                         |
  |------------------------------>|   docker                |
                                  |<------------------------|
```

## Config file

Create `.localpovrc` in your project root:

```json
{
  "port": 3000,
  "listen": 4000,
  "ports": [3000, 3001, 5173, 8080]
}
```

CLI flags override config file values.

## CLI reference

```bash
localpov                    # Start proxy (auto-detect dev servers)
localpov --port 3000        # Proxy a specific port
localpov --listen 8080      # Change proxy listen port
localpov --mcp              # Start MCP server (stdio transport)
localpov setup              # Interactive first-run setup
localpov setup --shell      # Install shell integration only
localpov unsetup            # Remove shell integration
localpov mcp-config         # Print MCP config JSON
localpov mcp-config cursor  # Print config for Cursor
localpov sessions           # List captured terminal sessions
localpov sessions read PID  # Read a session's output
localpov sessions errors    # Find errors across sessions
localpov doctor             # Check your setup
```

## Supported shells

| Shell | Capture method | Platforms |
|-------|---------------|-----------|
| bash | `script` command + preexec/precmd hooks | Linux, macOS |
| zsh | `script` command + preexec/precmd hooks | Linux, macOS |
| fish | `script` command + fish_preexec/fish_postexec | Linux, macOS |
| PowerShell | `Start-Transcript` + prompt function flush | Windows, Linux, macOS |

## Supported frameworks

Any HTTP dev server works. Framework detection is cosmetic (shown in dashboard):

Next.js, Vite, Express, Angular, SvelteKit, Nuxt, Astro, Django, Flask, FastAPI, and anything else on a localhost port.

## Default scanned ports

`3000, 3001, 3002, 4200, 5173, 5174, 5175, 8000, 8080, 8888, 8081, 4321`

Customize via `.localpovrc`:

```json
{
  "ports": [3000, 3001, 4000, 5173, 8080, 9000]
}
```

## Safety

- **Output capped at 50KB** per MCP response — prevents flooding the AI context
- **Environment values never exposed** — `check_env` only reports existence (true/false)
- **File access restricted** — `tail_log` only reads from cwd, `~/.localpov/`, `/var/log/`, `/tmp/`
- **Sensitive paths blocked** — `.ssh`, `.env`, credentials files are never readable
- **WebSocket limits** — max 50 connections, 64KB message size cap
- **Stale data cleanup** — sessions >24h and browser data >4h auto-cleaned

## Requirements

- Node.js 18+

## License

MIT
