// The states to capture. Each side gets a page-side script that drives the real app into the state.
// Sizes are Coucou's own window size for that state (island window 720x320, settings window 1100x720).
const ISLAND = { w: 720, h: 320 };
const SETTINGS = { w: 1100, h: 720 };

// ── Coucou side: hook events, exactly what Claude Code / Codex send ──
const cHook = (o) => `__vcEmit('hook', ${JSON.stringify(o)});`;
const cStart = (a) => cHook({ hook_event_name: 'SessionStart', session_id: a.sessionId, cwd: a.cwd, ...(a.id === 'codex' ? { coucou_agent: 'codex' } : {}) })
  + cHook({ hook_event_name: 'UserPromptSubmit', session_id: a.sessionId, cwd: a.cwd, prompt: a.prompt, ...(a.id === 'codex' ? { coucou_agent: 'codex' } : {}) })
  + cHook({ hook_event_name: 'PreToolUse', session_id: a.sessionId, cwd: a.cwd, tool_name: a.tool, tool_input: a.toolInput, ...(a.id === 'codex' ? { coucou_agent: 'codex' } : {}) });
const cAll = (f) => f.agents.map(cStart).join('\n');
const cCompact = () => `__vcCoucou.island.setMode('compact');`;

// ── Abito side: host snapshots ──
const aSet = (scn, view) => `__vcAbitoSet(${scn}); window.__islandSetState(${JSON.stringify(view)}); setTimeout(() => __vcAbitoSet({}), 1200);`;

export function buildStates(f) {
  const claude = f.agents[0];
  const sessions = `{ type:'sessions', schema:'abito-sessions/view/1', truncated:false, sessions:[
    { id:'s-0123abcd', kind:'claude-code', cwd:${JSON.stringify(f.agents[0].project)}, state:'running', origin:null },
    { id:'s-4567ef01', kind:'codex', cwd:${JSON.stringify(f.agents[1].project)}, state:'running', origin:null } ] }`;
  const expanded = `snapshot:{ state:'expanded' }`;
  const q = f.question;
  const spot = f.spotify;
  const spotState = `{ running:true, installed:true, playing:${spot.playing}, track:{ id:'t1', title:${JSON.stringify(spot.title)}, artist:${JSON.stringify(spot.artist)}, album:${JSON.stringify(spot.album)}, duration:${spot.durationSec} } }`;
  const settingsPages = [
    // [id, title, coucou page, abito tab or null]
    ['general', 'Settings · General', 'general', 'general'],
    ['appearance', 'Settings · Appearance', null, 'appearance'],
    ['agents', 'Settings · Agents', 'agents', null],
    ['shortcuts', 'Settings · Shortcuts', 'shortcuts', null],
    ['pills', 'Settings · Pills', 'pills', 'pills'],
    ['integrations', 'Settings · Integrations', 'integrations', 'accounts'],
    ['chat', 'Settings · Chat / Providers', 'chat', 'accounts'],
    ['flow', 'Settings · Flow (dictation)', 'dictation', null],
    ['phone', 'Settings · Phone', 'phone', null],
  ];
  const states = [
    { id: 'compact', title: 'Island compact', expected: 'Abito keeps its 32 px disc by owner decision (Coucou: 288x32 bar).', ...ISLAND,
      coucou: { page: 'island', run: cCompact() }, abito: { label: 'main', run: aSet(`{}`, 'compact') } },
    { id: 'overview', title: 'Overview, 2 agents', ...ISLAND,
      coucou: { page: 'island', run: cAll(f) + `__vcCoucou.island.expand('overview');` },
      abito: { label: 'main', run: aSet(`{ ${expanded}, sessions:${sessions} }`, 'overview'), settle: 2800 } },
    { id: 'approval', title: 'Approval card (PermissionRequest)', ...ISLAND,
      coucou: { page: 'island', run: cStart(claude) + cHook({ hook_event_name: 'PermissionRequest', request_id: f.approval.requestId, session_id: claude.sessionId, cwd: claude.cwd, tool_name: f.approval.tool, tool_input: { command: f.approval.command } }) },
      abito: { label: 'main', run: aSet(`{ snapshot:{ state:'expanded', card:{ operation:${JSON.stringify(f.approval.tool + ' · ' + f.approval.command)}, expires_at:new Date(Date.now()+100000).toISOString(), reason:null, state:'pending' } } }`, 'overview') } },
    { id: 'question', title: 'Question card', ...ISLAND,
      coucou: { page: 'island', run: cStart(claude) + cHook({ hook_event_name: 'PermissionRequest', request_id: f.question.requestId, session_id: claude.sessionId, cwd: claude.cwd, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q.text, options: q.options, multiSelect: false }] } }) },
      abito: { label: 'main', run: aSet(`{ ${expanded}, question:{ available:true, notice:null, revision:2, pending:{ id:__vcAbitoUuid(7), kind:'question', agent:'claude-code', text:${JSON.stringify(q.text)}, options:${JSON.stringify(q.options.map((o, i) => ({ index: i, ...o })))}, allow_free_text:false, expires_at:Date.now()+100000 } } }`, 'overview') } },
    { id: 'notices', title: 'Notices / finished lane', ...ISLAND,
      coucou: { page: 'island', run: cStart(claude) + `__vcCoucou.State.setFocus('integration_claude');` + cHook({ hook_event_name: 'Stop', session_id: claude.sessionId, cwd: claude.cwd, last_assistant_message: f.finished.message }) },
      abito: { label: 'main', run: aSet(`{ ${expanded}, snapshot:{ state:'expanded', notices:[{ id:__vcAbitoUuid(9), kind:'settled', title:'Pi terminó su turno', detail:${JSON.stringify(f.finished.message)}, severity:'info', expiresAt:Date.now()+55000 }] } }`, 'overview') + `__vcEmit('desktop:notice-open', { id: __vcAbitoUuid(9), kind: 'finished' });` } },
    { id: 'spotify', title: 'Spotify now-playing', ...ISLAND,
      coucou: { page: 'island', settings: { activeIntegrations: ['integration_spotify'], mainPill: 'integration_spotify' },
        run: `__vcEmit('spotify', { running:true, installed:true, track:{ id:'t1', title:${JSON.stringify(spot.title)}, artist:${JSON.stringify(spot.artist)}, album:${JSON.stringify(spot.album)}, durationSec:${spot.durationSec}, artUrl:'' }, playing:true, position:${spot.positionSec}, positionAt:Date.now(), shuffle:false, repeat:false, volume:50 });__vcCoucou.State.setFocus('integration_spotify');__vcCoucou.island.expand('overview');` },
      abito: { label: 'main', run: aSet(`{ ${expanded}, spotify:${spotState}, prefs:{ mainPill:'integration_spotify', declaredPills:['integration_spotify'] } }`, 'overview'), settle: 1500 } },
  ];
  for (const [id, title, cPage, aTab] of settingsPages) {
    states.push({ id: `settings-${id}`, title, ...SETTINGS,
      coucou: cPage ? { page: 'settings', run: `__vcEmit('hub-page', ${JSON.stringify(cPage)});` } : null,
      abito: aTab ? { label: 'settings', click: `#settings-tab-${aTab}`, run: '0' } : null });
  }
  return states;
}
