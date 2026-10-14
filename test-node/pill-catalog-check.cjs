'use strict';
// #345 F031/F032: public pure catalog/model checks; no DOM, IPC, data or providers.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const catalogPath = path.join(__dirname, '../frontend/pill-catalog.js');
const modelPath = path.join(__dirname, '../frontend/pills.js');
const C = () => require(catalogPath);
const M = () => require(modelPath);
const ids = [
  'integration_claude', 'agent_cursor', 'agent_antigravity', 'agent_codex',
  'agent_gemini', 'agent_copilot', 'agent_muse', 'agent_opencode', 'agent_amp',
  'agent_hermes', 'agent_claude-desktop', 'ai_anthropic', 'ai_google', 'ai_openai',
  'ai_ollama', 'ai_lmstudio', 'integration_resend', 'integration_n8n',
  'integration_vercel', 'integration_github', 'integration_notion',
  'integration_calcom', 'integration_stripe', 'integration_music', 'integration_spotify',
];
const names = ['VS Code', 'Cursor', 'Antigravity', 'Codex', 'Gemini CLI', 'Copilot CLI',
  'Muse Code', 'OpenCode', 'Amp', 'Hermes', 'Claude Desktop', 'Anthropic', 'Google AI',
  'OpenAI', 'Ollama', 'LM Studio', 'Resend', 'n8n', 'Vercel', 'GitHub', 'Notion',
  'Cal.com', 'Stripe', 'Apple Music', 'Spotify'];
const defaults = ['integration_resend', 'integration_n8n', 'integration_vercel', 'integration_github'];

test('S3 exact25 identities, names, category order and immutable closed definitions', () => {
  const c = C();
  assert.deepEqual(c.CATALOG.map(x => x.id), ids);
  assert.deepEqual(c.CATALOG.map(x => x.name), names);
  assert.deepEqual(c.CATALOG.map(x => x.category), [
    ...Array(4).fill('workspace'), ...Array(7).fill('agent'),
    ...Array(5).fill('ai'), ...Array(9).fill('service'),
  ]);
  assert.deepEqual(c.CATEGORIES.map(x => x.id), ['workspace', 'agent', 'ai', 'service']);
  assert.equal(new Set(ids).size, 25);
  assert.ok(Object.isFrozen(c.CATALOG));
  for (const def of c.CATALOG) assert.ok(Object.isFrozen(def));
  for (const id of [null, '', '__proto__', 'constructor', 'unknown', 1]) assert.equal(c.definition(id), null);
});

test('S6 only23 Linux declarations; Apple Music excluded and desktop unsupported', () => {
  const c = C();
  assert.equal(c.available('linux').length, 23);
  assert.equal(c.offered('integration_music', 'linux'), false);
  assert.equal(c.offered('agent_claude-desktop', 'linux'), false);
  assert.equal(c.offered('integration_spotify', 'linux'), true);
  assert.equal(c.available('windows').length, 23);
  assert.equal(c.offered('integration_music', 'windows'), false);
  assert.equal(c.offered('integration_spotify', 'windows'), false);
  assert.equal(c.offered('agent_claude-desktop', 'windows'), true);
  assert.deepEqual(c.available('unknown'), []);
  assert.deepEqual(c.mainChoices('linux').map(x => x.id), ids.slice(0, 4));
});

test('S4 default main and four default declarations; explicit empty list stays empty', () => {
  const m = M();
  assert.deepEqual(m.normalize({}), { mainPill: ids[0], declaredPills: defaults });
  assert.deepEqual(m.normalize({ declaredPills: [] }), { mainPill: ids[0], declaredPills: [] });
  assert.equal(m.MAX_DECLARED, 4);
  const a = m.normalize({}); a.declaredPills.pop();
  assert.deepEqual(m.normalize({}).declaredPills, defaults, 'defaults are never mutable shared state');
});

test('S6 damaged saved input keeps first4 valid distinct choices, excluding main', () => {
  const m = M();
  for (const raw of [null, [], 7, 'bad']) assert.deepEqual(m.normalize(raw), m.normalize({}));
  const raw = { mainPill: 'ai_openai', declaredPills: [null, 'unknown', ids[0],
    'agent_claude-desktop', 'integration_music', 'agent_gemini', 'agent_gemini',
    'ai_google', 'agent_amp', 'integration_notion', 'integration_spotify'] };
  const before = JSON.stringify(raw);
  assert.deepEqual(m.normalize(raw), { mainPill: ids[0],
    declaredPills: ['agent_gemini', 'ai_google', 'agent_amp', 'integration_notion'] });
  assert.equal(JSON.stringify(raw), before, 'load normalization does not mutate input');
  assert.deepEqual(m.normalize({ mainPill: 'agent_codex', declaredPills: defaults }).declaredPills, defaults);
});

test('S6 submitted state rejects types, duplicates, unknowns, main and fifth choice', () => {
  const m = M();
  const good = { mainPill: ids[0], declaredPills: [] };
  assert.equal(m.valid(good), true);
  for (const mainPill of ['unknown', 'ai_openai', null, 1]) assert.equal(m.valid({ ...good, mainPill }), false);
  for (const declaredPills of [null, 'x', [1], ['unknown'], [ids[0]],
    ['agent_amp', 'agent_amp'], ['agent_claude-desktop'], ['integration_music'],
    [...defaults, 'ai_google']]) assert.equal(m.valid({ ...good, declaredPills }), false);
});

test('S4 toggle zero-to-four choices; main is not a slot and fifth refusal is immutable', () => {
  const m = M();
  let state = { mainPill: ids[0], declaredPills: [] };
  for (const id of defaults) state = m.toggle(state, id);
  assert.deepEqual(state.declaredPills, defaults);
  const before = JSON.stringify(state);
  for (const id of [ids[0], 'ai_google', 'unknown', 'integration_music', null]) assert.equal(m.toggle(state, id), null);
  assert.equal(JSON.stringify(state), before);
  state = m.toggle(state, defaults[1]);
  assert.deepEqual(state.declaredPills, [defaults[0], defaults[2], defaults[3]]);
  assert.deepEqual(m.toggle(state, 'ai_google').declaredPills, [...state.declaredPills, 'ai_google']);
});

test('S4 main workspace-only; changing main removes new-main declaration only', () => {
  const m = M();
  const old = { mainPill: ids[0], declaredPills: ['agent_cursor', 'ai_google'] };
  assert.deepEqual(m.chooseMain(old, 'agent_cursor'), { mainPill: 'agent_cursor', declaredPills: ['ai_google'] });
  assert.deepEqual(old.declaredPills, ['agent_cursor', 'ai_google']);
  for (const id of ['ai_google', 'unknown', 'integration_music', null]) assert.equal(m.chooseMain(old, id), null);
  assert.deepEqual(m.chooseMain(old, old.mainPill), old);
  assert.equal(m.toggle({ mainPill: ids[0], declaredPills: ['agent_amp', 'agent_amp'] }, 'agent_amp'), null);
});

test('S4 order is main then external seam then catalog; rendering uses real selections only', () => {
  const m = M();
  const tasks = [{ id: 'ai_google' }, { id: 'external2' }, { id: 'agent_cursor' },
    { id: 'external1' }, { id: ids[0] }, { id: 'ai_google' }];
  assert.deepEqual(m.order(tasks, ids[0]).map(x => x.id), [ids[0], 'external2', 'external1', 'agent_cursor', 'ai_google', 'ai_google']);
  assert.deepEqual(tasks.map(x => x.id), ['ai_google', 'external2', 'agent_cursor', 'external1', ids[0], 'ai_google']);
  const state = { mainPill: ids[0], declaredPills: ['integration_notion', 'agent_amp', 'ai_google'] };
  assert.deepEqual(m.visible(state).map(x => x.id), [ids[0], 'agent_amp', 'ai_google', 'integration_notion']);
  assert.equal(m.selection(state, 'removed'), ids[0]);
  assert.equal(m.selection(state, 'ai_google'), 'ai_google');
});

test('S6 offline detail never claims provider credentials/URL imply connection', () => {
  const m = M();
  for (const def of C().CATALOG) {
    const view = m.detail(def.id, 'linux');
    assert.equal(view.connected, false);
    assert.equal(view.icon, 'plug-off');
    assert.ok(view.word && view.detail && view.aria);
    assert.doesNotMatch(view.word, /^Conectado$/);
  }
  assert.equal(m.detail('integration_music').offered, false);
  assert.equal(m.detail('agent_claude-desktop').offered, false);
  assert.equal(m.detail('unknown'), null);
});
