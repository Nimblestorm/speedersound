// Pure presentation helpers (no DOM) so they can be unit tested.
import { UNITS } from './config.js';

export function formatSpeed(mps, units) {
  const v = Number.isFinite(mps) ? mps / (UNITS[units] ?? UNITS.mph) : 0;
  return String(Math.max(0, Math.round(v)));
}

export function statusText({ gpsAge, gpsAccuracy, motion, sound, calibrated, silentSuspected, wakeMode }) {
  const lines = [];
  if (!(gpsAge < 3)) lines.push('GPS: none');
  else if (gpsAccuracy < 30) lines.push('GPS: good');
  else lines.push('GPS: weak');
  lines.push(`Motion: ${motion}`);
  lines.push(`Sound: ${sound ?? 'off'}`);
  lines.push(calibrated ? 'Calibrated' : 'Not calibrated');
  lines.push({ wakelock: 'Screen: wake lock', video: 'Screen: video fallback' }[wakeMode] ?? 'Screen: may lock');
  if (silentSuspected) lines.push('Check ring/silent switch');
  return lines;
}

export function buildReport({ userAgent, version, status, throttle, events }) {
  const out = [`Speeder diagnostics v${version}`, `time: ${new Date().toISOString()}`, `ua: ${userAgent}`, ''];
  for (const [k, v] of Object.entries(status)) out.push(`${k}: ${typeof v === 'number' ? +v.toFixed(2) : v}`);
  out.push(`throttle: ${+Number(throttle).toFixed(2)}`, '', 'last events:');
  if (!events.length) out.push('  (none)');
  for (const e of events) out.push(`  t=${e.t.toFixed(1)}s ${e.type}${e.strength != null ? ` strength=${e.strength.toFixed(2)}` : ''}`);
  return out.join('\n');
}

export const isIOS = (ua) => /iPhone|iPad|iPod/.test(ua || '');
