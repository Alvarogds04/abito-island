'use strict';
/* Real-layout harness for the Ajustes window (settings.html): the REAL frontend (its CSS and scripts) in headless Chromium, served
   over HTTP like the app's own protocol, with a fake Tauri backend shaped like the real hosts (including their awkward answers:
   agents all in `error`, the portal's own «Pulse <Shift><Control>n» key description). Pure DOM-fake tests cannot see a clipped card, a
   slider on the edge or a title that breaks «Wi-/Fi.»; the human's screen validation found all three after every suite was green.
   Playwright is a dev tool of this machine: absent => callers SKIP loudly (never pass silently). */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
function findPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, path.join(process.env.HOME || '', '.local/lib/node_modules/playwright'), 'playwright', 'playwright-core'].filter(Boolean);
  for (const c of candidates) { try { return require(c); } catch { /* next */ } }
  return null;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serve() {
  const server = http.createServer((req, res) => {
    const f = path.join(frontend, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    if (!f.startsWith(frontend) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** scenario = { width, height, statusDelayMs, page } ; page = a hub page id to open (via the Rust-provided hint, like a deep link) */
async function open(scenario = {}) {
  const pw = findPlaywright();
  if (!pw) return null;
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: scenario.width || 960, height: scenario.height || 640 } });
  await page.addInitScript(({ scenario }) => {
    const listeners = {}; const calls = []; window.__calls = calls;
    if (scenario.page) window.__abitoHubPage = scenario.page;
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const prefs = { sound: true, gain: .12, autoCloseSeconds: 15, absenceSeconds: 10, openOnHover: false, declaredPills: ['agent_codex', 'ai_google', 'integration_github', 'integration_vercel'], pillColors: {}, avatarColors: {}, mainPill: 'integration_claude', theme: 'system', displayName: 'Alvaro', monitor: null, chosenModels: {}, windowContext: false, windowContextAvailable: true, abitoInstructions: '', islandAgents: [], showPlanInNotch: false, showCodexPlanInNotch: false, openSettingsAtLaunch: false };
    const dictation = { prefs: { enabled: true, key: 'right_ctrl', edge: 'bottom', mic: '', keepDays: 30, cleanup: false, defaultStyle: 'natural' }, models: { parakeet: { state: 'ready' }, downloadMb: 612 }, keys: 'ok', hasClaudeKey: false, mics: [{ name: 'Micrófono USB', default: true }], platform: 'linux', autostarted: false };
    const agentIds = ['claude-code', 'codex', 'copilot-cli', 'opencode', 'recap', 'statusline'];
    const agents = agentIds.map(id => ({ id, state: 'error' })); // the real daemon in the validation run answered `error` for every agent
    const binding = id => ({ combo: id === 'toggleIsland' ? 'Ctrl+Alt+A' : 'Ctrl+Alt+T', effective: 'Pulse <Shift><Control>n', enabled: true, status: 'active' });
    window.__TAURI__ = {
      core: { invoke: async (cmd, args) => {
        const p = (args && args.payload) || {}; const a = p.action; calls.push([cmd, a]);
        if (cmd === 'dictation_action') { if (a === 'status') { await delay(scenario.statusDelayMs || 0); return structuredClone(dictation); } return a === 'history' ? [] : a === 'stats' ? { all: { words: 0, wordsPerMinute: 0 }, streak: 0 } : { ok: true }; }
        if (cmd === 'prefs_action') return a === 'autostart_view' ? { enabled: false } : structuredClone(prefs);
        if (cmd === 'hotkey_action') return binding(p.id || 'toggleIsland');
        if (cmd === 'recap_action') return a === 'prefs' ? { enabled: true } : { ok: true };
        if (cmd === 'monitor_action') return { monitors: [{ key: 'DP-1' }] };
        if (cmd === 'sound_action') return a === 'list' ? { names: [] } : { ok: true };
        if (cmd === 'secret_action') return { present: false };
        if (cmd === 'models_action') return { profiles: [] };
        if (cmd === 'specialists_action') return { specialists: [], active: null };
        if (cmd === 'plan_action') return { available: false };
        if (cmd === 'voice_action') return { prefs: { enabled: false, output: 'system', gender: 'female', sensitivity: 50 }, vad: { state: 'ready' }, parakeet: { state: 'ready' }, listening: false, error: null };
        if (cmd === 'agent_action') {
          const base = { connection: 'connected', providers: [{ id: 'pi', name: 'Pi', configured: false, methods: ['api_key'] }, { id: 'claude', name: 'Claude', configured: true, methods: ['oauth'] }], accounts: [{ accountId: 'acc-claude', provider: 'claude', configured: true, label: 'alvaro@x' }], ownedAccounts: { accounts: [] }, auth: {}, connectors: { items: [] }, sessions: { rows: [], truncated: false } };
          return a === 'agents_list' || a === 'hooks_preview' ? { ...base, agents } : base;
        }
        if (cmd === 'daemon_action') return { ok: true };
        return {};
      } },
      event: { listen: async (name, fn) => { (listeners[name] ||= []).push(fn); return () => {}; } },
    };
    window.__emit = (name, payload) => (listeners[name] || []).forEach(fn => fn({ payload }));
  }, { scenario });
  const began = Date.now();
  await page.goto(`${base}/settings.html`);
  return {
    page, began,
    /** wait until the shell (sidebar) exists; ms since navigation */
    shellAfter: async () => { await page.waitForSelector('.hub-side .hub-item', { timeout: 15000 }); return Date.now() - began; },
    /** open a sidebar entry by its visible title and wait for its page */
    go: async title => {
      await page.waitForSelector('.hub-side .hub-item', { timeout: 15000 });
      await page.locator('.hub-side .hub-item', { hasText: title }).first().click();
      await page.waitForTimeout(700);
    },
    measure: sel => page.evaluate(selector => [...document.querySelectorAll(selector)].map(el => {
      const b = el.getBoundingClientRect(), s = getComputedStyle(el);
      return { id: el.id || el.className || el.tagName, left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height, scrollW: el.scrollWidth, clientW: el.clientWidth,
        shown: s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0, text: (el.textContent || '').trim().slice(0, 60) };
    }), sel),
    text: sel => page.evaluate(selector => document.querySelector(selector)?.textContent || '', sel),
    calls: () => page.evaluate(() => window.__calls.slice()),
    screenshot: file => page.screenshot({ path: file }),
    close: async () => { await browser.close(); server.close(); },
  };
}
module.exports = { open, findPlaywright };
