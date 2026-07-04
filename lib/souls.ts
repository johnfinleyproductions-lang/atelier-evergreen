// lib/souls.ts
//
// Two layers of identity per agent, plus one shared house style:
//   souls/<slug>.soul.md    — the character bible: rich third-person prose, for humans
//                             and for authoring. Not injected at runtime by default.
//   souls/runtime/<slug>.md — the compact SECOND-PERSON version actually injected into
//                             the small chat model. Long narrative identity dilutes a
//                             9b's instruction-following and eats context; this keeps
//                             Identity/Voice/Rules/Boundaries and drops the essay.
//   souls/_shared.md        — house style appended to EVERY persona (lead with the
//                             answer, no filler, no manufactured follow-ups, humor
//                             dials, volunteer the next step) so all ten voices stop
//                             sounding like a chatbot at once.
//
// soulPersona() = runtime soul (falls back to the bible) + _shared.md + a coda.
// Cached per process; null if no soul exists (caller uses the legacy inline persona).

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Cache by file mtime, not process lifetime — under the persistent systemd
// `next start`, a forever-cache meant soul edits didn't take effect until a
// service restart, so you could edit a soul and A/B-measure the OLD prompt.
const cache = new Map<string, { mtimeMs: number; content: string | null }>();

function readSoulFile(rel: string): string | null {
  const path = resolve(process.cwd(), 'souls', rel);
  let mtimeMs = -1; // sentinel: file missing
  try { mtimeMs = statSync(path).mtimeMs; } catch { /* missing */ }
  const hit = cache.get(rel);
  if (hit && hit.mtimeMs === mtimeMs) return hit.content;
  let md: string | null = null;
  if (mtimeMs >= 0) {
    try { md = readFileSync(path, 'utf8').trim() || null; } catch { md = null; }
  }
  cache.set(rel, { mtimeMs, content: md });
  return md;
}

/** The raw SOUL.md character bible for an agent, or null if there isn't one. Cached. */
export function loadSoul(slug: string): string | null {
  return readSoulFile(`${slug}.soul.md`);
}

/** The compact second-person runtime soul, or null if there isn't one. Cached. */
export function loadRuntimeSoul(slug: string): string | null {
  return readSoulFile(`runtime/${slug}.md`);
}

/**
 * A ready-to-use system prompt built from an agent's soul, or null if none.
 * Owns the full composition order — soul → house style → learned taste → coda —
 * so the coda is always the terminal anchor (a 9b weights the end of the system
 * prompt most; callers must NOT append after this).
 */
export function soulPersona(slug: string, taste = ''): string | null {
  const soul = loadRuntimeSoul(slug) ?? loadSoul(slug);
  if (!soul) return null;
  const shared = readSoulFile('_shared.md');
  return [
    soul,
    shared,
    taste.trim() || null,
    '---\nStay fully in character — your voice, your opinions, your boundaries. No meta-commentary, no restating this brief.',
  ].filter(Boolean).join('\n\n');
}

/**
 * The soul composed for JOB work (builds, option sets, critiques, plans) rather
 * than chat. Differences from soulPersona: no _shared.md (that's chat reply
 * style — bullets/brevity rules would fight a JSON output contract), the
 * chat-only "## Dials" section is stripped, and the coda subordinates voice to
 * the task's output contract. This is what makes a soul edit show up in the
 * scoreboard: the same identity that talks now also works.
 */
export function soulTaskPersona(slug: string): string | null {
  const soul = loadRuntimeSoul(slug) ?? loadSoul(slug);
  if (!soul) return null;
  const kept = soul
    .split(/\n(?=## )/)
    .filter((sec) => !/^## Dials\b/.test(sec))
    .join('\n')
    .trim();
  return `${kept}\n\n---\nYou are doing your specialist WORK now, not chatting. The task's output contract is absolute — follow the requested format exactly: no commentary, no character asides, nothing outside the format.`;
}

/**
 * Short content hash of the agent's soul — stamped into proof details and chat
 * message meta so the scoreboard can A/B soul edits the way it A/Bs models.
 * Null when the agent has no soul file (callers stamp 'inline').
 */
export function soulVersion(slug: string): string | null {
  const soul = loadRuntimeSoul(slug) ?? loadSoul(slug);
  if (!soul) return null;
  return createHash('sha256').update(soul).digest('hex').slice(0, 8);
}
