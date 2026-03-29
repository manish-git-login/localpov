import { execSync, execFileSync, spawnSync } from 'child_process';

interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
}

interface ContainerLogsOptions {
  tail?: number;
  since?: string;
}

interface ContainerLogsResult {
  container: string;
  lines: string[];
  lineCount?: number;
  error?: string;
}

interface ContainerStats {
  container: string;
  cpu: string;
  mem: string;
  memPerc: string;
  net: string;
  pids: string;
}

interface DockerSummary {
  available: boolean;
  running?: number;
  containers: Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    ports: string;
  }>;
}

export function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function listContainers(): DockerContainer[] {
  try {
    const out = execSync(
      'docker ps --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"',
      { timeout: 10000, encoding: 'utf8' }
    );
    return out.trim().split('\n').filter(Boolean).map(line => {
      const [id, name, image, status, ports] = line.split('\t');
      return { id, name, image, status, ports };
    });
  } catch {
    return [];
  }
}

export function getContainerLogs(nameOrId: string, options: ContainerLogsOptions = {}): ContainerLogsResult {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.\-/]{0,127}$/.test(nameOrId)) {
    return { container: nameOrId, error: 'Invalid container name or ID', lines: [] };
  }

  const tail = Math.min(Math.max(options.tail || 100, 1), 1000);
  const since = options.since || '';

  if (since && !/^[\d]+[smh]$|^\d{4}-\d{2}-\d{2}/.test(since)) {
    return { container: nameOrId, error: 'Invalid --since format. Use "10m", "1h", or ISO date.', lines: [] };
  }

  const args = ['logs', '--tail', String(tail), '--timestamps'];
  if (since) args.push('--since', since);
  args.push(nameOrId);

  try {
    const out = execFileSync('docker', args, {
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      container: nameOrId,
      lines: out.trim().split('\n').filter(Boolean),
      lineCount: out.trim().split('\n').filter(Boolean).length,
    };
  } catch (e: unknown) {
    try {
      const result = spawnSync('docker', args, {
        timeout: 10000,
        encoding: 'utf8',
      });
      const combined = (result.stdout || '') + (result.stderr || '');
      const lines = combined.trim().split('\n').filter(Boolean);
      return { container: nameOrId, lines, lineCount: lines.length };
    } catch {
      const msg = e instanceof Error ? e.message : String(e);
      return { container: nameOrId, error: msg, lines: [] };
    }
  }
}

export function getContainerStats(nameOrId: string): ContainerStats | null {
  try {
    const out = execFileSync('docker', [
      'stats', nameOrId, '--no-stream',
      '--format', '{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.PIDs}}'
    ], { timeout: 10000, encoding: 'utf8' });
    const [cpu, mem, memPerc, net, pids] = out.trim().split('\t');
    return { container: nameOrId, cpu, mem, memPerc, net, pids };
  } catch {
    return null;
  }
}

export function dockerSummary(): DockerSummary {
  if (!isDockerAvailable()) {
    return { available: false, containers: [] };
  }

  const containers = listContainers();
  return {
    available: true,
    running: containers.length,
    containers: containers.map(c => ({
      id: c.id,
      name: c.name,
      image: c.image,
      status: c.status,
      ports: c.ports,
    })),
  };
}
