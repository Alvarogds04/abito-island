'use strict';
// #487: the GNOME Shell extension and the Rust reader (src/contextwin.rs) agree on the D-Bus
// contract, and the extension stays read-only and local.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const dir = path.join(root, 'gnome-extension', 'abito-context@abito');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
const js = fs.readFileSync(path.join(dir, 'extension.js'), 'utf8');
const rs = fs.readFileSync(path.join(root, 'src', 'contextwin.rs'), 'utf8');
const rsConst = (n) => new RegExp(`pub const ${n}: &str = "([^"]+)"`).exec(rs)[1];

assert.strictEqual(meta.uuid, 'abito-context@abito');
assert.strictEqual(path.basename(dir), meta.uuid, 'directory name must equal the uuid');
assert.ok(meta['shell-version'].includes('50'), 'GNOME 50 is declared');
assert.strictEqual(rsConst('BUS_NAME'), 'org.abito.Context');
assert.ok(js.includes(`const BUS_NAME = '${rsConst('BUS_NAME')}'`));
assert.ok(js.includes(`const OBJECT_PATH = '${rsConst('OBJECT_PATH')}'`));
assert.ok(js.includes(`<interface name="${rsConst('INTERFACE')}">`));
assert.ok(js.includes(`<method name="${rsConst('METHOD')}">`));
assert.ok(js.includes('type="a(sss)"'));
assert.ok(js.includes(`${rsConst('METHOD')}()`));
// read-only and local: nothing that acts on windows, spawns, or reaches the network
for (const bad of ['activate(', 'kill', 'GLib.spawn', 'Soup', 'Gio.Subprocess', 'get_pid', 'win.get_id', 'get_stable_sequence', 'move_']) {
  assert.ok(!js.includes(bad), `extension must not use ${bad}`);
}
assert.ok(/Copyright \(c\) 2026 Louis Raillé, MIT/.test(js), 'citation present');
console.log('context-extension-check ok');
