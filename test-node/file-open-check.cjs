'use strict';
/* F019 RED test — open-file-from-diff view side (frontend/file-open.js).
   PURE view module: it decides WHEN an open request may leave the page and
   WHAT it may contain. The closure is strict: only a workspace-relative path
   that the diff card itself displayed, from a trusted, on-screen, non-typing
   event. The actual opening is a host verb that does NOT exist yet — the
   mount contract doc requires a Rust command with its own validation before
   anything can be wired, so this module never calls IPC and never guesses a
   transport. Run: node test-node/file-open-check.cjs (exit 0 = pass). */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const F = require(path.join(__dirname, '..', 'frontend', 'file-open.js'));

let n = 0;
const ok = name => { n++; console.log(`ok ${n} - ${name}`); };
const KEVENT = { isTrusted: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, repeat: false };
const CTX = { event: KEVENT, typing: false, screen: { phase: 'expanded', view: 'overview', card: null } };

// ---- surface ----------------------------------------------------------------
for (const fn of ['isWorkspaceRelative', 'createOpenGate']) {
  assert.equal(typeof F[fn], 'function', `exports ${fn}`);
}
ok('exports the closed API');

// ---- path closure: workspace-relative only -------------------------------------
for (const good of ['src/f.txt', 'a/b/c.rs', 'f.txt', 'src\\win.txt', 'añejo ñ.txt']) {
  assert.equal(F.isWorkspaceRelative(good), true, `accepts ${JSON.stringify(good)}`);
}
for (const bad of ['', '/etc/passwd', '\\\\srv\\share', 'C:\\x', 'c:/x', '../x', 'a/../b',
  'a/b/../../../c', 'x/..', '..', '.', '~', '~/x', 'a\0b', null, undefined, 42, {}, './x',
  '  src/f.txt', 'src/f.txt\n', '/']) {
  assert.equal(F.isWorkspaceRelative(bad), false, `refuses ${JSON.stringify(bad)}`);
}
ok('closure accepts only clean workspace-relative paths');

// ---- the gate remembers what the card displayed ----------------------------------
{
  const g = F.createOpenGate();
  g.display({ path: 'src/a.rs', added: 1, removed: 1, hunks: [], tooLarge: false });
  assert.deepEqual(g.request('src/a.rs', CTX), { verb: 'open_file', path: 'src/a.rs' },
    'a displayed path may be requested');
  assert.equal(g.request('src/other.rs', CTX), null, 'a path the card never displayed is refused');
  assert.equal(g.request(null, CTX), null);
  assert.equal(g.request('/src/a.rs', CTX), null, 'absolute twin is refused even though relative shown');
  ok('only a path the card itself displayed can be requested');
}

// ---- event gates -------------------------------------------------------------------
{
  const g = F.createOpenGate();
  g.display({ path: 'f.txt', added: 1, removed: 0, hunks: [], tooLarge: false });
  assert.equal(g.request('f.txt', { ...CTX, event: { ...KEVENT, isTrusted: false } }), null, 'untrusted event');
  assert.equal(g.request('f.txt', { ...CTX, typing: true }), null, 'while typing');
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
    assert.equal(g.request('f.txt', { ...CTX, event: { ...KEVENT, [mod]: true } }), null, mod);
  }
  assert.equal(g.request('f.txt', { ...CTX, event: { ...KEVENT, isComposing: true } }), null, 'IME');
  assert.equal(g.request('f.txt', { ...CTX, event: { ...KEVENT, repeat: true } }), null, 'repeat');
  assert.equal(g.request('f.txt', { ...CTX, event: null }), null, 'no event');
  ok('trusted, non-typing, modifier-free events only');
}

// ---- on-screen gate ------------------------------------------------------------------
{
  const g = F.createOpenGate();
  g.display({ path: 'f.txt', added: 1, removed: 0, hunks: [], tooLarge: false });
  assert.equal(g.request('f.txt', { ...CTX, screen: { phase: 'compact', view: 'overview', card: null } }), null,
    'not from the compact island');
  assert.equal(g.request('f.txt', { ...CTX, screen: { phase: 'expanded', view: 'chat', card: null } }), null,
    'not from the chat view');
  assert.equal(g.request('f.txt', { ...CTX, screen: { phase: 'expanded', view: 'overview', card: { id: 1 } } }), null,
    'not under a card');
  assert.equal(g.request('f.txt', { ...CTX, screen: null }), null);
  ok('requests only leave while the card is really on screen');
}

// ---- bounded memory ---------------------------------------------------------------------
{
  const g = F.createOpenGate();
  for (let i = 0; i < 20; i++) g.display({ path: `f${i}.txt`, added: 1, removed: 0, hunks: [], tooLarge: false });
  assert.equal(g.request('f0.txt', CTX), null, 'old cards age out');
  assert.deepEqual(g.request('f19.txt', CTX), { verb: 'open_file', path: 'f19.txt' }, 'recent cards stay');
  ok('displayed-path memory is bounded');
}

// ---- junk diffs refused at display time ----------------------------------------------------
{
  const g = F.createOpenGate();
  assert.equal(g.display(null), false);
  assert.equal(g.display({ path: '/abs/x', added: 1, removed: 0, hunks: [], tooLarge: false }), false,
    'an absolute path is never remembered, so it can never be requested');
  ok('display refuses junk and absolute paths');
}

// ---- purity: no IPC, no network, no markup sink ----------------------------------------------
{
  const code = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'file-open.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // prose is not code
  assert.doesNotMatch(code, /__TAURI__|invoke|fetch|XMLHttpRequest|WebSocket|innerHTML|document\.write/,
    'no transport and no markup sink: wiring is the mount contract, not this module');
  ok('the module stays pure; the verb belongs to the documented host contract');
}

console.log(`\n${n} checks passed`);
