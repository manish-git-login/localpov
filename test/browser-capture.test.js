'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { BrowserCapture } = require('../dist/collectors/browser-capture');

// Use a unique temp dir per test run to avoid cross-contamination
let tmpCounter = 0;
function makeCap() {
  const dir = path.join(os.tmpdir(), `localpov-test-browser-${process.pid}-${++tmpCounter}`);
  return new BrowserCapture({ persistDir: dir });
}

describe('BrowserCapture', () => {
  it('stores console entries', () => {
    const cap = makeCap();
    cap.addConsoleEntry({ level: 'error', message: 'TypeError: x is undefined', url: 'http://localhost:3000' });
    cap.addConsoleEntry({ level: 'warn', message: 'Deprecation warning' });
    cap.addConsoleEntry({ level: 'log', message: 'Hello' });

    const all = cap.getConsoleEntries({ limit: 10 });
    assert.strictEqual(all.length, 3);

    const errors = cap.getConsoleErrors();
    assert.strictEqual(errors.length, 2); // error + warn
  });

  it('filters console by level', () => {
    const cap = makeCap();
    cap.addConsoleEntry({ level: 'error', message: 'err' });
    cap.addConsoleEntry({ level: 'log', message: 'log' });
    cap.addConsoleEntry({ level: 'warn', message: 'warn' });

    const errorsOnly = cap.getConsoleEntries({ level: 'error' });
    assert.strictEqual(errorsOnly.length, 1);
    assert.strictEqual(errorsOnly[0].message, 'err');
  });

  it('stores network entries', () => {
    const cap = makeCap();
    cap.addNetworkEntry({ method: 'GET', url: '/api/users', status: 200, duration: 50 });
    cap.addNetworkEntry({ method: 'POST', url: '/api/login', status: 401, duration: 100, responseBody: '{"error":"unauthorized"}' });
    cap.addNetworkEntry({ method: 'GET', url: '/api/data', status: 0, error: 'Network error' });

    const all = cap.getNetworkEntries({ limit: 10 });
    assert.strictEqual(all.length, 3);

    const errors = cap.getNetworkErrors();
    assert.strictEqual(errors.length, 2); // 401 + network error
  });

  it('filters slow network requests', () => {
    const cap = makeCap();
    cap.addNetworkEntry({ method: 'GET', url: '/fast', status: 200, duration: 50 });
    cap.addNetworkEntry({ method: 'GET', url: '/slow', status: 200, duration: 3000 });

    const slow = cap.getNetworkEntries({ slowOnly: true });
    assert.strictEqual(slow.length, 1);
    assert.strictEqual(slow[0].url, '/slow');
  });

  it('handles WebSocket messages', () => {
    const cap = makeCap();

    cap.handleMessage(JSON.stringify({ type: 'console', level: 'error', message: 'test error' }));
    cap.handleMessage(JSON.stringify({ type: 'network', method: 'GET', url: '/api', status: 500 }));
    cap.handleMessage(JSON.stringify({ type: 'error', message: 'unhandled', source: 'app.js:10:5' }));

    assert.strictEqual(cap.consoleEntries.length, 2); // console + error → both go to console
    assert.strictEqual(cap.networkEntries.length, 1);
  });

  it('handles screenshot data', () => {
    const cap = makeCap();
    assert.strictEqual(cap.getScreenshot(), null);

    cap.setScreenshot('data:image/jpeg;base64,abc123');
    const ss = cap.getScreenshot();
    assert.ok(ss);
    assert.ok(ss.data.includes('abc123'));
    assert.ok(ss.age < 1000);
  });

  it('getSummary returns structured data', () => {
    const cap = makeCap();
    cap.addConsoleEntry({ level: 'error', message: 'err1' });
    cap.addConsoleEntry({ level: 'warn', message: 'warn1' });
    cap.addNetworkEntry({ method: 'GET', url: '/fail', status: 500 });
    cap.addNetworkEntry({ method: 'GET', url: '/slow', status: 200, duration: 2000 });

    const summary = cap.getSummary();
    assert.strictEqual(summary.console.errors, 1);
    assert.strictEqual(summary.console.warnings, 1);
    assert.strictEqual(summary.network.failed, 1);
    assert.strictEqual(summary.network.slow, 1);
  });

  it('caps buffer at max entries', () => {
    const cap = makeCap();
    for (let i = 0; i < 600; i++) {
      cap.addConsoleEntry({ level: 'log', message: `msg ${i}` });
    }
    assert.strictEqual(cap.consoleEntries.length, 500);
  });

  it('clear() resets all buffers', () => {
    const cap = makeCap();
    cap.addConsoleEntry({ level: 'log', message: 'test' });
    cap.addNetworkEntry({ method: 'GET', url: '/', status: 200 });
    cap.setScreenshot('data:image/png;base64,abc');

    cap.clear();
    assert.strictEqual(cap.consoleEntries.length, 0);
    assert.strictEqual(cap.networkEntries.length, 0);
    assert.strictEqual(cap.getScreenshot(), null);
  });
});
