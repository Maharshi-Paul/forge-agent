const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const root = process.cwd();
const flaskDirectory = join(root, 'flask');
const revision = '22d92470';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(flaskDirectory)) {
  run('git', ['clone', 'https://github.com/pallets/flask.git', 'flask']);
}

run('git', ['-C', flaskDirectory, 'fetch', '--tags', 'origin']);
run('git', ['-C', flaskDirectory, 'checkout', '--detach', revision]);
console.log(`Flask demo workspace is ready at ${flaskDirectory} (${revision}).`);
