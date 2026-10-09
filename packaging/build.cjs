#!/usr/bin/env node
'use strict';
/* M4 format A build: OFFLINE release build + stage + receipt. Stages files
   only: it installs nothing, touches no installed app and never launches the
   binary. Usage: node packaging/build.cjs [--out <dir>] [--skip-cargo]
   (--skip-cargo reuses target/release/abito-island, for re-staging). */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const L = require('./lib.cjs');

const crate = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outRoot = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(crate, 'dist'));

const r6 = L.checkR6(crate);
L.checkFrontend(crate);
const cfg = L.checkConfig(crate);
if (!args.includes('--skip-cargo')) {
  const r = cp.spawnSync('cargo', ['build', '--release', '--locked', '--offline', '--features', 'tauri/custom-protocol'], { cwd: crate, stdio: 'inherit' });
  if (r.status !== 0) { console.error('cargo build failed (offline: no download is attempted)'); process.exit(1); }
}
const built = path.join(crate, 'target', 'release', 'abito-island');
if (!fs.existsSync(built)) { console.error('release binary missing'); process.exit(1); }

const stage = path.join(outRoot, 'abito-island', cfg.version);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true, mode: 0o755 });
fs.copyFileSync(built, path.join(stage, 'abito-island'));
fs.chmodSync(path.join(stage, 'abito-island'), 0o755);
fs.writeFileSync(path.join(stage, 'abito-island-launcher'), L.launcherText(), { mode: 0o755 });
fs.writeFileSync(path.join(stage, `${L.IDENTIFIER}.desktop`), L.desktopText(), { mode: 0o644 });

const rustc = cp.spawnSync('rustc', ['--version'], { encoding: 'utf8' }).stdout.trim();
const files = {};
for (const name of L.STAGED) files[name] = L.sha256File(path.join(stage, name));
const receipt = {
  identifier: L.IDENTIFIER, version: cfg.version, format: 'A user-local', rustc,
  r6_sha256: r6, files,
  inputs: {
    'Cargo.lock': L.sha256File(path.join(crate, 'Cargo.lock')),
    'tauri.conf.json': L.sha256File(path.join(crate, 'tauri.conf.json')),
    'capabilities/main.json': L.sha256File(path.join(crate, 'capabilities', 'main.json')),
    frontend: Object.fromEntries(L.FRONTEND_FILES.map(f => [f, L.sha256File(path.join(crate, 'frontend', f))])),
  },
  csp: cfg.csp,
  note: 'Staged only. Nothing installed, no installed app touched, never launched by the build.',
};
fs.writeFileSync(path.join(stage, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o644 });
const problems = L.verifyStage(stage, { sourceCrate: crate });
if (problems.length) { console.error('verify failed:\n - ' + problems.join('\n - ')); process.exit(1); }
console.log(`staged ${stage}\nbinary sha256 ${files['abito-island']}`);
