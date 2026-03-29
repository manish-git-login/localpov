'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../dist/collectors/build-parser');

describe('build-parser', () => {
  it('parses TypeScript errors (paren format)', () => {
    const text = `src/App.tsx(42,5): error TS2322: Type 'string' is not assignable to type 'number'.`;
    const errors = parse(text);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].file, 'src/App.tsx');
    assert.strictEqual(errors[0].line, 42);
    assert.strictEqual(errors[0].col, 5);
    assert.strictEqual(errors[0].code, 'TS2322');
    assert.strictEqual(errors[0].parser, 'typescript');
  });

  it('parses TypeScript errors (colon format)', () => {
    const text = `src/api.ts:15:3 - error TS2345: Argument of type 'string' is not assignable.`;
    const errors = parse(text);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].file, 'src/api.ts');
    assert.strictEqual(errors[0].line, 15);
  });

  it('parses ESLint errors', () => {
    const text = `  /home/user/app/src/App.js:10:5  error  Unexpected console statement  no-console`;
    const errors = parse(text);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].line, 10);
    assert.strictEqual(errors[0].code, 'no-console');
    assert.strictEqual(errors[0].parser, 'eslint');
  });

  it('parses webpack module not found', () => {
    const text = `Module not found: Error: Can't resolve 'lodash' in '/app/src'`;
    const errors = parse(text);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes("Can't resolve 'lodash'"));
    assert.strictEqual(errors[0].parser, 'webpack');
  });

  it('parses Go errors', () => {
    const text = `./main.go:42:5: cannot use "hello" (untyped string constant) as int`;
    const errors = parse(text);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].file, './main.go');
    assert.strictEqual(errors[0].line, 42);
    assert.strictEqual(errors[0].parser, 'go');
  });

  it('parses Rust errors', () => {
    const text = `error[E0308]: mismatched types\n --> src/main.rs:42:5`;
    const errors = parse(text);
    assert.ok(errors.length >= 1);
    // After merge, should have file + message
    const merged = errors.find(e => e.file === 'src/main.rs');
    assert.ok(merged, 'Should find merged rust error with file location');
  });

  it('parses Python errors', () => {
    const text = `  File "app.py", line 42, in <module>\nNameError: name 'foo' is not defined`;
    const errors = parse(text);
    assert.ok(errors.length >= 1);
    assert.ok(errors.some(e => e.parser === 'python'));
  });

  it('deduplicates same file+line errors', () => {
    const text = [
      `src/App.tsx(42,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
      `src/App.tsx(42,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
    ].join('\n');
    const errors = parse(text);
    assert.strictEqual(errors.length, 1);
  });

  it('returns empty array for clean output', () => {
    const text = `Starting dev server...\nListening on port 3000\nReady in 250ms`;
    const errors = parse(text);
    assert.strictEqual(errors.length, 0);
  });
});
