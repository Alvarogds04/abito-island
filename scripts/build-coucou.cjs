'use strict';
// Offline build: never downloads a compiler or reads the external reference tree.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../frontend/vendor/coucou');
const compiler = process.env.ESBUILD_BINARY_PATH || '/home/alvaro/.pi/agent/npm/node_modules/@esbuild/linux-x64/bin/esbuild';
const inputs = ['settings/colors', 'settings/parts', 'core/pill-colors', 'views/dom', 'i18n/i18n'];
if (!fs.existsSync(compiler)) throw new Error('Falta esbuild local: indicar ESBUILD_BINARY_PATH; no se instalará nada.');
const version = execFileSync(compiler, ['--version'], { encoding: 'utf8' }).trim();
if (version !== '0.28.2') throw new Error(`esbuild ${version}: se requiere 0.28.2 para salida reproducible`);
for (const file of inputs) {
  const source = fs.readFileSync(path.join(root, `${file}.ts`), 'utf8');
  const banner = source.split('\n')[0];
  execFileSync(compiler, [`${file}.ts`, '--format=esm', '--target=es2021', '--charset=utf8', '--legal-comments=inline', `--banner:js=${banner}`, `--outfile=${file}.js`, '--log-level=error'], { cwd: root, stdio: 'inherit' });
}
console.log(`Built ${inputs.length} MIT/Abito modules with esbuild ${version} (offline)`);
