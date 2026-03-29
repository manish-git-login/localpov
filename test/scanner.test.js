const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { checkPort, scanPorts, detectFramework, COMMON_PORTS } = require('../dist/utils/scanner');

describe('scanner', () => {
  let server;
  let serverPort;

  before((_, done) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>hello</body></html>');
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      done();
    });
  });

  after((_, done) => {
    server.close(done);
  });

  it('COMMON_PORTS is an array of numbers', () => {
    assert.ok(Array.isArray(COMMON_PORTS));
    assert.ok(COMMON_PORTS.length > 0);
    for (const p of COMMON_PORTS) {
      assert.strictEqual(typeof p, 'number');
    }
  });

  it('checkPort returns false for a port with no server', async () => {
    // Use a port that is extremely unlikely to be in use
    const result = await checkPort(19999);
    assert.strictEqual(result, false);
  });

  it('checkPort returns true for a port with a running server', async () => {
    const result = await checkPort(serverPort);
    assert.strictEqual(result, true);
  });

  it('scanPorts returns only open ports', async () => {
    const results = await scanPorts([serverPort, 19999]);
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].port, serverPort);
    assert.ok(typeof results[0].framework === 'string');
  });

  it('detectFramework returns a framework name', async () => {
    const name = await detectFramework(serverPort);
    assert.ok(typeof name === 'string');
    assert.ok(name.length > 0);
  });
});
