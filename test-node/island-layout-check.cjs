'use strict';
/* Expanded island layout «A + E» (human decision 21/10, validacion/ESQUEMA-isla-A-E.md): pure view-model. No DOM.
   A = three columns (status | centre | blobs); E = focus mode while something waits for the human.
   Run: node test-node/island-layout-check.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const L = require(path.join(frontend, 'island-layout.js'));
const T = require(path.join(frontend, 'sessions-ticker.js'));
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };

const sess = (over = {}) => ({ id: 's-0123abcd', kindLabel: 'Pi', cwd: 'workspace', state: 'sleeping', stateLabel: 'inactiva', origin: null, ...over });
const frame = (rows, over = {}) => ({ type: 'sessions', schema: 'abito-sessions/view/1', sessions: rows, truncated: false, ...over });
const view = (rows, over) => T.sessionsView(frame(rows, over));
const raw = (over = {}) => ({ id: 's-0123abcd', kind: 'pi', cwd: 'workspace', state: 'sleeping', origin: null, ...over });

// ---- the sessions view now carries what the columns count -----------------------------------------------------------------------
test('the sessions view keeps each row\'s raw state and the real total when the frame is truncated', () => {
  const v = view([raw(), raw({ id: 's-0123abce', state: 'running' })]);
  assert.deepEqual(v.rows.map(r => r.state), ['sleeping', 'running']);
  assert.equal(v.total, 2, 'not truncated: total = rows');
  const t = view([raw()], { truncated: true, total: 40 });
  assert.equal(t.total, 40);
  assert.equal(view([raw()], { truncated: true, total: 0 }).total, 1, 'a total below the rows received is nonsense: rows');
  assert.equal(view([raw()], { truncated: true, total: 99999 }).total, 1, 'above the daemon cap: rows');
  assert.equal(view([raw()], { truncated: true }).total, 1, 'truncated without a total: rows (and the label says «+»)');
});

// ---- widths ---------------------------------------------------------------------------------------------------------------------
test('columnWidths: status 108 | centre >= 330 | gap 8 | blobs, summing to the overview width; focus shrinks blobs to a mascot column', () => {
  const n = L.columnWidths(620, false);
  assert.deepEqual(n, { fits: true, focus: false, status: 108, centre: 330, gap: 8, blobs: 174, main: 438 });
  assert.equal(n.status + n.centre + n.gap + n.blobs, 620);
  const f = L.columnWidths(620, true);
  assert.deepEqual(f, { fits: true, focus: true, status: 108, centre: 440, gap: 8, blobs: 64, main: 548 });
  assert.equal(f.main + f.gap + f.blobs, 620, 'the focus card takes left + centre and leaves only the mascot column');
  assert.ok(f.centre >= n.centre, 'focus gives the content MORE room');
});
test('columnWidths: the minimums are honest; a width that cannot fit says so instead of squeezing the centre', () => {
  assert.equal(L.columnWidths(560, false).fits, false, '560: centre would be 294 < 330');
  assert.equal(L.columnWidths(612, false).fits, true);
  assert.ok(L.columnWidths(612, false).centre >= 330 && L.columnWidths(612, false).blobs >= 150);
  assert.equal(L.columnWidths(NaN, false).fits, false);
  assert.equal(L.columnWidths(-5, true).fits, false);
  assert.equal(L.columnWidths(500, true).fits, false, 'focus: 500 - 8 - 64 - 108 = 320 < 330');
  assert.equal(L.columnWidths(520, true).fits, true);
});

// ---- the counts: real sessions and the real queue, never rendered rows ---------------------------------------------------------
test('statusCounts: active = real sessions working; waiting = pending + queued (not rows rendered)', () => {
  const v = view([raw({ state: 'running' }), raw({ id: 's-0123abce', state: 'sleeping' }), raw({ id: 's-0123abcf', state: 'running' })]);
  const c = L.statusCounts({ view: v, pending: { id: 'x' }, queuedCount: 2 });
  assert.deepEqual([c.active, c.waiting, c.approx], [2, 3, false]);
  assert.deepEqual(c.lines, ['2 activas', '3 esperan']);
  assert.deepEqual(L.statusCounts({ view: v, pending: { id: 'x' }, queuedCount: 0 }).lines, ['2 activas', '1 espera']);
  assert.deepEqual(L.statusCounts({ view: view([raw({ state: 'running' })]), pending: null, queuedCount: 0 }).lines, ['1 activa']);
});
test('statusCounts: a running tool counts as active even when the process state says otherwise; truncated lists say «+»; nothing = reposo', () => {
  const tools = { total: 1, steps: [{ index: 1, name: 'bash', state: 'running' }] };
  const v = view([raw({ state: 'sleeping', tools })]);
  assert.equal(L.statusCounts({ view: v, pending: null, queuedCount: 0 }).active, 1);
  const t = view([raw({ state: 'running' })], { truncated: true, total: 30 });
  const c = L.statusCounts({ view: t, pending: null, queuedCount: 0 });
  assert.deepEqual([c.active, c.approx, c.lines], [1, true, ['1+ activa']], 'only the received rows are known: never claim an exact count');
  assert.deepEqual(L.statusCounts({ view: view([raw()]), pending: null, queuedCount: 0 }).lines, ['En reposo']);
  assert.deepEqual(L.statusCounts({ view: null, pending: null, queuedCount: 0 }).lines, ['En reposo']);
  assert.deepEqual(L.statusCounts({ view: { state: 'error' }, pending: null, queuedCount: 0 }).lines, ['En reposo'], 'an unavailable list claims nothing');
  for (const bad of [-1, 1.5, '2', NaN, 99, undefined]) assert.equal(L.statusCounts({ view: null, pending: { id: 'x' }, queuedCount: bad }).waiting, 1, `queued_count ${bad} is not a count`);
  assert.equal(L.statusCounts({ view: null, pending: null, queuedCount: 3 }).waiting, 0, 'nothing pending: a queue count alone is not shown');
});

// ---- attribution: the pending question belongs to a row only when it is unambiguous --------------------------------------------
test('attribute: agent class + project name pick ONE session; ambiguity attributes nothing (the count still says it)', () => {
  const rows = [sess({ id: 's-0000000a', kindLabel: 'Claude Code', cwd: 'api' }), sess({ id: 's-0000000b', kindLabel: 'Claude Code', cwd: 'web' }), sess({ id: 's-0000000c', kindLabel: 'Pi', cwd: 'api' })];
  const claudeApi = { agent: 'claude-code', project_name: 'api' };
  assert.equal(L.attribute(claudeApi, rows), 's-0000000a');
  assert.equal(L.attribute({ agent: 'claude-code', project_name: 'web' }, rows), 's-0000000b');
  assert.equal(L.attribute({ agent: 'claude-code' }, rows), null, 'two Claude sessions and no project: ambiguous');
  assert.equal(L.attribute({ agent: 'codex', project_name: 'api' }, rows), null, 'no such session');
  assert.equal(L.attribute({ agent: 'claude-code', project_name: 'nope' }, rows), null);
  assert.equal(L.attribute({ agent: 'pi' }, [rows[2]]), 's-0000000c', 'a single session of the class is unambiguous');
  assert.equal(L.attribute({ agent: 'claude-code', project_name: 'api' }, [rows[0], { ...rows[0], id: 's-0000000d' }]), null, 'two sessions with the same class AND project: ambiguous');
  assert.equal(L.attribute(null, rows), null);
  assert.equal(L.attribute({ agent: '../x' }, rows), null);
});

// ---- the right column ----------------------------------------------------------------------------------------------------------
const pill = (id, name, over = {}) => ({ id, name, kind: 'pill', color: 'blue', ...over });
test('blobRows: declared pills ALWAYS come first and are never pushed out; sessions follow; no cap of four', () => {
  const declared = [pill('abito', 'Abito', { kind: 'principal' }), pill('integration_github', 'GitHub', { kind: 'integration' })];
  const sessions = Array.from({ length: 9 }, (_, i) => sess({ id: `s-0000000${i}`, cwd: `p${i}`, state: i === 0 ? 'running' : 'sleeping' }));
  const rows = L.blobRows({ declared, sessions, focusId: null, attributedId: null, badges: new Set() });
  assert.equal(rows.length, 11, '2 declared + 9 sessions: nothing dropped');
  assert.deepEqual(rows.slice(0, 2).map(r => r.id), ['abito', 'integration_github']);
  assert.ok(rows.slice(2).every(r => r.kind === 'session'));
  assert.deepEqual(rows.slice(0, 2).map(r => r.kind), ['principal', 'integration']);
});
test('blobRows: every row has a name, a colour and ONE honest status dot: working / idle / needs you / news', () => {
  const declared = [pill('abito', 'Abito', { kind: 'principal' }), pill('integration_github', 'GitHub', { kind: 'integration' })];
  const sessions = [sess({ id: 's-0000000a', kindLabel: 'Claude Code', cwd: 'api', state: 'running' }), sess({ id: 's-0000000b', cwd: 'web' }), sess({ id: 's-0000000c', cwd: 'old', state: 'sleeping' })];
  const rows = L.blobRows({ declared, sessions, focusId: 's-0000000b', attributedId: 's-0000000c', badges: new Set(['integration_github']) });
  const by = id => rows.find(r => r.id === id);
  assert.equal(by('s-0000000a').status, 'working');
  assert.equal(by('s-0000000b').status, 'idle');
  assert.equal(by('s-0000000c').status, 'needs', 'the attributed pending question marks ITS row only');
  assert.equal(by('integration_github').status, 'news');
  assert.equal(by('abito').status, 'idle');
  assert.equal(by('s-0000000b').focused, true);
  assert.equal(by('s-0000000a').focused, false);
  assert.equal(by('s-0000000a').name, 'api');
  assert.equal(by('s-0000000a').aria, 'api · Claude Code · trabajando');
  assert.equal(by('s-0000000c').aria, 'old · Pi · te necesita');
  for (const r of rows) assert.ok(r.name && r.color && ['working', 'idle', 'needs', 'news'].includes(r.status), r.id);
});
test('blobRows: a long name is bounded for the column; a running tool means working; nothing malformed throws', () => {
  const tools = { total: 1, steps: [{ index: 1, name: 'bash', state: 'running' }] };
  const rows = L.blobRows({ declared: [], sessions: [sess({ cwd: 'un-nombre-de-proyecto-larguisimo', tools, state: 'sleeping' })], focusId: null, attributedId: null, badges: new Set() });
  assert.equal(rows[0].status, 'working');
  assert.ok(Array.from(rows[0].name).length <= 24 && rows[0].name.endsWith('…'), rows[0].name);
  assert.deepEqual(L.blobRows({}), []);
  assert.deepEqual(L.blobRows(null), []);
  assert.equal(L.blobRows({ declared: [null, { id: 5 }, pill('ok', 'Ok')], sessions: [null, 7] }).length, 1, 'junk rows are dropped, never repaired');
});
test('focusOverflow: up to four mascots show all of them; more shows three and «+N»', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}` }));
  assert.deepEqual(L.focusOverflow(rows.slice(0, 4)), { shown: rows.slice(0, 4), more: 0 });
  const o = L.focusOverflow(rows);
  assert.deepEqual([o.shown.length, o.more], [3, 3]);
  assert.deepEqual(L.focusOverflow([]), { shown: [], more: 0 });
  assert.deepEqual(L.focusOverflow(null), { shown: [], more: 0 });
});

// ---- the mode -------------------------------------------------------------------------------------------------------------------
test('layoutMode: focus ONLY while something waits for the human and its card is the one on screen; it ends with the question', () => {
  assert.equal(L.layoutMode({ question: 'pending' }), 'focus');
  assert.equal(L.layoutMode({ card: 'pending' }), 'focus');
  assert.equal(L.layoutMode({ question: 'pending', card: 'pending' }), 'focus');
  for (const q of ['', 'outcome', 'expired', undefined, null]) assert.equal(L.layoutMode({ question: q }), 'normal', String(q));
  assert.equal(L.layoutMode({}), 'normal');
  assert.equal(L.layoutMode(null), 'normal');
});

// ---- approvals (E): «!», the command in a mono box, «Rechazar N / Aprobar Y» ----------------------------------------------------
const opt = (i, label, description = '') => ({ index: i, key: String(i + 1), label, description });
const harness = (text, opts = [opt(0, 'Allow once'), opt(1, 'Deny')]) => ({ id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', kind: 'question', agent: 'claude-code', text, options: opts, allowFreeText: false });
test('approvalView: a Claude/Codex permission (a question the harness words «asks permission») gets the approval look', () => {
  const v = L.approvalView(harness('Claude Code asks permission: Bash: rm -rf build/ && npm run build'), 'Claude Code');
  assert.equal(v.badge, '!');
  assert.equal(v.title, 'Claude Code quiere ejecutar:');
  assert.equal(v.command, 'rm -rf build/ && npm run build');
  assert.equal(v.tool, 'Bash');
  assert.deepEqual(v.actions.map(a => [a.role, a.label, a.key, a.index]), [['reject', 'Rechazar', 'N', 1], ['approve', 'Aprobar', 'Y', 0]], 'reject on the left, approve primary on the right; indexes come from the labels');
  assert.equal(v.secretsHidden, false);
  assert.equal(L.approvalView(harness('Codex asks permission: Edit: src/a.js (secrets hidden)'), 'Codex').secretsHidden, true);
  const other = L.approvalView(harness('Claude Code asks permission: WebFetch: https://example.com'), 'Claude Code');
  assert.equal(other.title, 'Claude Code pide permiso para:');
  assert.equal(other.command, 'https://example.com');
  assert.equal(other.tool, 'WebFetch');
});
test('approvalView is SAFE: only the exact known label pair maps to Aprobar/Rechazar; anything else stays a numbered list', () => {
  assert.equal(L.approvalView(harness('Claude Code asks permission: Bash: ls', [opt(0, 'Deny'), opt(1, 'Decide in the terminal')]), 'Claude Code'), null, 'a lossy request offers no allow: no approve button');
  assert.equal(L.approvalView(harness('Claude Code asks permission: Bash: ls', [opt(0, 'Allow'), opt(1, 'Deny')]), 'Claude Code'), null, 'unknown wording is not guessed');
  assert.equal(L.approvalView(harness('Claude Code asks permission: Bash: ls', [opt(0, 'Allow once'), opt(1, 'Deny'), opt(2, 'More')]), 'Claude Code'), null);
  assert.equal(L.approvalView(harness('¿Querés café o té?', [opt(0, 'Café'), opt(1, 'Té')]), 'Pi'), null, 'an ordinary question is never an approval');
  assert.equal(L.approvalView({ ...harness('Claude Code asks permission: Bash: ls'), allowFreeText: true }, 'Claude Code'), null);
  assert.equal(L.approvalView(null, 'x'), null);
  // a swapped order still maps by LABEL, never by position
  const swapped = L.approvalView(harness('Claude Code asks permission: Bash: ls', [opt(0, 'Deny'), opt(1, 'Allow once')]), 'Claude Code');
  assert.deepEqual(swapped.actions.map(a => [a.role, a.index]), [['reject', 0], ['approve', 1]]);
});
test('approvalView: Pi\'s kind=approval keeps ITS OWN two labels (no assumption which one approves), in the pill look', () => {
  const pi = { id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', kind: 'approval', agent: 'pi', text: '¿Borrar la carpeta build?', options: [opt(0, 'Borrar'), opt(1, 'Mantener')], allowFreeText: false };
  const v = L.approvalView(pi, 'Pi');
  assert.equal(v.badge, '!');
  assert.equal(v.title, 'Pi pide tu aprobación:');
  assert.equal(v.command, '¿Borrar la carpeta build?');
  assert.deepEqual(v.actions.map(a => [a.role, a.label, a.key, a.index]), [['option', 'Borrar', '1', 0], ['option', 'Mantener', '2', 1]]);
});
test('approvalKey: Y approves and N rejects only for a known pair, trusted, unmodified, not typing, not repeating', () => {
  const v = L.approvalView(harness('Claude Code asks permission: Bash: ls'), 'Claude Code');
  const key = (k, extra = {}) => ({ key: k, isTrusted: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, repeat: false, ...extra });
  assert.equal(L.approvalKey(key('y'), v, { typing: false }), 0);
  assert.equal(L.approvalKey(key('Y'), v, { typing: false }), 0);
  assert.equal(L.approvalKey(key('n'), v, { typing: false }), 1);
  assert.equal(L.approvalKey(key('y', { isTrusted: false }), v, { typing: false }), -1);
  assert.equal(L.approvalKey(key('y', { ctrlKey: true }), v, { typing: false }), -1);
  assert.equal(L.approvalKey(key('y', { repeat: true }), v, { typing: false }), -1);
  assert.equal(L.approvalKey(key('y'), v, { typing: true }), -1);
  assert.equal(L.approvalKey(key('x'), v, { typing: false }), -1);
  const pi = L.approvalView({ id: 'a', kind: 'approval', agent: 'pi', text: 't', options: [opt(0, 'Borrar'), opt(1, 'Mantener')], allowFreeText: false }, 'Pi');
  assert.equal(L.approvalKey(key('y'), pi, { typing: false }), -1, 'Y/N never guess which of Pi\'s own labels approves');
  assert.equal(L.approvalKey(key('y'), null, { typing: false }), -1);
});


// ---- G: the state badge is attached to the mascot, wherever the mascot is (human audit: «el ? queda ~90 px arriba/izquierda») ---------
test('badgePosition: top-left of the mascot (centre - 20, - 21 like Coucou), following it in every view and size', () => {
  assert.deepEqual(L.badgePosition({ left: 68, top: 70, size: 66 }), { left: 68 + 33 - 20 - 8, top: 70 + 33 - 21 - 8 }, 'overview: centre (101,103) -> badge centre (81,82)');
  const chat = L.badgePosition({ left: 52, top: 164, size: 46 });
  assert.deepEqual(chat, { left: 52 + 23 - 28, top: 164 + 23 - 29 }, 'chat: the mascot moved to the composer, the badge came with it');
  assert.ok(chat.top > 100, 'and it is NOT left up near the header where the overview mascot was');
  assert.deepEqual(L.badgePosition({ left: 0, top: 0, size: 0 }), { left: -28, top: -29 });
  for (const bad of [null, undefined, {}, { left: NaN, top: 1, size: 1 }, { left: 1, top: 1 }]) assert.equal(L.badgePosition(bad), null, JSON.stringify(bad));
});
test('wiring: island.js places the badge from the mascot\'s OWN rendered box (the same left/top/size it just wrote), not a fixed offset', () => {
  const fs = require('node:fs');
  const isl = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  const badge = isl.slice(isl.indexOf("const badge = $('clay-badge')"), isl.indexOf("if (capsule.dataset.edge !== edge)"));
  assert.match(badge, /AbitoIslandLayout\.badgePosition\(/);
  assert.match(badge, /left: clayLeft, top: clayTop, size: csv/);
  assert.doesNotMatch(badge, /ov\.clayX - 28|ov\.cy - 29/, 'the fixed offsets that detached the badge in the chat are gone');
});


// ---- CSS: the three columns and focus mode, measured on the real style sheets --------------------------------------------------
const fs = require('node:fs');
const css = (fs.readFileSync(path.join(frontend, 'style.css'), 'utf8') + '\n' + fs.readFileSync(path.join(frontend, 'vendor/coucou/island/island.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
function decls(sel) {
  const out = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const group = m[1].replace(/\s+/g, ' ').trim();
    if (group !== sel && !group.split(',').map(s => s.trim()).includes(sel)) continue;
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).replace('!important', '').trim(); }
  }
  return out;
}
const px = v => parseFloat(v);
test('CSS: the columns add up to the 620px overview — status 108 | centre | 8 gap | blobs — with the blobs column scrolling inside its card', () => {
  const left = decls('.card-left'), blobs = decls('#blobs'), list = decls('#pill-choices');
  assert.equal(px(left.width) + px(blobs.width) + 8, 620, 'the columns still sum to the overview width');
  assert.equal(px(left.width), 438, 'left + centre = status 108 + centre 330');
  assert.equal(px(blobs.width), 174);
  assert.equal(blobs.left, 'calc(50% + 136px)', 'island centre - 310 (overview left) + 446 (main card 438 + 8px gap)');
  assert.equal(px(blobs.top), 42); assert.equal(px(blobs.height), 108);
  assert.equal(list['overflow-y'], 'auto', 'the blobs scroll, nothing is capped or pushed out');
  assert.equal(list.display, 'flex');
  assert.equal(list['flex-direction'], 'column');
  const row = decls('.pill-choice');
  assert.equal(px(row.height), 32);
  assert.equal(row.width, '100%', 'one blob per row, full width of the column');
});
test('CSS: focus mode — the card takes left + centre and the blobs shrink to a 64px mascot column (names hidden, dots kept)', () => {
  const left = decls('#capsule[data-layout="focus"] #question'), blobs = decls('#capsule[data-layout="focus"] #blobs');
  assert.equal(px(left.width), 548, 'status 108 + centre 440');
  assert.equal(px(blobs.width), 64);
  assert.equal(blobs.left, 'calc(50% + 246px)', 'island centre - 310 + 556');
  assert.equal(px(left.width) + 8 + px(blobs.width), 620);
  assert.equal(decls('#capsule[data-layout="focus"] .pill-choice span:not(.ico)').display, 'none', 'only mascots in focus mode');
  assert.notEqual(decls('#capsule[data-layout="focus"] .blob-dot').display, 'none', 'but the status dots stay');
});
test('CSS: the status dot has one honest colour per state (working / idle / needs you / news)', () => {
  for (const [st, token] of [['working', '--go'], ['needs', '--sun'], ['news', '--island-live']]) assert.match(decls(`.blob-dot[data-status="${st}"]`).background || '', new RegExp(token), st);
  assert.ok(decls('.blob-dot[data-status="idle"]').background, 'idle is drawn too (an empty ring)');
});
test('CSS: the left column is Abito\'s mascot and its status; the status text never overlaps the centre', () => {
  const st = decls('.col-status');
  assert.equal(px(st.width), 96);
  assert.equal(st.position, 'absolute');
  assert.ok(px(st.left) + px(st.width) <= 108, 'inside the 108px status column');
});

// ---- wiring: the approval look on the question card (E) ------------------------------------------------------------------------
test('wiring: notify.js renders approvalView (badge, mono box, Rechazar/Aprobar) and sends the OPTION INDEX through the same choose() path; Y/N use approvalKey', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /AbitoIslandLayout/);
  assert.match(src, /\.approvalView\(/);
  assert.match(src, /\.approvalKey\(/);
  assert.match(src, /q-approval/);
  assert.match(src, /choose\(event, act\.index\)/, 'the click goes through the existing trusted answer path with the option index');
  assert.doesNotMatch(src, /approval[^\n]*action\('allow'|action\(\{ action: 'allow'/, 'no new IPC verb: an approval is an ordinary answer');
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /id="question-approval"/);
  assert.match(css, /#question-approval \.q-cmd \{[^}]*font: 400 12px var\(--mono\)/, 'the command in a mono well');
  assert.match(css, /#question\[data-look="approval"\]/);
  assert.equal(decls('.q-approval-btn.q-approve::after').background, 'var(--ink)', 'Aprobar is the primary (white) pill');
  assert.equal(decls('.q-approval-btn.q-approve').color, '#0b0c0e', 'dark text on it');
});

// ---- the notices band must not cover the blobs list; calm gives the room back ---------------------------------------------------
test('CSS: the blobs card leaves the 44px notices band free; a calm strip (nothing to say) gives that room back', () => {
  assert.equal(px(decls('#blobs')['padding-top']), 44, 'the band (y42..86 of the island) owns the top of the right card');
  assert.equal(px(decls('#capsule[data-notices-calm="true"] #blobs')['padding-top']), 0);
  assert.equal(px(decls('#capsule[data-layout="focus"] #blobs')['padding-top']), 0, 'focus mode hides the band behind the question card');
});

// ---- H: every agent has its own mascot colour (human audit: «4 puntos azules idénticos») --------------------------------------
test('agentColor: a stable colour per agent class, the human\'s own pill colour wins, unknown falls back to blue', () => {
  assert.deepEqual(['Pi', 'Claude Code', 'Codex', 'Gemini', 'OpenCode'].map(k => T.agentColor(k, {})), ['green', 'orange', 'purple', 'mint', 'blue']);
  assert.equal(T.agentColor('Claude Code', { pillColors: { integration_claude: 'purple' } }), 'purple', 'the human\'s choice wins');
  assert.equal(T.agentColor('Claude Code', { pillColors: { integration_claude: 'not-a-colour' } }), 'orange', 'a junk preference never reaches the DOM');
  assert.equal(T.agentColor('Mystery', {}), 'blue');
  assert.equal(T.agentColor(undefined, null), 'blue');
  const rows = T.sessionRows(T.sessionsView({ type: 'sessions', schema: 'abito-sessions/view/1', truncated: false, sessions: [
    { id: 's-0000000a', kind: 'claude-code', cwd: 'a', state: 'running', origin: null }, { id: 's-0000000b', kind: 'codex', cwd: 'b', state: 'running', origin: null }] }), {});
  assert.deepEqual(rows.map(r => r.color), ['orange', 'purple'], 'two agents are two colours');
});
test('wiring: the focus-mode blobs column shows «+N» for the overflow and the footer\'s «Ver todas» opens the full list', () => {
  const pv = fs.readFileSync(path.join(frontend, 'pills-view.js'), 'utf8');
  assert.match(pv, /focusOverflow\(/);
  assert.match(pv, /blobs-more/);
  assert.match(css, /#capsule\[data-layout="focus"\] \.pill-choice\[data-overflow="true"\] \{[^}]*display: none/);
});

// ---- E: the centre shows the FOCUSED session with its real state and real tool steps only ---------------------------------------
const row = (over = {}) => ({ id: 's-0000000a', kindLabel: 'Claude Code', cwd: 'api', state: 'sleeping', stateLabel: 'inactiva', origin: null, ...over });
test('pickFocus: the one selected in the blobs column, else the most recently active; never another session by accident', () => {
  const a = row({ id: 's-0000000a', cwd: 'a' }), b = row({ id: 's-0000000b', cwd: 'b', state: 'running' }), c = row({ id: 's-0000000c', cwd: 'c' });
  assert.equal(L.pickFocus([a, b, c], 's-0000000c', null), 's-0000000c', 'the human\'s selection wins');
  assert.equal(L.pickFocus([a, b, c], null, null), 's-0000000b', 'default: a working session beats idle ones');
  assert.equal(L.pickFocus([a, c], null, null), 's-0000000a', 'all idle: the first the daemon lists (it sorts most recent first)');
  assert.equal(L.pickFocus([a, b, c], 's-9999999z', null), 's-0000000b', 'a selection that no longer exists is dropped, not shown');
  assert.equal(L.pickFocus([], 's-0000000a', null), null);
  assert.equal(L.pickFocus(null, null, null), null);
  const withTools = row({ id: 's-0000000d', cwd: 'd', tools: { total: 1, steps: [{ index: 1, name: 'bash', state: 'running' }] } });
  assert.equal(L.pickFocus([a, withTools], null, null), 's-0000000d', 'a running tool counts as working');
  assert.equal(L.pickFocus([a, b], null, 's-0000000a'), 's-0000000a', 'the attributed pending question\'s session is the default focus when none is selected');
});
test('centreView: name, agent, REAL state word and real tool steps; no steps -> no step lines (no placeholder, no «…»)', () => {
  const idle = L.centreView(row());
  assert.deepEqual([idle.name, idle.agent, idle.state, idle.stateWord, idle.steps], ['api', 'Claude Code', 'idle', 'En reposo', []]);
  assert.equal(idle.aria, 'api · Claude Code · en reposo');
  const working = L.centreView(row({ state: 'running' }));
  assert.deepEqual([working.state, working.stateWord], ['working', 'Trabajando']);
  const tools = { total: 4, steps: [{ index: 2, name: 'read', state: 'done' }, { index: 3, name: 'grep', state: 'done' }, { index: 4, name: 'bash', state: 'running' }] };
  const t = L.centreView(row({ state: 'sleeping', tools }));
  assert.equal(t.state, 'working', 'a running tool overrides the process state');
  assert.deepEqual(t.steps.map(x => [x.name, x.state]), [['read', 'done'], ['grep', 'done'], ['bash', 'running']]);
  assert.equal(t.count, '4/4');
  assert.deepEqual(t.steps.map(x => x.current), [false, false, true], 'the running step is the current one');
  const done = L.centreView(row({ tools: { total: 2, steps: [{ index: 1, name: 'read', state: 'done' }, { index: 2, name: 'bash', state: 'done' }] } }));
  assert.equal(done.steps.at(-1).current, true, 'when nothing runs the last step is the current one');
  const err = L.centreView(row({ tools: { total: 1, steps: [{ index: 1, name: 'bash', state: 'error' }] } }));
  assert.equal(err.state, 'error'); assert.equal(err.stateWord, 'Con error');
  assert.equal(L.centreView(null), null);
  assert.equal(L.centreView({}), null);
});
test('centreView: a session waiting for the human says so ONLY when the pending question is attributed to it', () => {
  assert.equal(L.centreView(row(), { attributedId: 's-0000000a' }).state, 'waiting');
  assert.equal(L.centreView(row(), { attributedId: 's-0000000a' }).stateWord, 'Te espera');
  assert.equal(L.centreView(row(), { attributedId: 's-0000000b' }).state, 'idle', 'someone else\'s question is not this session\'s state');
  assert.equal(L.centreView(row({ state: 'running' }), { attributedId: 's-0000000a' }).state, 'waiting', 'waiting beats working');
});
test('centreView: steps are bounded to what fits (last 3) and a long name is cut for the column', () => {
  const steps = Array.from({ length: 6 }, (_, i) => ({ index: i + 1, name: `tool${i}`, state: 'done' }));
  assert.equal(L.centreView(row({ tools: { total: 6, steps } })).steps.length, 3);
  assert.equal(L.centreView(row({ tools: { total: 6, steps } })).steps[2].name, 'tool5');
  const long = L.centreView(row({ cwd: 'un-proyecto-con-un-nombre-larguisimo-de-verdad' }));
  assert.ok(Array.from(long.name).length <= 32 && long.name.endsWith('…'), long.name);
});

// ---- I: the empty state in the centre, with a CTA ------------------------------------------------------------------------------
test('emptyView: nothing running -> «Todo tranquilo» + «Nueva conversación»; failures and unknown states are NOT empty', () => {
  const e = L.emptyView({ view: T.sessionsView({ type: 'sessions', schema: 'abito-sessions/view/1', truncated: false, sessions: [] }), pending: null, finished: false });
  assert.deepEqual(e, { title: 'Todo tranquilo', sub: 'Nada en marcha por ahora. Soltá un archivo o hacé tu pregunta.', cta: { label: 'Nueva conversación', action: 'new-chat' } });
  assert.deepEqual(L.emptyView({ view: null, pending: null, finished: false }).cta.action, 'new-chat', 'no list yet and nothing pending: still a calm empty centre');
  assert.equal(L.emptyView({ view: { state: 'error' }, pending: null, finished: false }), null, 'a failed list is not "everything is calm": the engine row owns that');
  assert.equal(L.emptyView({ view: T.sessionsView({ type: 'sessions', schema: 'abito-sessions/view/1', truncated: false, sessions: [{ id: 's-0000000a', kind: 'pi', cwd: 'x', state: 'sleeping', origin: null }] }), pending: null, finished: false }), null, 'a session exists: the centre shows it');
  assert.equal(L.emptyView({ view: null, pending: { id: 'x' }, finished: false }), null, 'something waits: focus mode owns the centre');
  assert.equal(L.emptyView({ view: null, pending: null, finished: true }), null, 'a finished result owns the centre');
});

// ---- D: «Pi terminó» in the centre, full width, the result untruncated -------------------------------------------------------------
test('finishedLayout: the result wraps (never one truncated line) and asks the island for the height it needs, capped like a question', () => {
  const short = L.finishedLayout(40);
  assert.deepEqual(short, { cardH: 108, islandH: 160, scroll: false }, 'a short result fits the normal overview card');
  const mid = L.finishedLayout(150);
  assert.deepEqual([mid.cardH, mid.islandH, mid.scroll], [150, 202, false]);
  const huge = L.finishedLayout(900);
  assert.deepEqual([huge.cardH, huge.islandH, huge.scroll], [280, 332, true], 'capped at the same 332 as a question, then scrolls inside');
  const granted = L.finishedLayout(900, 600);
  assert.deepEqual([granted.cardH, granted.islandH, granted.scroll], [548, 600, true], 'a window the host grew allows more');
  for (const bad of [NaN, -3, undefined]) assert.deepEqual(L.finishedLayout(bad), { cardH: 108, islandH: 160, scroll: false }, String(bad));
});
test('wiring D/E/I: the centre is fed by island-layout.js; CSS lets the finished message wrap; a blob click selects it for the centre', () => {
  const lay = fs.readFileSync(path.join(frontend, 'island-layout.js'), 'utf8');
  for (const id of ['col-centre', 'centre-state', 'centre-steps', 'centre-empty']) assert.match(fs.readFileSync(path.join(frontend, 'index.html'), 'utf8'), new RegExp(`id="${id}"`), id);
  assert.match(lay, /pickFocus\(/); assert.match(lay, /centreView\(/); assert.match(lay, /emptyView\(/);
  assert.match(lay, /abito:session-select/, 'selecting a blob sets the centre');
  const pv = fs.readFileSync(path.join(frontend, 'pills-view.js'), 'utf8');
  assert.match(pv, /abito:session-select/, 'the blob click already dispatches the selection the centre listens to');
  assert.equal(decls('#notice-card .title.one-line')['white-space'], 'normal', 'the finished result wraps');
  assert.equal(decls('#notice-card .title.one-line')['text-overflow'], 'clip');
  const isl = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(isl, /finishedLayout\(/, 'the island grows for a long result');
  assert.match(isl, /abito:centre-new/, 'the CTA opens a new conversation through the existing «+»');
});

test('no duplicates: the centre column replaces the old who-row text and the Coucou ticker; only the «Ver todas» link stays of the who-row', () => {
  for (const sel of ['.who .name', '.who .tool', '.who .count', '.who .who-dot']) assert.equal(decls(sel).display, 'none', `${sel}: the centre already says it`);
  assert.equal(decls('.card-left > .ticker').display, 'none', 'the centre draws the real steps (3 lines) itself');
  const who = decls('.card-left > .who');
  assert.equal(who.bottom, '6px', 'the link sits at the bottom of the centre, away from the state line');
  assert.equal(who.top, 'auto');
  assert.ok(decls('.who .see-all'), 'the link keeps its own rule');
});

console.log(`island-layout-check: ${passed} checks ok`);
