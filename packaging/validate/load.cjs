'use strict';
// The gate's load warning (#503). A scene that times out on a machine that is busy with other builds is not necessarily broken, so
// the report says so next to the failure. It NEVER changes a verdict or the exit code, and it does not touch the scene timeouts
// (raising them would hide real slowness). Everything below is pure: the real reader at the bottom feeds it /proc.

/** «1min 5min 15min running/total lastpid» (/proc/loadavg) -> numbers, or null when it is not that. */
function parseLoadavg(text) {
  if (typeof text !== 'string') return null;
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const [load1, load5, load15] = parts.slice(0, 3).map(part => (/^\d+(\.\d+)?$/.test(part) ? Number(part) : NaN));
  return [load1, load5, load15].every(Number.isFinite) ? { load1, load5, load15 } : null;
}

/** The machine's load, the core count, the threshold (cores / 2) and how many cargo/rustc processes are running. */
function snapshot({ loadavgText, cores, processNames = [] }) {
  const load = parseLoadavg(loadavgText);
  if (!load || !Number.isInteger(cores) || cores <= 0) return { available: false };
  const threshold = cores / 2;
  return { available: true, ...load, cores, threshold, high: load.load1 > threshold,
    builders: processNames.filter(name => name === 'cargo' || name === 'rustc').length };
}

const isTimeoutReason = reason => typeof reason === 'string' && reason.includes('tiempo agotado');

/** A failed scene with the load at that moment. A timeout above the threshold also says «posible carga» in its reason. */
function annotateFailure(scene, load) {
  if (!scene || scene.verdict !== 'fail') return scene;
  const possibleLoad = !!(load && load.available && load.high && isTimeoutReason(scene.reason));
  const reason = possibleLoad ? `${scene.reason} — posible carga (load ${load.load1} > ${load.threshold}, ${load.builders} cargo/rustc)` : scene.reason;
  return { ...scene, reason, possibleLoad, load };
}

/** The real machine: /proc/loadavg, the CPU count and the running process names. Any read that fails reads as «unavailable». */
function readSnapshot(fs = require('node:fs'), os = require('node:os')) {
  let loadavgText = '', processNames = [];
  try { loadavgText = fs.readFileSync('/proc/loadavg', 'utf8'); } catch { /* not Linux, or unreadable */ }
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try { processNames.push(fs.readFileSync(`/proc/${entry}/comm`, 'utf8').trim()); } catch { /* the process ended */ }
    }
  } catch { /* no /proc */ }
  return snapshot({ loadavgText, cores: os.cpus().length, processNames });
}

module.exports = { parseLoadavg, snapshot, isTimeoutReason, annotateFailure, readSnapshot };
