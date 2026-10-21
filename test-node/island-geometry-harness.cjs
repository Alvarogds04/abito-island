'use strict';
/* Real-layout harness: the REAL frontend (index.html + its CSS + its scripts) in headless Chromium, served over HTTP like the app's
   own protocol (ES module imports fail under file://), with a fake Tauri backend. It expands the island exactly as Rust does
   (window.__islandSetState('overview')) and lets a test feed sessions, notices, integrations and a pending question, then measure
   bounding boxes and hit-test with elementFromPoint. Pure-function tests cannot see overlaps: the first A+E build passed every
   suite and still drew «En reposo» over the mascot. Playwright is a dev tool of this machine: when it is absent the callers SKIP
   loudly (never pass silently). */
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

const SESSIONS = [
  { id: 's-0000000a', kind: 'codex', cwd: 'proyecto-beta', state: 'sleeping', origin: null },
  { id: 's-0000000b', kind: 'claude-code', cwd: 'api', state: 'running', origin: null },
  { id: 's-0000000c', kind: 'pi', cwd: 'workspace', state: 'sleeping', origin: null },
  { id: 's-0000000d', kind: 'gemini', cwd: 'web', state: 'sleeping', origin: null },
  { id: 's-0000000e', kind: 'opencode', cwd: 'docs', state: 'sleeping', origin: null },
];
const UUID = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b';

/** scenario = { sessions: [...]|[], notices: n, engine: 'down'|'account'|null, github: bool, question: 'plain'|'approval'|null, finished: text|null } */
async function open(scenario = {}) {
  const pw = findPlaywright();
  if (!pw) return null;
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 672, height: 340 } });
  await page.addInitScript(({ scenario, SESSIONS, UUID }) => {
    const listeners = {};
    const sessions = scenario.sessions === undefined ? SESSIONS : scenario.sessions;
    const notices = Array.from({ length: scenario.notices || 0 }, (_, i) => ({ id: `n${i + 1}`, title: scenario.noticeTitle || 'Pi terminó su turno', detail: `Resultado número ${i + 1}`, severity: 'info', kind: 'settled', expiresAt: Date.now() + 600000, agent: 'pi', projectName: 'workspace' }));
    const snap = { state: 'expanded', notices, card: null, request: null, revision: 1, motionOverride: false, unavailable: scenario.unavailable === true, connections: scenario.engine === 'down' || !scenario.engine ? 0 : 1 };
    const accounts = scenario.engine === 'account' ? [] : [{ configured: true, local: false }];
    const connection = scenario.engine === 'down' ? 'no_daemon' : 'connected';
    const pending = scenario.question ? {
      id: UUID, kind: scenario.question === 'approval' ? 'question' : 'question', agent: scenario.question === 'approval' ? 'claude-code' : 'pi', agent_label: 'Pi', project_name: 'api',
      text: scenario.question === 'approval' ? 'Claude Code asks permission: Bash: rm -rf build/ && npm run build' : '¿Qué editor preferís?',
      options: scenario.question === 'approval' ? [{ index: 0, label: 'Allow once', description: '' }, { index: 1, label: 'Deny', description: '' }] : [{ index: 0, label: 'vim', description: '' }, { index: 1, label: 'emacs', description: '' }, { index: 2, label: 'vscode', description: '' }],
      allow_free_text: scenario.question !== 'approval', expires_at: Date.now() + 600000, free_text_max: 2000,
    } : null;
    window.__TAURI__ = {
      core: { invoke: async (cmd, args) => {
        const a = args && args.payload && args.payload.action;
        if (cmd === 'desktop_action') {
          // the host's own dismissals: one id removes exactly that notice, no id removes the first (M2/#437), then the new snapshot is pushed
          if (a === 'dismiss') {
            const id = args.payload.id; const at = id ? snap.notices.findIndex(n => n.id === id) : 0;
            if (at >= 0) snap.notices.splice(at, 1);
            snap.revision += 1; queueMicrotask(() => window.__emit('desktop:state', JSON.parse(JSON.stringify(snap))));
          }
          return JSON.parse(JSON.stringify(snap));
        }
        if (cmd === 'agent_action') return a === 'sessions_list' ? { connection, accounts, sessions: { rows: sessions, truncated: false } } : { connection, accounts };
        if (cmd === 'prefs_action') return { sound: true, declaredPills: scenario.github ? ['integration_github'] : [], mainPill: 'abito', pillColors: {}, avatarColors: {}, autoCloseSeconds: 0, openOnHover: false, absenceSeconds: 600 };
        if (cmd === 'github_action') return scenario.githubData
          ? (a === 'refresh' && args.payload.section === 'pulse'
            ? { available: true, pulse: { login: 'abito', myPRs: [{ number: 1, title: 'fix', url: 'https://github.com/o/r/pull/1', ci: 'failing' }], toReview: [], mainCI: [{ name: 'ci', state: 'success' }] }, stats: null }
            : { available: true, activity: { weeks: [], total: 18 } })
          : { available: false, reason: 'gh_missing' };
        if (cmd === 'question_action') {
          // answering consumes the pending question and the host reports «answered» (the producer's ack), like the real receiver
          if (a === 'answer' || a === 'decline' || a === 'text') { window.__answered = true; const v = { available: true, pending: null, queued: [], queued_count: 0, deliveries: [], notice: 'sent' }; setTimeout(() => window.__emit('question:state', { ...v, notice: 'answered' }), 20); return v; }
          return { available: true, pending: window.__answered ? null : pending, queued: [], queued_count: 0, deliveries: [], notice: window.__answered ? 'answered' : null };
        }
        if (cmd === 'focus_host') { (window.__focusCalls ||= []).push(args.payload); return {}; }
        if (cmd === 'island_window_height') return { h: (args.payload && args.payload.h) || 340 };
        return {};
      } },
      event: { listen: async (name, fn) => { (listeners[name] ||= []).push(fn); return () => {}; } },
    };
    window.__emit = (name, payload) => (listeners[name] || []).forEach(fn => fn({ payload }));
  }, { scenario, SESSIONS, UUID });
  await page.goto(`${base}/index.html`);
  if (scenario.theme) await page.evaluate(t => { document.documentElement.dataset.theme = t; }, scenario.theme);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__islandSetState('overview'));
  if (scenario.github) await page.evaluate(() => document.dispatchEvent(new CustomEvent('abito:integration-seen', { detail: { ids: ['integration_github'], source: 'github' } })));
  if (scenario.focusGithub) { await page.waitForTimeout(600); await page.evaluate(() => document.getElementById('pill-choice-integration_github')?.click()); }
  await page.waitForTimeout(4200); // spring + the ticker's first poll
  if (scenario.question) await page.waitForTimeout(600);
  return {
    page,
    measure: sel => page.evaluate(selector => [...document.querySelectorAll(selector)].map(el => {
      const b = el.getBoundingClientRect(), s = getComputedStyle(el);
      return { id: el.id || el.className || el.tagName, left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height,
        shown: s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 && b.width > 0 && b.height > 0, text: (el.textContent || '').trim().slice(0, 40) };
    }), sel),
    /** the element that actually receives a click at the centre of each match (innermost), and whether it is the match itself/inside it */
    hit: sel => page.evaluate(selector => [...document.querySelectorAll(selector)].filter(el => {
      const b = el.getBoundingClientRect(); if (b.width <= 0 || b.height <= 0 || getComputedStyle(el).display === 'none') return false;
      // a control inside a scrolling list that is scrolled out of view is reached by scrolling, not by a click at its (clipped) box
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowY;
        if (o === 'auto' || o === 'scroll' || o === 'hidden') { const pb = p.getBoundingClientRect(); if (b.bottom > pb.bottom + 0.5 || b.top < pb.top - 0.5) return false; }
        if (p.id === 'capsule') break;
      }
      return true;
    }).map(el => {
      const b = el.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const top = document.elementFromPoint(x, y);
      return { id: el.id || el.className, ok: !!top && (top === el || el.contains(top)), at: [Math.round(x), Math.round(y)], got: top ? (top.id || top.className || top.tagName) : null };
    }), sel),
    screenshot: file => page.screenshot({ path: file }),
    close: async () => { await browser.close(); server.close(); },
  };
}
module.exports = { open, findPlaywright };
