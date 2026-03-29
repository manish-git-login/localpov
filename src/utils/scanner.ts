import net from 'net';
import http from 'http';

const COMMON_PORTS: number[] = [3000, 3001, 3002, 4200, 5173, 5174, 5175, 8000, 8080, 8888, 8081, 4321];
const TIMEOUT = 400;

const FRAMEWORK_HINTS: Record<string, Record<string, string>> = {
  'x-powered-by': {
    'Next.js': 'Next.js',
    'Express': 'Express',
    'Nuxt': 'Nuxt',
  },
  'server': {
    'Vite': 'Vite',
    'webpack-dev-server': 'Webpack',
    'Python': 'Python',
    'uvicorn': 'FastAPI',
    'gunicorn': 'Django/Flask',
    'Caddy': 'Caddy',
  }
};

export function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(TIMEOUT);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

export function detectFramework(port: number): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('Unknown'), TIMEOUT * 2);
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      clearTimeout(timer);
      const headers = res.headers;

      for (const [header, map] of Object.entries(FRAMEWORK_HINTS)) {
        const val = (headers[header] as string) || '';
        for (const [hint, name] of Object.entries(map)) {
          if (val.includes(hint)) { res.destroy(); return resolve(name); }
        }
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 2000) res.destroy();
      });
      res.on('end', () => {
        if (body.includes('__next')) resolve('Next.js');
        else if (body.includes('vite')) resolve('Vite');
        else if (body.includes('ng-version')) resolve('Angular');
        else if (body.includes('__svelte')) resolve('SvelteKit');
        else if (body.includes('nuxt')) resolve('Nuxt');
        else if (body.includes('astro')) resolve('Astro');
        else resolve('Web server');
      });
      res.on('error', () => resolve('Web server'));
    });
    req.on('error', () => { clearTimeout(timer); resolve('Unknown'); });
    req.end();
  });
}

interface ScanResult {
  port: number;
  framework: string;
}

export async function scanPorts(customPorts?: number[]): Promise<ScanResult[]> {
  const ports = customPorts || COMMON_PORTS;

  const checks = await Promise.all(ports.map(async (port): Promise<ScanResult | null> => {
    const open = await checkPort(port);
    if (open) {
      const framework = await detectFramework(port);
      return { port, framework };
    }
    return null;
  }));

  return checks.filter((c): c is ScanResult => c !== null);
}

export { COMMON_PORTS };
