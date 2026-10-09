'use strict';
/* M4 format A (user-local, no root, no download, system WebKitGTK): pure
   checks shared by build.cjs and verify.cjs. Contract:
   docs/desktop-packaging-plan.md §2/§4/§5. Nothing here installs anything or
   launches the app. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const R6_PREFIX = 'e2dc5db3';
const IDENTIFIER = 'com.abitog.AbitoTauri';
const RESERVED = ['com.abitog.Abito', 'com.abitog.Abito.Preview', 'abito-desktop', 'abito-desktop-preview'];
const FRONTEND_FILES = ['chat-view.js', 'chat.js', 'clay-engine.js', 'desktop.js', 'icons.js', 'index.html',
  'island.js', 'models.js', 'overview-view.js', 'style.css'];
const EXPECTED_PERMISSIONS = ['core:event:allow-listen', 'core:event:allow-unlisten'];
// Whole families are refused (not a hand-picked list): every LD_* loader
// variable, GTK/GDK/WebKit debug+inspector variables, and EVERY ABITO_* knob
// except the one the installed app is meant to receive (ABITO_PROJECT_ROOT).
const FORBIDDEN_ENV_PATTERN = '^(LD_[A-Za-z0-9_]*|GDK_DEBUG|GTK_DEBUG|GTK_MODULES|GTK_PATH|WEBKIT_INSPECTOR_[A-Za-z_]*|ABITO_(BRIDGE_BASE|DESKTOP_SOCKET|MODELS_CONFIG_DIR|NATIVE_[A-Z_]*|PROBE[A-Z_]*|SOCKET_DIR))=';
const FORBIDDEN_ENV = ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'GDK_DEBUG', 'GTK_DEBUG', 'GTK_MODULES',
  'WEBKIT_INSPECTOR_SERVER', 'ABITO_PROBE', 'ABITO_PROBE_VISUAL', 'ABITO_SOCKET_DIR', 'ABITO_BRIDGE_BASE',
  'ABITO_MODELS_CONFIG_DIR', 'ABITO_DESKTOP_SOCKET', 'ABITO_NATIVE_AUDIT'];

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = file => sha256(fs.readFileSync(file));

// ---- source checks (before building) ------------------------------------
function checkR6(crate) {
  const hash = sha256File(path.join(crate, 'frontend', 'clay-engine.js'));
  if (!hash.startsWith(R6_PREFIX)) throw new Error(`R6 pin failed: clay-engine.js is ${hash.slice(0, 8)}, expected ${R6_PREFIX}`);
  return hash;
}
function checkFrontend(crate) {
  const found = fs.readdirSync(path.join(crate, 'frontend')).sort();
  const extra = found.filter(f => !FRONTEND_FILES.includes(f));
  const missing = FRONTEND_FILES.filter(f => !found.includes(f));
  if (extra.length || missing.length) throw new Error(`frontend/ differs from the curated list: extra=[${extra}] missing=[${missing}]`);
  return found;
}
function checkConfig(crate) {
  const conf = JSON.parse(fs.readFileSync(path.join(crate, 'tauri.conf.json'), 'utf8'));
  if (conf.identifier !== IDENTIFIER) throw new Error(`identifier must be ${IDENTIFIER}`);
  if (RESERVED.includes(conf.identifier)) throw new Error('identifier collides with an installed app');
  const csp = (conf.app && conf.app.security && conf.app.security.csp) || '';
  if (!/default-src 'self'/.test(csp)) throw new Error("CSP must start from default-src 'self'");
  if (/unsafe-(eval|inline)|https?:\/\/(?!ipc\.localhost)|\*/.test(csp)) throw new Error('CSP allows unsafe or remote sources');
  if (conf.app.withGlobalTauri !== true) throw new Error('withGlobalTauri expected (the page uses window.__TAURI__)');
  const cap = JSON.parse(fs.readFileSync(path.join(crate, 'capabilities', 'main.json'), 'utf8'));
  const perms = [...cap.permissions].sort();
  if (JSON.stringify(perms) !== JSON.stringify([...EXPECTED_PERMISSIONS].sort())) throw new Error(`capabilities drifted: ${perms}`);
  const cargo = fs.readFileSync(path.join(crate, 'Cargo.toml'), 'utf8');
  const tauriLine = /^tauri = \{[^}]*\}/m.exec(cargo);
  if (!tauriLine) throw new Error('tauri dependency line not found');
  if (/devtools/.test(tauriLine[0]) || /devtools/.test(cargo)) throw new Error('the devtools feature must stay off');
  if (/shell|process|fs|http/.test(tauriLine[0])) throw new Error('no extra tauri features/plugins in the packaged app');
  if (/tauri-plugin-(shell|fs|http|process|opener)/.test(cargo)) throw new Error('forbidden plugin dependency');
  return { version: conf.version, identifier: conf.identifier, csp };
}

// ---- launcher / desktop entry (content is closed and hashed) -------------
function launcherText() {
  return `#!/bin/sh
# Abito (Tauri) launcher — M4 format A. Accepts no arguments, refuses the
# whole LD_* family, GTK/GDK/WebKit debug and inspector variables and every
# ABITO_* test/probe/override knob (only ABITO_PROJECT_ROOT passes), forces
# X11/XWayland (absolute positioning and always-on-top). Never touches the
# Preview's roots.
set -eu
[ "$#" -eq 0 ] || { echo "abito: no arguments accepted" >&2; exit 64; }
bad="$(env | grep -E '${FORBIDDEN_ENV_PATTERN}' | cut -d= -f1 | head -n 1 || true)"
[ -z "$bad" ] || { echo "abito: refusing $bad" >&2; exit 64; }
here="$(cd "$(dirname "$0")" && pwd)"
export GDK_BACKEND=x11
exec "$here/abito-island"
`;
}
function desktopText() {
  return `[Desktop Entry]
Type=Application
Name=Abito (Tauri)
Comment=Abito island (user-local build, side by side with the Preview)
Exec=@INSTALL_DIR@/abito-island-launcher
Terminal=false
Categories=Utility;
StartupWMClass=${IDENTIFIER}
`;
}

// ---- receipt verification (no launch) -------------------------------------
const STAGED = ['abito-island', 'abito-island-launcher', `${IDENTIFIER}.desktop`];
function verifyStage(dir, { sourceCrate } = {}) {
  const problems = [];
  const receiptPath = path.join(dir, 'receipt.json');
  if (!fs.existsSync(receiptPath)) return ['receipt.json missing'];
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (receipt.identifier !== IDENTIFIER) problems.push('receipt identifier mismatch');
  if (!String(receipt.r6_sha256 || '').startsWith(R6_PREFIX)) problems.push('receipt R6 pin mismatch');
  const prov = receipt.provenance || {};
  if (!/^[0-9a-f]{40}$/.test(prov.head || '')) problems.push('receipt has no git HEAD');
  if (prov.clean !== true) problems.push('receipt does not attest a clean tree');
  const entries = fs.readdirSync(dir).filter(f => f !== 'receipt.json').sort();
  if (JSON.stringify(entries) !== JSON.stringify([...STAGED].sort())) problems.push(`unexpected stage entries: ${entries}`);
  for (const name of STAGED) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { problems.push(`${name} missing`); continue; }
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) problems.push(`${name} is not a regular file`);
    if (stat.mode & 0o022) problems.push(`${name} is group/world writable`);
    if (sha256File(file) !== (receipt.files || {})[name]) problems.push(`${name} hash differs from the receipt`);
  }
  if (fs.existsSync(path.join(dir, 'abito-island-launcher')) && fs.readFileSync(path.join(dir, 'abito-island-launcher'), 'utf8') !== launcherText()) problems.push('launcher differs from the closed template');
  const desk = path.join(dir, `${IDENTIFIER}.desktop`);
  if (fs.existsSync(desk) && fs.readFileSync(desk, 'utf8') !== desktopText()) problems.push('desktop entry differs from the closed template');
  const bin = path.join(dir, 'abito-island');
  if (fs.existsSync(bin)) {
    const bytes = fs.readFileSync(bin);
    if (sourceCrate && bytes.includes(Buffer.from(sourceCrate))) problems.push('binary embeds the source-tree path');
    for (const marker of ['--remote-debugging', 'devtools://']) if (bytes.includes(Buffer.from(marker))) problems.push(`binary contains «${marker}» (devtools)`);
    if (!(fs.statSync(bin).mode & 0o100)) problems.push('binary is not executable');
  }
  return problems;
}

// ---- provenance ------------------------------------------------------------
const cp = require('node:child_process');
function git(crate, args) {
  const r = cp.spawnSync('git', args, { cwd: crate, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
/** The build must come from committed bytes: any tracked change OR untracked
 *  (non-ignored) file under the crate fails the gate. */
function provenance(crate) {
  const dirty = git(crate, ['status', '--porcelain', '--untracked-files=all', '--', '.']).split('\n').filter(Boolean);
  return { head: git(crate, ['rev-parse', 'HEAD']).trim(), clean: dirty.length === 0, dirty };
}
function requireClean(crate) {
  const p = provenance(crate);
  if (!p.clean) throw new Error(`working tree is not clean under the product paths (${p.dirty.length} entries); build from a clean checkout:\n  ${p.dirty.slice(0, 8).join('\n  ')}`);
  return p;
}

module.exports = { provenance, requireClean, FORBIDDEN_ENV_PATTERN, R6_PREFIX, IDENTIFIER, FRONTEND_FILES, EXPECTED_PERMISSIONS, FORBIDDEN_ENV, STAGED, sha256, sha256File,
  checkR6, checkFrontend, checkConfig, launcherText, desktopText, verifyStage };
