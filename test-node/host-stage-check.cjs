'use strict';
// Structural pre-commit evidence only. Toy executable; never an official build.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const L = require('../packaging/lib.cjs');
const crate = path.resolve(__dirname, '..');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-host-stage-fixture-'));
try {
  fs.writeFileSync(path.join(stage, 'abito-island'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stage, 'abito-island-launcher'), L.launcherText(), { mode: 0o755 });
  fs.writeFileSync(path.join(stage, 'abito-island.png'), fs.readFileSync(path.join(crate, 'icons/icon.png')), { mode: 0o644 });
  fs.writeFileSync(path.join(stage, `${L.IDENTIFIER}.desktop`), L.desktopText(), { mode: 0o644 });
  for (const file of L.DAEMON_FILES) {
    const target = path.join(stage, 'desktop-daemon', file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(crate, '../desktop-daemon', file), target);
    fs.chmodSync(target, 0o644);
  }
  const receipt = {
    fixture: 'PRE-COMMIT STRUCTURAL TEST ONLY; toy executable, synthetic provenance, NOT RELEASE EVIDENCE',
    identifier: L.IDENTIFIER, version: L.checkConfig(crate).version,
    format: 'A user-local', r6_sha256: L.checkR6(crate),
    provenance: { head: 'a'.repeat(40), clean: true, dirty_entries: 0 },
    files: Object.fromEntries(L.STAGED.map(f => [f, L.sha256File(path.join(stage, f))])),
  };
  fs.writeFileSync(path.join(stage, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o644 });
  assert.deepEqual(L.verifyStage(stage), []);
  console.log(receipt.fixture);
  console.log('STAGED=' + JSON.stringify(L.STAGED));
  for (const file of [...L.STAGED, 'receipt.json']) console.log(`${(fs.lstatSync(path.join(stage, file)).mode & 0o777).toString(8)} ${file}`);
  console.log('RECEIPT=' + JSON.stringify(receipt, null, 2));
  const result = cp.spawnSync(process.execPath, [path.join(crate, 'packaging/verify.cjs'), stage], { encoding: 'utf8' });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.equal(result.status, 0);
  console.log('verify_exit=' + result.status);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
