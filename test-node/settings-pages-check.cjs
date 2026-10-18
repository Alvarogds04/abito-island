'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { dom, Element, all, text } = require('./settings-accounts-check.cjs');
(async () => {
  dom();
  const base = path.resolve(__dirname, '../frontend/vendor/coucou/hub');
  const { inactivePages, renderUnavailable } = await import(pathToFileURL(path.join(base, 'pages.js')));
  const { hero } = await import(pathToFileURL(path.join(base, 'hero.js')));
  const ids = ['dictation','notes','insights','dictionary','snippets','styles','flowsettings','general','pills','agents','chat','voice','integrations','phone','shortcuts'];
  const invoked = [], disposed = [];
  let config;
  const fake = name => async opts => { invoked.push([name, opts.page]); return Object.assign(new Element('section'), { dispose() { disposed.push(name); } }); };
  const source = fs.readFileSync(path.resolve(__dirname, '../frontend/settings-app.js'), 'utf8').replace(/^import .*;\n/gm, '');
  const host = new Element('div'); document.getElementById = () => host;
  vm.runInNewContext(source, { window: {}, document, inactivePages, renderUnavailable,
    renderAccounts: fake('accounts'), renderModels: fake('models'), renderPills: fake('pills'),
    renderAgentSettings: fake('agent-settings'), renderChatSettings: fake('chat-settings'),
    renderGeneral: fake('general'), card: x => x, row: () => new Element('div'),
    startHub: async (_root, opts) => { config = opts; }, Set, Promise });
  for (const id of ids) {
    const container = new Element('div');
    invoked.length = 0;
    if (config.flowPages[id]) {
      await config.flowPages[id](container, { hero, status: { prefs: { key: 'right_ctrl' }, platform: 'linux' } });
      assert(all(container).some(e => e.className.includes('hub-hero')), id);
      assert(text(container).includes('pendiente de conectar'), id);
    } else {
      const cleanup = await config.renderNotch(id, container);
      const expected = {general:[['general',undefined]], pills:[['pills','pills']], agents:[['agent-settings',undefined],['pills','agents']], chat:[['chat-settings',undefined],['models',undefined],['accounts','chat']], integrations:[['accounts','integrations']]}[id];
      if (expected) { assert.deepEqual(invoked, expected); assert(container.children.length); cleanup?.(); }
      else { assert(text(container).includes(id === 'phone' ? 'No disponible' : 'pendiente de conectar')); }
    }
    for (const e of all(container).filter(e => ['button','input','select','textarea'].includes(e.tagName))) assert.equal(e.disabled, true, id);
  }
  assert(source.includes("page === 'pills' || page === 'agents'"), 'pills and agents retain the existing closed planner');
  assert(disposed.includes('agent-settings') && disposed.includes('chat-settings'), 'new page adapters are disposed');
  const generalSource = fs.readFileSync(path.join(base,'general.ts'),'utf8');
  assert(generalSource.includes("t('Weekly recap')"), 'General includes the upstream recap rows');
  assert(disposed.includes('accounts') && disposed.includes('models') && disposed.includes('pills'));
  console.log('PASS settings-pages: 15 routes, mapped renderer lifecycles, inactive controls and hero bands');
})().catch(e => { console.error(e); process.exitCode = 1; });
