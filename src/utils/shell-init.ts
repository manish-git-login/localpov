import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

export const LOCALPOV_DIR: string = path.join(os.homedir(), '.localpov');
export const SESSION_DIR: string = path.join(LOCALPOV_DIR, 'sessions');
const INIT_DIR: string = path.join(LOCALPOV_DIR, 'shell');

// ── Shell init scripts ──

type ShellType = 'bash' | 'zsh' | 'fish' | 'powershell';

interface SetupResult {
  success: boolean;
  error?: string;
  already?: boolean;
  shell?: string;
  profilePath?: string;
  initPath?: string;
  allProfiles?: string[];
}

interface UnsetupResult {
  success: boolean;
  error?: string;
  shell?: string;
  profilePath?: string;
}

function bashInit(): string {
  return `# LocalPOV shell integration — captures terminal output for AI agents
# https://github.com/localpov/localpov
# Installed by: localpov setup

__localpov_init() {
  [ -n "$LOCALPOV_SESSION" ] && return 0

  export LOCALPOV_SESSION=$$
  export LOCALPOV_SESSION_DIR="${SESSION_DIR}"
  mkdir -p "$LOCALPOV_SESSION_DIR"

  # Write session metadata
  local _ts
  _ts=$(date +%s)
  printf '{"pid":%d,"shell":"%s","cwd":"%s","started":%s,"user":"%s","term":"%s"}\\n' \\
    "$$" "$SHELL" "$PWD" "$_ts" "$USER" "$TERM" \\
    > "$LOCALPOV_SESSION_DIR/$$.meta"

  export LOCALPOV_LOG="$LOCALPOV_SESSION_DIR/$$.log"

  # Wrap shell with \`script\` to capture all terminal I/O
  # script -q FILE starts a sub-shell recording to FILE (works on macOS + Linux)
  if ! command -v script >/dev/null 2>&1; then
    # Git Bash / MSYS2 on Windows: \`script\` is unavailable
    # Fallback: redirect stdout+stderr through tee to capture output
    export LOCALPOV_CAPTURE_MODE=tee
    touch "$LOCALPOV_LOG"
    exec > >(tee -a "$LOCALPOV_LOG") 2>&1
    return 0
  fi
  exec script -q "$LOCALPOV_LOG"
}

# Inside the script sub-shell (or tee fallback): install command boundary markers
if [ -n "$LOCALPOV_SESSION" ]; then
  __localpov_preexec_fired=0

  __localpov_preexec() {
    __localpov_preexec_fired=1
    # OSC escape: invisible in terminal, captured in log file
    printf '\\033]localpov;cmd-start;%s;%d\\007' "$1" "$(date +%s)" 2>/dev/null
  }

  __localpov_precmd() {
    local _lpov_ec=$?
    # Only emit cmd-end if a command actually ran
    if [ "$__localpov_preexec_fired" = "1" ]; then
      printf '\\033]localpov;cmd-end;%d;%d\\007' "$_lpov_ec" "$(date +%s)" 2>/dev/null
      __localpov_preexec_fired=0
    fi
  }

  # Bash: use trap DEBUG for preexec (same technique as bash-preexec)
  if [ -n "$BASH_VERSION" ]; then
    __localpov_last_hist=""
    __localpov_trap_debug() {
      # Skip during completion, prompt command, and subshells
      [ -n "$COMP_LINE" ] && return
      [ "$BASH_SUBSHELL" -gt 0 ] && return

      # Use history number to detect new commands (avoids double-fire)
      local _hist
      _hist=$(history 1 2>/dev/null)
      [ "$_hist" = "$__localpov_last_hist" ] && return
      __localpov_last_hist="$_hist"

      # Extract just the command part
      local _cmd
      _cmd=$(echo "$_hist" | sed 's/^ *[0-9]* *//')
      __localpov_preexec "$_cmd"
    }

    trap '__localpov_trap_debug' DEBUG
    PROMPT_COMMAND="__localpov_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  fi
else
  __localpov_init
fi
`;
}

function zshInit(): string {
  return `# LocalPOV shell integration — captures terminal output for AI agents
# https://github.com/localpov/localpov
# Installed by: localpov setup

__localpov_init() {
  [[ -n "$LOCALPOV_SESSION" ]] && return 0

  export LOCALPOV_SESSION=$$
  export LOCALPOV_SESSION_DIR="${SESSION_DIR}"
  mkdir -p "$LOCALPOV_SESSION_DIR"

  local _ts
  _ts=$(date +%s)
  printf '{"pid":%d,"shell":"%s","cwd":"%s","started":%s,"user":"%s","term":"%s"}\\n' \\
    "$$" "$SHELL" "$PWD" "$_ts" "$USER" "$TERM" \\
    > "$LOCALPOV_SESSION_DIR/$$.meta"

  export LOCALPOV_LOG="$LOCALPOV_SESSION_DIR/$$.log"

  if ! command -v script >/dev/null 2>&1; then
    # Fallback for environments without script (e.g. zsh on MSYS2)
    export LOCALPOV_CAPTURE_MODE=tee
    touch "$LOCALPOV_LOG"
    exec > >(tee -a "$LOCALPOV_LOG") 2>&1
    return 0
  fi
  exec script -q "$LOCALPOV_LOG"
}

if [[ -n "$LOCALPOV_SESSION" ]]; then
  __localpov_preexec() {
    printf '\\033]localpov;cmd-start;%s;%d\\007' "$1" "$(date +%s)" 2>/dev/null
  }

  __localpov_precmd() {
    local _lpov_ec=$?
    printf '\\033]localpov;cmd-end;%d;%d\\007' "$_lpov_ec" "$(date +%s)" 2>/dev/null
  }

  autoload -Uz add-zsh-hook
  add-zsh-hook preexec __localpov_preexec
  add-zsh-hook precmd __localpov_precmd
else
  __localpov_init
fi
`;
}

function fishInit(): string {
  return `# LocalPOV shell integration — captures terminal output for AI agents
# https://github.com/localpov/localpov
# Installed by: localpov setup

if not set -q LOCALPOV_SESSION
    set -gx LOCALPOV_SESSION %self
    set -gx LOCALPOV_SESSION_DIR "${SESSION_DIR}"
    mkdir -p "$LOCALPOV_SESSION_DIR"

    set -l _ts (date +%s)
    printf '{"pid":%d,"shell":"fish","cwd":"%s","started":%s,"user":"%s","term":"%s"}\\n' \\
        %self "$PWD" "$_ts" "$USER" "$TERM" \\
        > "$LOCALPOV_SESSION_DIR/%self.meta"

    set -gx LOCALPOV_LOG "$LOCALPOV_SESSION_DIR/%self.log"

    if not command -v script >/dev/null 2>&1
        # Fallback for environments without script
        set -gx LOCALPOV_CAPTURE_MODE tee
        touch "$LOCALPOV_LOG"
        # Fish does not support exec+process substitution; log via fish_postexec
        set -gx __localpov_tee_fallback 1
    else
        exec script -q "$LOCALPOV_LOG"
    end
else
    # In tee fallback mode, log each command's output
    if set -q __localpov_tee_fallback
        function __localpov_postexec --on-event fish_postexec
            echo "$argv" >> "$LOCALPOV_LOG" 2>/dev/null
        end
    end
    function __localpov_preexec --on-event fish_preexec
        printf '\\033]localpov;cmd-start;%s;%d\\007' "$argv" (date +%s) 2>/dev/null
    end

    function __localpov_postcmd --on-event fish_postexec
        printf '\\033]localpov;cmd-end;%d;%d\\007' $status (date +%s) 2>/dev/null
    end
end
`;
}

function powershellInit(): string {
  const sessionDir = SESSION_DIR.replace(/\\/g, '\\\\');
  return `# LocalPOV shell integration — captures terminal output for AI agents
# https://github.com/localpov/localpov
# Installed by: localpov setup

if (-not $env:LOCALPOV_SESSION) {
    try {
        $env:LOCALPOV_SESSION = $PID
        $env:LOCALPOV_SESSION_DIR = "${sessionDir}"
        if (-not (Test-Path $env:LOCALPOV_SESSION_DIR)) {
            New-Item -ItemType Directory -Force -Path $env:LOCALPOV_SESSION_DIR | Out-Null
        }

        # Session metadata
        $__lpov_ts = [int][double]::Parse((Get-Date -UFormat %s))
        $__lpov_meta = '{"pid":' + $PID + ',"shell":"powershell","cwd":"' + ($PWD.Path -replace '\\\\','/') + '","started":' + $__lpov_ts + ',"user":"' + $env:USERNAME + '","term":"' + $env:TERM + '"}'
        Set-Content -Path (Join-Path $env:LOCALPOV_SESSION_DIR "$PID.meta") -Value $__lpov_meta -Encoding UTF8

        $env:LOCALPOV_LOG = Join-Path $env:LOCALPOV_SESSION_DIR "$PID.log"

        # Start transcript — captures all input + output
        Start-Transcript -Path $env:LOCALPOV_LOG -Append | Out-Null

        # Flush transcript after every command by cycling Stop/Start in prompt
        $global:__lpov_orig_prompt = $function:prompt
        function global:prompt {
            # Flush: stop + restart transcript forces write to disk
            try { Stop-Transcript | Out-Null } catch {}
            try { Start-Transcript -Path $env:LOCALPOV_LOG -Append | Out-Null } catch {}

            # Call original prompt
            if ($global:__lpov_orig_prompt) {
                & $global:__lpov_orig_prompt
            } else {
                "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
            }
        }

        # Cleanup on exit
        Register-EngineEvent PowerShell.Exiting -Action {
            try { Stop-Transcript } catch {}
        } | Out-Null

    } catch {
        Write-Verbose "LocalPOV init error: $_"
    }
}
`;
}

// ── Shell detection & profile paths ──

const SHELL_GENERATORS: Record<ShellType, () => string> = {
  bash: bashInit,
  zsh: zshInit,
  fish: fishInit,
  powershell: powershellInit,
};

export function detectShell(): ShellType {
  const shellEnv = process.env.SHELL || '';
  if (shellEnv.includes('zsh')) return 'zsh';
  if (shellEnv.includes('fish')) return 'fish';
  if (shellEnv.includes('bash')) return 'bash';
  if (process.platform === 'win32') {
    if (process.env.PSModulePath) return 'powershell';
    if (process.env.MSYSTEM) return 'bash';
    return 'powershell';
  }
  return 'bash';
}

export function getShellProfile(shell: ShellType): string | null {
  const home = os.homedir();
  switch (shell) {
    case 'bash': return path.join(home, '.bashrc');
    case 'zsh': return path.join(home, '.zshrc');
    case 'fish': return path.join(home, '.config', 'fish', 'config.fish');
    case 'powershell': {
      if (process.platform === 'win32') {
        return path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
      }
      return path.join(home, '.config', 'powershell', 'Microsoft.PowerShell_profile.ps1');
    }
    default: return null;
  }
}

function getAllShellProfiles(shell: ShellType): string[] {
  const primary = getShellProfile(shell);
  if (!primary) return [];
  if (shell === 'powershell' && process.platform === 'win32') {
    const profiles = new Set<string>();

    try {
      const ps51 = execSync('powershell.exe -NoProfile -Command "$PROFILE"', {
        encoding: 'utf8', timeout: 8000, windowsHide: true,
      }).trim();
      if (ps51 && ps51.endsWith('.ps1')) profiles.add(ps51);
    } catch {}

    try {
      const ps7 = execSync('pwsh.exe -NoProfile -Command "$PROFILE"', {
        encoding: 'utf8', timeout: 8000, windowsHide: true,
      }).trim();
      if (ps7 && ps7.endsWith('.ps1')) profiles.add(ps7);
    } catch {}

    return [...profiles];
  }
  return [primary];
}

export function getInitFilePath(shell: ShellType): string {
  const ext = shell === 'powershell' ? 'ps1' : shell;
  return path.join(INIT_DIR, `init.${ext}`);
}

function getSourceLine(shell: ShellType): string | null {
  const initFile = getInitFilePath(shell);
  switch (shell) {
    case 'bash':
    case 'zsh':
      return `[ -f "${initFile}" ] && source "${initFile}"`;
    case 'fish':
      return `test -f "${initFile}"; and source "${initFile}"`;
    case 'powershell':
      return `if (Test-Path "${initFile}") { . "${initFile}" }`;
    default:
      return null;
  }
}

// ── getInitScript: for `localpov init <shell>` (prints to stdout) ──

export function getInitScript(shell: ShellType): string | null {
  const fn = SHELL_GENERATORS[shell];
  if (!fn) return null;
  return fn();
}

// ── setup: writes init file + adds source line to profile ──

export function setup(shell?: ShellType): SetupResult {
  if (!shell) shell = detectShell();
  const fn = SHELL_GENERATORS[shell];
  if (!fn) return { success: false, error: `Unsupported shell: ${shell}` };

  const initPath = getInitFilePath(shell);
  fs.mkdirSync(path.dirname(initPath), { recursive: true });
  fs.writeFileSync(initPath, fn(), 'utf8');

  const profiles = getAllShellProfiles(shell);
  if (profiles.length === 0) {
    return { success: false, error: `Could not detect ${shell} profile path. Run: ${shell === 'powershell' ? 'powershell.exe -Command "$PROFILE"' : 'echo $SHELL'} and pass the result to: localpov setup --profile <path>` };
  }
  const sourceLine = getSourceLine(shell);
  const marker = '# localpov shell integration';
  let anyAdded = false;

  for (const profilePath of profiles) {
    let profileContent = '';
    try {
      profileContent = fs.readFileSync(profilePath, 'utf8');
    } catch {
      // Profile doesn't exist yet
    }

    if (!profileContent.includes('localpov')) {
      fs.mkdirSync(path.dirname(profilePath), { recursive: true });
      const addition = `\n${marker}\n${sourceLine}\n`;
      fs.appendFileSync(profilePath, addition, 'utf8');
      anyAdded = true;
    }
  }

  const profilePath = profiles[0];
  return { success: true, already: !anyAdded, shell, profilePath, initPath, allProfiles: profiles };
}

// ── unsetup: removes source line from profile ──

export function unsetup(shell?: ShellType): UnsetupResult {
  if (!shell) shell = detectShell();
  const profiles = getAllShellProfiles(shell);
  if (!profiles.length) return { success: false, error: `Unsupported shell: ${shell}` };

  for (const profilePath of profiles) {
    try {
      let content = fs.readFileSync(profilePath, 'utf8');
      content = content.replace(/\n?# localpov shell integration\n[^\n]*\n?/g, '\n');
      fs.writeFileSync(profilePath, content, 'utf8');
    } catch {
      // Profile doesn't exist — nothing to remove
    }
  }

  const initPath = getInitFilePath(shell);
  try { fs.unlinkSync(initPath); } catch {}

  return { success: true, shell, profilePath: profiles[0] };
}

// ── cleanSessions: remove stale session files ──

export function cleanSessions(): number {
  let cleaned = 0;
  try {
    const files = fs.readdirSync(SESSION_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(SESSION_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        const pid = parseInt(path.basename(file).split('.')[0], 10);
        const age = now - stat.mtimeMs;
        let dead = false;
        try { process.kill(pid, 0); } catch { dead = true; }

        if (age > 24 * 60 * 60 * 1000 || (dead && age > 60 * 60 * 1000)) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {}
    }
  } catch {}
  return cleaned;
}
