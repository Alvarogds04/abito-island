'use strict';
/* F018 — pure diff engine: turns an edit into a renderable line/hunk model.
   No DOM, no IPC, no network. LOGIC ONLY re-expressed from Coucou's MIT
   windows/src/core/diff.ts:41-321 (louis-cfm/coucou, commit
   71b773f08101237e1ec950efdaee17a626c830e6): size guards, LCS line diff,
   hunk grouping with bounded context and the too-large count fallback.
   Nothing else is taken from upstream: no asset, icon, string or artwork;
   the names, shapes and copy below are Abito's own. Loaded as a classic
   script (window.AbitoDiffModel) and by test-node/diff-model-check.cjs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoDiffModel = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  // Guards carried over as logic (values documented in the mount contract):
  // LCS is O(m·n) in cells; everything past a limit degrades to an honest
  // count instead of a rendered diff.
  const MAX_BYTES = 200 * 1024;
  const MAX_LINES = 4000;
  const MAX_CELLS = 1000000;
  const CONTEXT = 3;

  const utf8Length = text => {
    let n = 0;
    for (const ch of String(text)) {
      const c = ch.codePointAt(0);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
  };
  const splitLines = text => {
    const parts = String(text).replace(/\r\n/g, '\n').split('\n');
    if (parts[parts.length - 1] === '') parts.pop(); // trailing newline leaves nothing behind
    return parts;
  };
  // Last path component, POSIX or Windows separators.
  function fileName(path) {
    if (typeof path !== 'string') return '';
    const cleaned = path.replace(/[\\/]+$/, '');
    const at = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
    return at >= 0 ? cleaned.slice(at + 1) : cleaned;
  }

  // ---- LCS line diff -------------------------------------------------------
  // dp[i*w+j] = LCS length of old[0..i) and new[0..j). Lengths stay under
  // MAX_LINES, so a 16-bit table is enough and half the size.
  function lineDiff(oldLines, newLines) {
    const m = oldLines.length, n = newLines.length, w = n + 1;
    const dp = new Uint16Array((m + 1) * w);
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i * w + j] = oldLines[i - 1] === newLines[j - 1]
          ? dp[(i - 1) * w + j - 1] + 1
          : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1]);
      }
    }
    // Backtrack the matched pairs, then emit the edit script between them.
    const matches = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (oldLines[i - 1] === newLines[j - 1]) { matches.push([i - 1, j - 1]); i--; j--; }
      else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) i--;
      else j--;
    }
    matches.reverse();
    const out = [];
    let prevOld = -1, prevNew = -1;
    const removed = k => ({ kind: 'removed', text: oldLines[k], origLine: k + 1, newLine: -1 });
    const added = k => ({ kind: 'added', text: newLines[k], origLine: -1, newLine: k + 1 });
    for (const [oi, ni] of matches) {
      for (let k = prevOld + 1; k < oi; k++) out.push(removed(k));
      for (let k = prevNew + 1; k < ni; k++) out.push(added(k));
      out.push({ kind: 'context', text: oldLines[oi], origLine: oi + 1, newLine: ni + 1 });
      prevOld = oi; prevNew = ni;
    }
    for (let k = prevOld + 1; k < m; k++) out.push(removed(k));
    for (let k = prevNew + 1; k < n; k++) out.push(added(k));
    return out;
  }

  // Group changed runs, padded with CONTEXT lines on each side; nearby runs
  // merge, far-apart ones stay separate hunks.
  function buildHunks(lines, context) {
    const runs = [];
    lines.forEach((line, i) => {
      if (line.kind === 'context') return;
      const start = Math.max(0, i - context), end = Math.min(lines.length - 1, i + context);
      const last = runs[runs.length - 1];
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else runs.push([start, end]);
    });
    return runs.map(([start, end]) => {
      const hunkLines = lines.slice(start, end + 1);
      const firstOld = hunkLines.find(l => l.origLine > 0);
      const firstNew = hunkLines.find(l => l.newLine > 0);
      return { origStart: firstOld ? firstOld.origLine : 1, newStart: firstNew ? firstNew.newLine : 1, lines: hunkLines };
    });
  }

  // Count the too-large case without building a diff: lines present in one
  // side only (never blank) are the honest per-direction count.
  function countFallback(oldText, newText, path) {
    const oldLines = String(oldText).split('\n');
    const newLines = String(newText).split('\n');
    const oldSet = new Set(oldLines), newSet = new Set(newLines);
    return {
      path, added: newLines.filter(l => l !== '' && !oldSet.has(l)).length,
      removed: oldLines.filter(l => l !== '' && !newSet.has(l)).length,
      hunks: [], tooLarge: true, isNewFile: false,
    };
  }

  const tooBigFor = (oldText, newText) =>
    utf8Length(oldText) + utf8Length(newText) > MAX_BYTES ||
    splitLines(oldText).length + splitLines(newText).length > MAX_LINES ||
    splitLines(oldText).length * splitLines(newText).length > MAX_CELLS;

  // A whole-file edit. Returns null for anything that is not a non-empty string.
  function fromEdit(oldText, newText, path) {
    if (typeof oldText !== 'string' || typeof newText !== 'string' || typeof path !== 'string') return null;
    if (tooBigFor(oldText, newText)) return countFallback(oldText, newText, path);
    const lines = lineDiff(splitLines(oldText), splitLines(newText));
    let added = 0, removed = 0;
    for (const l of lines) { if (l.kind === 'added') added++; else if (l.kind === 'removed') removed++; }
    return { path, added, removed, hunks: buildHunks(lines, CONTEXT), tooLarge: false, isNewFile: false };
  }

  // A brand-new file: every line is added, 1-based. Null when there is no content.
  function fromNew(content, path) {
    if (typeof content !== 'string' || !content || typeof path !== 'string') return null;
    if (utf8Length(content) > MAX_BYTES || splitLines(content).length > MAX_LINES) {
      return { path, added: splitLines(content).length, removed: 0, hunks: [], tooLarge: true, isNewFile: true };
    }
    const lines = splitLines(content).map((text, i) => ({ kind: 'added', text, origLine: -1, newLine: i + 1 }));
    return {
      path, added: lines.length, removed: 0,
      hunks: lines.length ? [{ origStart: 1, newStart: 1, lines }] : [],
      tooLarge: false, isNewFile: true,
    };
  }

  // The diff of ONE file tool call, or null when the call is not a file edit
  // or changes nothing. Closed vocabulary: Edit / MultiEdit / Write.
  function buildToolDiff(tool, input) {
    if (typeof tool !== 'string' || !input || typeof input !== 'object') return null;
    const path = typeof input.file_path === 'string' ? input.file_path : null;
    if (path == null) return null;
    if (tool === 'Edit') {
      const { old_string: oldText, new_string: newText } = input;
      if (typeof oldText !== 'string' || typeof newText !== 'string' || (!oldText && !newText)) return null;
      const d = fromEdit(oldText, newText, path);
      return d && (d.added > 0 || d.removed > 0) ? d : null;
    }
    if (tool === 'MultiEdit') {
      const edits = Array.isArray(input.edits) ? input.edits : null;
      if (!edits || edits.length === 0) return null;
      let added = 0, removed = 0, tooLarge = false;
      const hunks = [];
      for (const e of edits) {
        if (!e || typeof e !== 'object') continue;
        const oldText = typeof e.old_string === 'string' ? e.old_string : null;
        const newText = typeof e.new_string === 'string' ? e.new_string : null;
        if (oldText == null || newText == null) continue;
        const d = fromEdit(oldText, newText, path);
        if (!d) continue;
        added += d.added; removed += d.removed; hunks.push(...d.hunks);
        if (d.tooLarge) tooLarge = true;
      }
      if (added === 0 && removed === 0) return null;
      return { path, added, removed, hunks, tooLarge, isNewFile: false };
    }
    if (tool === 'Write') {
      const content = typeof input.content === 'string' ? input.content : null;
      if (!content) return null;
      const d = fromNew(content, path);
      return d && (d.added > 0 || d.removed > 0) ? d : null;
    }
    return null;
  }

  const isTooLarge = diff => !!diff && diff.tooLarge === true;
  const diffLinesCount = diff => (!!diff && Array.isArray(diff.hunks))
    ? diff.hunks.reduce((n, h) => n + (Array.isArray(h.lines) ? h.lines.length : 0), 0) : 0;

  // Documented STATIC fixture (fake data; no backend event exists yet) for
  // tests, visual probes and the mount contract examples.
  function sampleDiff() {
    return fromEdit(
      'function greet(name) {\n  console.log("hello " + name);\n  return name;\n}\n',
      'function greet(name) {\n  console.log(`hola ${name}`);\n  return name.toUpperCase();\n}\n',
      'src/greet.js');
  }

  return { MAX_BYTES, MAX_LINES, MAX_CELLS, CONTEXT, fileName, fromEdit, fromNew, buildToolDiff, isTooLarge, diffLinesCount, sampleDiff };
});
