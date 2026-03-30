const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const { createServer } = require('../dist/utils/proxy');

describe('proxy', () => {
  let targetServer;
  let targetPort;
  let proxyInstance;
  let proxyPort;

  before(async () => {
    // Create a target app server
    targetServer = http.createServer((req, res) => {
      if (req.url === '/compressed') {
        const html = '<html><body>compressed target app</body></html>';
        const gz = zlib.gzipSync(Buffer.from(html, 'utf8'));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Content-Length': String(gz.length),
        });
        res.end(gz);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html',
        'X-Frame-Options': 'DENY',
        'X-Custom': 'kept',
      });
      res.end('<html><body>target app</body></html>');
    });

    await new Promise((resolve) => {
      targetServer.listen(0, '127.0.0.1', resolve);
    });
    targetPort = targetServer.address().port;

    // Create the LocalPOV proxy server
    await new Promise((resolve) => {
      proxyInstance = createServer({
        targetPort,
        listenPort: 0,
        getApps: () => [{ port: targetPort, framework: 'Test' }],
        onReady: resolve,
      });
    });
    proxyPort = proxyInstance.server.address().port;
  });

  after(async () => {
    proxyInstance.close();
    await new Promise((resolve) => targetServer.close(resolve));
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${proxyPort}${path}`,
        options,
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('creates a server and listens on specified port', () => {
    assert.ok(proxyPort > 0);
    assert.ok(proxyInstance.server.listening);
  });

  it('dashboard endpoint serves HTML at /__localpov__/', async () => {
    const res = await request('/__localpov__/');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
  });

  it('API /api/apps returns JSON with apps array', async () => {
    const res = await request('/__localpov__/api/apps');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/json'));
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.apps));
  });

  it('API /api/switch sets per-session port cookie', async () => {
    const res = await request('/__localpov__/api/switch?port=4000');
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.target, 4000);
    // Should set a cookie for per-session port
    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie, 'should set a cookie');
    assert.ok(setCookie.toString().includes('lpov_port=4000'), 'cookie should contain port');
  });

  it('API /api/ping returns ok', async () => {
    const res = await request('/__localpov__/api/ping');
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.ok, true);
  });

  it('proxies requests to target app', async () => {
    const res = await request('/');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('target app'));
  });

  it('strips x-frame-options from proxied responses', async () => {
    const res = await request('/');
    assert.strictEqual(res.headers['x-frame-options'], undefined);
    // Non-blocked headers should remain
    assert.strictEqual(res.headers['x-custom'], 'kept');
  });

  it('handles compressed HTML responses without decode errors', async () => {
    const res = await request('/compressed');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('compressed target app'));
    assert.strictEqual(res.headers['content-encoding'], undefined);
  });
});
