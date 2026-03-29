import os from 'os';

interface IPCandidate {
  name: string;
  address: string;
  priority: number;
}

interface IPResult {
  name: string;
  address: string;
}

export function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  const candidates: IPCandidate[] = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidates.push({
          name,
          address: addr.address,
          priority: name.match(/^(Wi-Fi|Ethernet|en0|wlan0|eth0|wlp)/i) ? 0 : 1,
        });
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
}

export function getAllIPs(): IPResult[] {
  const interfaces = os.networkInterfaces();
  const results: IPResult[] = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        results.push({ name, address: addr.address });
      }
    }
  }

  return results;
}
