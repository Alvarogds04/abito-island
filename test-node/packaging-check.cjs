'use strict';
/* M4 format A: checks for packaging/lib.cjs without building or launching
   anything (a fake stage dir). Run: node apps/desktop-tauri/test-node/packaging-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../packaging/lib.cjs');
const crate = path.resolve(__dirname, '..');
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };

test('source gates pass on the real crate (R6 pin, curated frontend, config, capabilities, no devtools)', () => {
  assert.ok(L.checkR6(crate).startsWith('e2dc5db3'));
  assert.equal(L.checkFrontend(crate).length, L.FRONTEND_FILES.length);
  const cfg = L.checkConfig(crate);
  assert.equal(cfg.identifier, 'com.abitog.AbitoTauri');
});

function copyCrate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-pkg-'));
  for (const f of ['tauri.conf.json', 'Cargo.toml']) fs.copyFileSync(path.join(crate, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'capabilities')); fs.copyFileSync(path.join(crate, 'capabilities', 'main.json'), path.join(dir, 'capabilities', 'main.json'));
  fs.mkdirSync(path.join(dir, 'frontend'));
  for (const f of L.FRONTEND_FILES) fs.copyFileSync(path.join(crate, 'frontend', f), path.join(dir, 'frontend', f));
  return dir;
}
test('each gate FAILS when its rule is broken', () => {
  const edit = (rel, fn, expect) => {
    const d = copyCrate();
    const p = path.join(d, rel); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
    assert.throws(() => (rel.startsWith('frontend') && rel.endsWith('clay-engine.js') ? L.checkR6(d) : L.checkConfig(d)), expect, rel);
    fs.rmSync(d, { recursive: true });
  };
  edit('frontend/clay-engine.js', s => s + '\n// tweak', /R6 pin/);
  edit('tauri.conf.json', s => s.replace("default-src 'self'", "default-src 'self' https://evil.example"), /CSP/);
  edit('tauri.conf.json', s => s.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), /CSP/);
  edit('tauri.conf.json', s => s.replace('com.abitog.AbitoTauri', 'com.abitog.Abito.Preview'), /identifier/);
  edit('capabilities/main.json', s => s.replace('"core:event:allow-unlisten"', '"core:event:allow-unlisten", "core:window:allow-close"'), /capabilities drifted/);
  edit('Cargo.toml', s => s.replace('tauri = { version = "2", features = [] }', 'tauri = { version = "2", features = ["devtools"] }'), /devtools/);
  const d = copyCrate(); fs.writeFileSync(path.join(d, 'frontend', 'extra.js'), '1');
  assert.throws(() => L.checkFrontend(d), /curated list/); fs.rmSync(d, { recursive: true });
});

function fakeStage({ crateDir = crate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-stage-'));
  fs.writeFileSync(path.join(dir, 'abito-island'), '#!/bin/true\nfake binary\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'abito-island-launcher'), L.launcherText(), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, `${L.IDENTIFIER}.desktop`), L.desktopText(), { mode: 0o644 });
  const files = {};
  for (const n of L.STAGED) files[n] = L.sha256File(path.join(dir, n));
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ identifier: L.IDENTIFIER, r6_sha256: L.checkR6(crate), files }));
  return dir;
}
test('verify: a pristine stage passes; tampering is caught without launching anything', () => {
  const d = fakeStage();
  assert.deepEqual(L.verifyStage(d, { sourceCrate: crate }), []);
  fs.appendFileSync(path.join(d, 'abito-island'), 'x');
  assert.match(L.verifyStage(d).join(), /abito-island hash differs/);
  fs.rmSync(d, { recursive: true });
  const e = fakeStage();
  fs.writeFileSync(path.join(e, 'abito-island-launcher'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  assert.match(L.verifyStage(e).join(), /launcher/);
  fs.writeFileSync(path.join(e, 'extra'), 'x');
  assert.match(L.verifyStage(e).join(), /unexpected stage entries/);
  fs.rmSync(e, { recursive: true });
  const w = fakeStage(); fs.chmodSync(path.join(w, 'abito-island'), 0o777);
  assert.match(L.verifyStage(w).join(), /writable/);
  fs.rmSync(w, { recursive: true });
});
test('verify: devtools markers and an embedded source-tree path fail the stage', () => {
  for (const [marker, expect] of [['--remote-debugging-port', /devtools/], [crate, /source-tree path/]]) {
    const d = fakeStage();
    fs.writeFileSync(path.join(d, 'abito-island'), `#!/bin/true\n${marker}\n`, { mode: 0o755 });
    const r = JSON.parse(fs.readFileSync(path.join(d, 'receipt.json'), 'utf8')); r.files['abito-island'] = L.sha256File(path.join(d, 'abito-island'));
    fs.writeFileSync(path.join(d, 'receipt.json'), JSON.stringify(r));
    assert.match(L.verifyStage(d, { sourceCrate: crate }).join(), expect);
    fs.rmSync(d, { recursive: true });
  }
});
test('launcher: no args, refuses loader/debug overrides and probe flags, forces X11, execs only its sibling binary', () => {
  const t = L.launcherText();
  assert.match(t, /\[ "\$#" -eq 0 \]/);
  for (const name of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'GDK_DEBUG', 'ABITO_PROBE', 'WEBKIT_INSPECTOR_SERVER']) assert.match(t, new RegExp(`refusing ${name}`));
  assert.match(t, /export GDK_BACKEND=x11/);
  assert.match(t, /exec "\$here\/abito-island"$/m);
  // behaviour: actually run the launcher's guards (the sibling binary is a stub that must NOT start)
  const cp = require('node:child_process');
  const d = fakeStage(); fs.writeFileSync(path.join(d, 'abito-island'), '#!/bin/sh\necho STARTED\n', { mode: 0o755 });
  const run = (extra, env) => cp.spawnSync(path.join(d, 'abito-island-launcher'), extra, { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(run(['--devtools'], {}).status, 64);
  assert.equal(run([], { LD_PRELOAD: '/x.so' }).status, 64);
  assert.equal(run([], { ABITO_PROBE: '1' }).status, 64);
  const ok = run([], {}); assert.equal(ok.status, 0); assert.match(ok.stdout, /STARTED/);
  fs.rmSync(d, { recursive: true });
});
test('identity never collides with the installed apps', () => {
  assert.match(L.desktopText(), /Exec=@INSTALL_DIR@\/abito-island-launcher/);
  assert.doesNotMatch(L.desktopText() + L.launcherText(), /abito-desktop|com\.abitog\.Abito\b(?!Tauri)/);
});
console.log(`packaging-check: ${passed} passed`);
