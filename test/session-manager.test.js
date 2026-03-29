'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SessionManager } = require('../dist/utils/session-manager');

// Use a temp directory for tests
const TEST_SESSION_DIR = path.join(os.tmpdir(), `localpov-test-sessions-${process.pid}`);

// Monkey-patch SESSION_DIR for testing
const sessionMod = require('../dist/utils/session-manager');

describe('SessionManager', () => {
  let mgr;
  let origSessionDir;

  beforeEach(() => {
    // Override SESSION_DIR by creating sessions in temp dir
    fs.mkdirSync(TEST_SESSION_DIR, { recursive: true });
    mgr = new SessionManager();
    // We'll write test files directly to the module's SESSION_DIR
    // For isolated testing, we write to a known location and read from there
  });

  afterEach(() => {
    mgr.destroy();
    // Clean up test files
    try {
      const files = fs.readdirSync(TEST_SESSION_DIR);
      for (const f of files) fs.unlinkSync(path.join(TEST_SESSION_DIR, f));
      fs.rmdirSync(TEST_SESSION_DIR);
    } catch {}
  });

  describe('_stripAnsi (via readSession)', () => {
    it('strips ANSI escape codes from content', () => {
      // Test the internal strip function indirectly
      const mgr2 = new SessionManager();
      // Create a fake session in the real session dir
      const { SESSION_DIR } = require('../dist/utils/session-manager');
      const fakePid = 99999999;
      const metaPath = path.join(SESSION_DIR, `${fakePid}.meta`);
      const logPath = path.join(SESSION_DIR, `${fakePid}.log`);

      try {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        fs.writeFileSync(metaPath, JSON.stringify({
          pid: fakePid, shell: 'bash', cwd: '/tmp', started: Date.now() / 1000,
        }));
        fs.writeFileSync(logPath, '\x1b[32mGreen text\x1b[0m\nPlain text\n');

        const result = mgr2.readSession(fakePid, { lines: 10 });
        assert.ok(!result.error, 'Should not error');
        const joined = result.lines.join('\n');
        assert.ok(joined.includes('Green text'), 'Should contain text');
        assert.ok(!joined.includes('\x1b[32m'), 'Should strip ANSI');
      } finally {
        try { fs.unlinkSync(metaPath); } catch {}
        try { fs.unlinkSync(logPath); } catch {}
      }
    });
  });

  describe('_parseMarkers', () => {
    it('parses command boundaries from markers', () => {
      const { SESSION_DIR } = require('../dist/utils/session-manager');
      const fakePid = 99999998;
      const metaPath = path.join(SESSION_DIR, `${fakePid}.meta`);
      const logPath = path.join(SESSION_DIR, `${fakePid}.log`);

      const ts = Math.floor(Date.now() / 1000);
      const content = [
        `\x1b]localpov;cmd-start;npm run dev;${ts}\x07`,
        'Starting dev server...',
        'Listening on port 3000',
        `\x1b]localpov;cmd-end;0;${ts + 5}\x07`,
        `\x1b]localpov;cmd-start;npm test;${ts + 10}\x07`,
        'FAIL src/app.test.js',
        'Error: expected true to be false',
        `\x1b]localpov;cmd-end;1;${ts + 15}\x07`,
      ].join('\n');

      try {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        fs.writeFileSync(metaPath, JSON.stringify({
          pid: fakePid, shell: 'bash', cwd: '/tmp', started: ts,
        }));
        fs.writeFileSync(logPath, content);

        const result = mgr.readSession(fakePid, { lines: 50 });
        assert.ok(!result.error);
        assert.strictEqual(result.commands.length, 2);
        assert.strictEqual(result.commands[0].command, 'npm run dev');
        assert.strictEqual(result.commands[0].exitCode, 0);
        assert.strictEqual(result.commands[1].command, 'npm test');
        assert.strictEqual(result.commands[1].exitCode, 1);
      } finally {
        try { fs.unlinkSync(metaPath); } catch {}
        try { fs.unlinkSync(logPath); } catch {}
      }
    });
  });

  describe('getErrors', () => {
    it('detects common error patterns', () => {
      const { SESSION_DIR } = require('../dist/utils/session-manager');
      const fakePid = 99999997;
      const metaPath = path.join(SESSION_DIR, `${fakePid}.meta`);
      const logPath = path.join(SESSION_DIR, `${fakePid}.log`);

      const content = [
        'Starting server...',
        'TypeError: Cannot read property "map" of undefined',
        '    at Object.<anonymous> (src/app.js:42:10)',
        'npm ERR! code ELIFECYCLE',
        'normal line here',
        'error TS2322: Type "string" is not assignable to type "number"',
      ].join('\n');

      try {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        fs.writeFileSync(metaPath, JSON.stringify({
          pid: fakePid, shell: 'bash', cwd: '/tmp',
          started: Math.floor(Date.now() / 1000),
        }));
        fs.writeFileSync(logPath, content);

        const errors = mgr.getErrors();
        const sessionErrors = errors.filter(e => e.pid === fakePid);
        assert.ok(sessionErrors.length >= 3, `Expected at least 3 errors, got ${sessionErrors.length}`);

        const texts = sessionErrors.map(e => e.text);
        assert.ok(texts.some(t => t.includes('TypeError')), 'Should detect TypeError');
        assert.ok(texts.some(t => t.includes('npm ERR')), 'Should detect npm ERR');
        assert.ok(texts.some(t => t.includes('TS2322')), 'Should detect TS error');
      } finally {
        try { fs.unlinkSync(metaPath); } catch {}
        try { fs.unlinkSync(logPath); } catch {}
      }
    });
  });

  describe('getDiagnostics', () => {
    it('returns structured diagnostics summary', () => {
      const diag = mgr.getDiagnostics();
      assert.ok(diag.sessions);
      assert.ok(typeof diag.sessions.active === 'number');
      assert.ok(typeof diag.sessions.total === 'number');
      assert.ok(diag.errors);
      assert.ok(typeof diag.errors.total === 'number');
      assert.ok(diag.summary);
      assert.ok(typeof diag.summary === 'string');
    });
  });

  describe('searchAll', () => {
    it('returns error for invalid regex', () => {
      const result = mgr.searchAll('[invalid');
      assert.ok(result.error);
      assert.ok(result.error.includes('Invalid regex'));
    });
  });

  describe('readCommand', () => {
    it('supports negative indexing', () => {
      const { SESSION_DIR } = require('../dist/utils/session-manager');
      const fakePid = 99999996;
      const metaPath = path.join(SESSION_DIR, `${fakePid}.meta`);
      const logPath = path.join(SESSION_DIR, `${fakePid}.log`);

      const ts = Math.floor(Date.now() / 1000);
      const content = [
        `\x1b]localpov;cmd-start;echo hello;${ts}\x07`,
        'hello',
        `\x1b]localpov;cmd-end;0;${ts + 1}\x07`,
        `\x1b]localpov;cmd-start;echo world;${ts + 2}\x07`,
        'world',
        `\x1b]localpov;cmd-end;0;${ts + 3}\x07`,
      ].join('\n');

      try {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        fs.writeFileSync(metaPath, JSON.stringify({
          pid: fakePid, shell: 'bash', cwd: '/tmp', started: ts,
        }));
        fs.writeFileSync(logPath, content);

        const last = mgr.readCommand(fakePid, -1);
        assert.ok(!last.error);
        assert.strictEqual(last.command, 'echo world');
        assert.ok(last.output.includes('world'));

        const first = mgr.readCommand(fakePid, 0);
        assert.strictEqual(first.command, 'echo hello');
      } finally {
        try { fs.unlinkSync(metaPath); } catch {}
        try { fs.unlinkSync(logPath); } catch {}
      }
    });
  });

  describe('listSessions', () => {
    it('returns an array', () => {
      const sessions = mgr.listSessions();
      assert.ok(Array.isArray(sessions));
    });
  });
});
