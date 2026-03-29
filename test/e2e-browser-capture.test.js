'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const { createServer } = require('../dist/utils/proxy');
const { BrowserCapture } = require('../dist/collectors/browser-capture');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * End-to-end test: proxy → inject → WebSocket → BrowserCapture → read
 *
 * Verifies the full chain:
 *   1. Target app serves HTML
 *   2. Proxy injects capture script into response
 *   3. Browser-side WS connects and sends console/network messages
 *   4. BrowserCapture stores them
 *   5. Data is readable via getConsoleEntries / getNetworkEntries / getSummary
 */
describe('E2E: browser capture pipeline', () => {
  let targetServer;
  let targetPort;
  let proxyInstance;
  let proxyPort;
  let browserCapture;
  let tmpDir;

  before(async () => {
    // Use a temp directory for persistence to avoid polluting real data
    tmpDir = path.join(os.tmpdir(), `localpov-e2e-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    browserCapture = new BrowserCapture({ persistDir: tmpDir });

    // 1. Target app — serves HTML with </head> so injection works
    targetServer = http.createServer((req, res) => {
      if (req.url === '/api/data') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><head><title>Test App</title></head><body><h1>Hello</h1></body></html>');
    });

    await new Promise((resolve) => {
      targetServer.listen(0, '127.0.0.1', resolve);
    });
    targetPort = targetServer.address().port;

    // 2. Start proxy with browserCapture
    await new Promise((resolve) => {
      proxyInstance = createServer({
        targetPort,
        listenPort: 0,
        getApps: () => [{ port: targetPort, framework: 'Test' }],
        browserCapture,
        onReady: resolve,
      });
    });
    proxyPort = proxyInstance.server.address().port;
  });

  after(async () => {
    proxyInstance.close();
    await new Promise((resolve) => targetServer.close(resolve));
    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  function httpGet(urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${proxyPort}${urlPath}`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  function connectBrowserWs() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/__localpov__/ws/browser`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  // ── Step 1: Proxy injects script into HTML ──

  it('injects capture script into HTML responses', async () => {
    const res = await httpGet('/');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('data-localpov-inject'), 'should contain inject script marker');
    assert.ok(res.body.includes('__localpov_injected'), 'should contain dedup guard');
    assert.ok(res.body.includes('ws/browser'), 'should contain browser WS URL');
    // Script should be before </head>
    const scriptIdx = res.body.indexOf('data-localpov-inject');
    const headIdx = res.body.indexOf('</head>');
    assert.ok(scriptIdx < headIdx, 'inject script should be before </head>');
  });

  it('does NOT inject into non-HTML responses', async () => {
    const res = await httpGet('/api/data');
    assert.strictEqual(res.status, 500);
    assert.ok(!res.body.includes('data-localpov-inject'), 'should NOT inject into JSON response');
  });

  // ── Step 2: WebSocket connection works ──

  it('accepts browser WebSocket connections', async () => {
    const ws = await connectBrowserWs();
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  // ── Step 3: Console messages flow through the full pipeline ──

  it('receives console.error from browser WS and stores it', async () => {
    const ws = await connectBrowserWs();

    // Simulate browser sending a console error
    ws.send(JSON.stringify({
      type: 'console',
      level: 'error',
      message: 'Uncaught TypeError: Cannot read property "foo" of undefined',
      url: 'http://localhost:3000/app.js',
      ts: Date.now(),
    }));

    // Give the server a moment to process
    await new Promise((r) => setTimeout(r, 100));

    const entries = browserCapture.getConsoleEntries({ level: ['error'] });
    assert.ok(entries.length >= 1, 'should have at least one console error');
    const found = entries.find(e => e.message.includes('Cannot read property'));
    assert.ok(found, 'should find the specific error message');
    assert.strictEqual(found.level, 'error');
    assert.ok(found.url.includes('localhost'), 'should preserve the page URL');

    ws.close();
  });

  it('receives console.warn from browser WS', async () => {
    const ws = await connectBrowserWs();

    ws.send(JSON.stringify({
      type: 'console',
      level: 'warn',
      message: 'React: key prop missing on list item',
      url: 'http://localhost:3000/',
      ts: Date.now(),
    }));

    await new Promise((r) => setTimeout(r, 100));

    const warnings = browserCapture.getConsoleEntries({ level: ['warn'] });
    const found = warnings.find(e => e.message.includes('key prop missing'));
    assert.ok(found, 'should store warning messages');

    ws.close();
  });

  // ── Step 4: Network failure messages flow through ──

  it('receives failed network request from browser WS', async () => {
    const ws = await connectBrowserWs();

    ws.send(JSON.stringify({
      type: 'network',
      method: 'POST',
      url: 'http://localhost:3000/api/users',
      status: 500,
      statusText: 'Internal Server Error',
      duration: 234,
      responseBody: '{"error":"database connection failed"}',
      ts: Date.now(),
    }));

    await new Promise((r) => setTimeout(r, 100));

    const errors = browserCapture.getNetworkEntries({ errorsOnly: true });
    assert.ok(errors.length >= 1, 'should have at least one network error');
    const found = errors.find(e => e.url.includes('/api/users'));
    assert.ok(found, 'should find the specific failed request');
    assert.strictEqual(found.status, 500);
    assert.strictEqual(found.method, 'POST');
    assert.ok(found.responseBody.includes('database connection failed'), 'should preserve response body');

    ws.close();
  });

  it('receives network timeout/CORS error from browser WS', async () => {
    const ws = await connectBrowserWs();

    ws.send(JSON.stringify({
      type: 'network',
      method: 'GET',
      url: 'https://api.example.com/data',
      status: 0,
      error: 'Failed to fetch (CORS)',
      duration: 0,
      ts: Date.now(),
    }));

    await new Promise((r) => setTimeout(r, 100));

    const errors = browserCapture.getNetworkEntries({ errorsOnly: true });
    const found = errors.find(e => e.url.includes('example.com') && e.status === 0);
    assert.ok(found, 'should capture CORS/network errors with status 0');
    assert.ok(found.error.includes('CORS'), 'should preserve error description');

    ws.close();
  });

  // ── Step 5: Unhandled errors (window.onerror) flow through ──

  it('receives unhandled window errors from browser WS', async () => {
    const ws = await connectBrowserWs();

    ws.send(JSON.stringify({
      type: 'error',
      message: 'Uncaught ReferenceError: foo is not defined',
      source: 'http://localhost:3000/main.js:42:12',
      stack: 'ReferenceError: foo is not defined\n    at main.js:42:12',
      url: 'http://localhost:3000/',
      ts: Date.now(),
    }));

    await new Promise((r) => setTimeout(r, 100));

    const errors = browserCapture.getConsoleEntries({ level: ['error'] });
    const found = errors.find(e => e.message.includes('foo is not defined'));
    assert.ok(found, 'should store unhandled errors as console errors');
    assert.ok(found.stack.includes('main.js:42'), 'should preserve stack trace');
    assert.ok(found.source.includes('main.js:42:12'), 'should preserve source location');

    ws.close();
  });

  // ── Step 6: Summary reflects all captured data ──

  it('getSummary returns accurate counts after all messages', () => {
    const summary = browserCapture.getSummary();

    assert.ok(summary.console.errors >= 2, `should have >=2 console errors, got ${summary.console.errors}`);
    assert.ok(summary.console.warnings >= 1, `should have >=1 warning, got ${summary.console.warnings}`);
    assert.ok(summary.network.failed >= 2, `should have >=2 failed network requests, got ${summary.network.failed}`);
    assert.ok(summary.console.recentErrors.length > 0, 'should have recent error previews');
    assert.ok(summary.network.recentErrors.length > 0, 'should have recent network error previews');
  });

  // ── Step 7: Persistence — data survives reload from disk ──

  it('persists data to disk and reloads correctly', () => {
    // Create a fresh BrowserCapture reading from the same persist dir
    const reloaded = new BrowserCapture({ persistDir: tmpDir });

    assert.ok(reloaded.consoleEntries.length >= 3, `should reload console entries from disk, got ${reloaded.consoleEntries.length}`);
    assert.ok(reloaded.networkEntries.length >= 2, `should reload network entries from disk, got ${reloaded.networkEntries.length}`);

    // Verify specific data survived the round-trip
    const err = reloaded.consoleEntries.find(e => e.message.includes('Cannot read property'));
    assert.ok(err, 'specific error should survive persist + reload');

    const net = reloaded.networkEntries.find(e => e.url.includes('/api/users'));
    assert.ok(net, 'specific network error should survive persist + reload');
    assert.strictEqual(net.status, 500);
  });

  // ── Step 8: Malformed messages don't crash the pipeline ──

  it('handles malformed WebSocket messages without crashing', async () => {
    const ws = await connectBrowserWs();

    // Send various malformed messages
    ws.send('not json at all');
    ws.send('{}');
    ws.send(JSON.stringify({ type: 'unknown_type', data: 123 }));
    ws.send(JSON.stringify({ type: 'console' })); // missing required fields
    ws.send(JSON.stringify({ type: 'network', status: 'not_a_number' }));

    await new Promise((r) => setTimeout(r, 100));

    // Server should still be alive and accepting new valid messages
    ws.send(JSON.stringify({
      type: 'console',
      level: 'info',
      message: 'still alive after malformed messages',
      ts: Date.now(),
    }));

    await new Promise((r) => setTimeout(r, 100));

    const entries = browserCapture.getConsoleEntries();
    const found = entries.find(e => e.message.includes('still alive'));
    assert.ok(found, 'server should still work after receiving malformed messages');

    ws.close();
  });

  // ── Step 9: Multiple concurrent WebSocket clients ──

  it('handles multiple simultaneous browser connections', async () => {
    const ws1 = await connectBrowserWs();
    const ws2 = await connectBrowserWs();

    const before = browserCapture.consoleEntries.length;

    ws1.send(JSON.stringify({
      type: 'console', level: 'error', message: 'error from tab 1', ts: Date.now(),
    }));
    ws2.send(JSON.stringify({
      type: 'console', level: 'error', message: 'error from tab 2', ts: Date.now(),
    }));

    await new Promise((r) => setTimeout(r, 100));

    const entries = browserCapture.consoleEntries.slice(before);
    const tab1 = entries.find(e => e.message.includes('tab 1'));
    const tab2 = entries.find(e => e.message.includes('tab 2'));
    assert.ok(tab1, 'should capture from first tab');
    assert.ok(tab2, 'should capture from second tab');

    ws1.close();
    ws2.close();
  });

  // ── Step 10: Large message handling ──

  it('truncates oversized messages without crashing', async () => {
    const ws = await connectBrowserWs();

    const hugeMessage = 'x'.repeat(10000); // 10KB message body
    ws.send(JSON.stringify({
      type: 'console',
      level: 'error',
      message: hugeMessage,
      ts: Date.now(),
    }));

    await new Promise((r) => setTimeout(r, 100));

    const entries = browserCapture.getConsoleEntries({ level: ['error'] });
    const found = entries.find(e => e.message.startsWith('xxxx'));
    assert.ok(found, 'should store the message');
    assert.ok(found.message.length <= 2000, `message should be capped at 2000 chars, got ${found.message.length}`);

    ws.close();
  });
});
