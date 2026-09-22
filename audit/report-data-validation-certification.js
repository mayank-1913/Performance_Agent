'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

function main() {
  const testFile = path.join(__dirname, '..', 'apps', 'api', 'test', 'reportDataValidation.test.js');
  const proc = spawnSync(process.execPath, ['--test', testFile], { encoding: 'utf8' });
  const pass = proc.status === 0;
  console.log(
    JSON.stringify(
      {
        pass,
        suite: 'reportDataValidation.test.js',
        exitCode: proc.status,
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
      null,
      2
    )
  );
  if (!pass) process.exitCode = 1;
}

main();
