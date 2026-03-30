const { readdirSync } = require('fs');
const { execSync } = require('child_process');
const { join } = require('path');

const dir = join(__dirname);
const files = readdirSync(dir)
  .filter(f => f.endsWith('.test.js'))
  .map(f => join(dir, f));

if (files.length === 0) {
  console.log('No test files found');
  process.exit(0);
}

execSync(`node --test ${files.join(' ')}`, { stdio: 'inherit' });
