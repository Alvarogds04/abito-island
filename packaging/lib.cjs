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
  'island.js', 'models.js', 'notify-view.js', 'notify.js', 'overview-view.js', 'settings-view.js', 'settings.js', 'sound-engine.js', 'sound-wiring.js', 'style.css'];
const EXPECTED_PERMISSIONS = ['core:event:allow-listen', 'core:event:allow-unlisten'];
// Inverted logic: EVERY ABITO_* variable is refused except the one the
// installed app is meant to receive (ABITO_PROJECT_ROOT); plus the whole LD_*
// loader family and the GTK/GDK/WebKit debug + inspector variables.
const FORBIDDEN_ENV_PATTERN = '^(LD_[A-Za-z0-9_]*|GDK_(DEBUG|SYNCHRONIZE|RENDERING)|GTK_(DEBUG|MODULES|PATH|EXE_PREFIX|DATA_PREFIX)|WEBKIT_INSPECTOR_[A-Za-z_]*|ABITO_[A-Za-z0-9_]*)=';
const ALLOWED_ABITO = 'ABITO_PROJECT_ROOT';

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
// The gate's contract is to FAIL on drift, but a bare SyntaxError does not say
// WHICH file drifted, and these fixtures are copied around by the tests. Read,
// name the file, rethrow: fail-fast stays, the message becomes actionable.
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`cannot read ${file}: ${e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
}

function checkConfig(crate) {
  const conf = readJson(path.join(crate, 'tauri.conf.json'));
  if (conf.identifier !== IDENTIFIER) throw new Error(`identifier must be ${IDENTIFIER}`);
  if (RESERVED.includes(conf.identifier)) throw new Error('identifier collides with an installed app');
  const csp = (conf.app && conf.app.security && conf.app.security.csp) || '';
  if (!/default-src 'self'/.test(csp)) throw new Error("CSP must start from default-src 'self'");
  if (/unsafe-(eval|inline)|https?:\/\/(?!ipc\.localhost)|\*/.test(csp)) throw new Error('CSP allows unsafe or remote sources');
  const connect = (/connect-src ([^;]*)/.exec(csp) || [])[1];
  if (connect !== "'self' ipc: http://ipc.localhost") throw new Error(`connect-src must be exactly 'self' ipc: http://ipc.localhost, got: ${connect}`);
  if (!/(^|;)\s*object-src 'none'/.test(csp) || !/frame-src 'none'/.test(csp) || !/base-uri 'none'/.test(csp)) throw new Error('CSP must keep object-src/frame-src/base-uri none');
  if (conf.app.withGlobalTauri !== true) throw new Error('withGlobalTauri expected (the page uses window.__TAURI__)');
  const cap = readJson(path.join(crate, 'capabilities', 'main.json'));
  const perms = [...cap.permissions].sort();
  if (JSON.stringify(perms) !== JSON.stringify([...EXPECTED_PERMISSIONS].sort())) throw new Error(`capabilities drifted: ${perms}`);
  const cargo = fs.readFileSync(path.join(crate, 'Cargo.toml'), 'utf8');
  const tauriLine = /^tauri = \{[^}]*\}/m.exec(cargo);
  if (!tauriLine) throw new Error('tauri dependency line not found');
  if (/devtools/.test(tauriLine[0]) || /devtools/.test(cargo)) throw new Error('the devtools feature must stay off');
  if (/shell|process|fs|http/.test(tauriLine[0])) throw new Error('no extra tauri features/plugins in the packaged app');
  if (/tauri-plugin-(shell|fs|http|process|opener)/.test(cargo)) throw new Error('forbidden plugin dependency');
  // law: no synthetic input (XTest) in production. It may live ONLY in a
  // dev-dependencies table. Since the Windows port (U1a) the Unix-only crates
  // sit in target-specific tables, so the section name can be either
  // `[dev-dependencies]` or `[target.'cfg(unix)'.dev-dependencies]`: walk the
  // file by table and drop every dev table wherever it appears, keeping all
  // production tables (plain `[dependencies]` AND `[target.'...'.dependencies]`)
  // in `prod` so a target-specific smuggling of xtest still trips the law.
  const DEV_TABLE = /^(?:target\.'[^']*'\.)?dev-dependencies$/;
  const prodLines = [];
  let table = '';
  for (const line of cargo.split('\n')) {
    const head = /^\s*\[([^\]]+)\]/.exec(line);
    if (head) table = head[1].trim();
    if (DEV_TABLE.test(table)) continue;
    if (line.trim().startsWith('#')) continue;
    prodLines.push(line);
  }
  const prod = prodLines.join('\n');
  if (/xtest/i.test(prod)) throw new Error('xtest (synthetic input) must not be a production dependency: keep it in [dev-dependencies]');
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
bad="$(env | grep -E '${FORBIDDEN_ENV_PATTERN}' | grep -v '^${ALLOWED_ABITO}=' | cut -d= -f1 | head -n 1 || true)"
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
Exec="@INSTALL_DIR@/abito-island-launcher"
Icon=@INSTALL_DIR@/abito-island.png
Terminal=false
Categories=Utility;
StartupWMClass=Abito-island
`;
}

// ---- receipt verification (no launch) -------------------------------------
const STAGED = ['abito-island', 'abito-island-launcher', 'abito-island.png', `${IDENTIFIER}.desktop`];
function verifyStage(dir, { sourceCrate } = {}) {
  const problems = [];
  const receiptPath = path.join(dir, 'receipt.json');
  if (!fs.existsSync(receiptPath)) return ['receipt.json missing'];
  let receipt;
  try { receipt = readJson(receiptPath); } catch (e) { return [e.message]; }
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
    for (const marker of ['--remote-debugging', 'devtools://', 'Prueba M3: propuesta servida por el backend falso', 'ABITO_PROBE', 'XTEST']) if (bytes.includes(Buffer.from(marker))) problems.push(`binary contains «${marker}» (devtools/probe/fake)`);
    for (const prefix of [process.env.HOME && `${process.env.HOME}/.cargo`, process.env.HOME && `${process.env.HOME}/Apps`].filter(Boolean)) if (bytes.includes(Buffer.from(prefix))) problems.push(`binary embeds the build machine path ${prefix}…`);
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

module.exports = { provenance, requireClean, FORBIDDEN_ENV_PATTERN, ALLOWED_ABITO, R6_PREFIX, IDENTIFIER, FRONTEND_FILES, EXPECTED_PERMISSIONS, STAGED, sha256, sha256File,
  checkR6, checkFrontend, checkConfig, launcherText, desktopText, verifyStage };
