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
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ identifier: L.IDENTIFIER, r6_sha256: L.checkR6(crate), provenance: { head: 'a'.repeat(40), clean: true }, files }));
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
test('launcher: no args, refuses whole env families, forces X11, execs only its sibling binary', () => {
  const t = L.launcherText();
  assert.match(t, /\[ "\$#" -eq 0 \]/);
  assert.match(t, /export GDK_BACKEND=x11/);
  assert.match(t, /exec "\$here\/abito-island"$/m);
  // behaviour: run the launcher's guards (the sibling binary is a stub that must NOT start when refused)
  const cp = require('node:child_process');
  const d = fakeStage(); fs.writeFileSync(path.join(d, 'abito-island'), '#!/bin/sh\necho STARTED\n', { mode: 0o755 });
  const run = (extra, env) => cp.spawnSync(path.join(d, 'abito-island-launcher'), extra, { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(run(['--devtools'], {}).status, 64);
  for (const name of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_BIND_NOW', 'LD_ANYTHING_ELSE', 'GDK_DEBUG', 'GTK_MODULES',
    'WEBKIT_INSPECTOR_SERVER', 'ABITO_PROBE', 'ABITO_PROBE_VISUAL_DIR', 'ABITO_SOCKET_DIR', 'ABITO_BRIDGE_BASE', 'ABITO_MODELS_CONFIG_DIR',
    'ABITO_DESKTOP_SOCKET', 'ABITO_NATIVE_AUDIT', 'ABITO_NATIVE_VIEW_TEST']) {
    const r = run([], { [name]: '1' });
    assert.equal(r.status, 64, name);
    assert.doesNotMatch(r.stdout, /STARTED/, name);
    assert.match(r.stderr, new RegExp(`refusing ${name}`), name);
  }
  assert.equal(run([], { LDXYZ_NOT_LD: '1', LANG: 'C', HOME: '/x' }).status, 0, 'unrelated variables pass');
  const ok = run([], { ABITO_PROJECT_ROOT: '/somewhere' }); assert.equal(ok.status, 0, 'ABITO_PROJECT_ROOT is the one allowed knob'); assert.match(ok.stdout, /STARTED/);
  fs.rmSync(d, { recursive: true });
});
test('provenance gate: a dirty or untracked product file fails; a clean tree passes (real git repo)', () => {
  const cp = require('node:child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-git-'));
  const git = (...a) => cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'x');
  const clean = L.requireClean(repo); assert.match(clean.head, /^[0-9a-f]{40}$/); assert.equal(clean.clean, true);
  fs.writeFileSync(path.join(repo, 'a.txt'), '2'); assert.throws(() => L.requireClean(repo), /not clean/);
  git('checkout', '--', 'a.txt'); assert.equal(L.requireClean(repo).clean, true);
  fs.writeFileSync(path.join(repo, 'new.rs'), 'x'); assert.throws(() => L.requireClean(repo), /not clean/);
  fs.rmSync(repo, { recursive: true });
});
test('verify: a receipt without HEAD / clean attestation fails', () => {
  const d = fakeStage(); const r = JSON.parse(fs.readFileSync(path.join(d, 'receipt.json'), 'utf8'));
  delete r.provenance; fs.writeFileSync(path.join(d, 'receipt.json'), JSON.stringify(r));
  assert.match(L.verifyStage(d).join(), /no git HEAD/); fs.rmSync(d, { recursive: true });
});
test('identity never collides with the installed apps', () => {
  assert.match(L.desktopText(), /Exec=@INSTALL_DIR@\/abito-island-launcher/);
  assert.doesNotMatch(L.desktopText() + L.launcherText(), /abito-desktop|com\.abitog\.Abito\b(?!Tauri)/);
});
console.log(`packaging-check: ${passed} passed`);
