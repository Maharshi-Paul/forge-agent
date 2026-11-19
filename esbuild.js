const esbuild = require('esbuild');
const path = require('node:path');

const watch = process.argv.includes('--watch');

const options = {
  absWorkingDir: __dirname,
  entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: path.join(__dirname, 'dist', 'extension.js'),
  sourcemap: true,
  logLevel: 'info'
};

async function main() {
  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    console.log('Watching extension sources...');
    return;
  }

  await esbuild.build(options);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
