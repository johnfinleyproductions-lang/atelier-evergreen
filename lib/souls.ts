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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cache = new Map<string, string | null>();

function readSoulFile(rel: string): string | null {
  if (cache.has(rel)) return cache.get(rel) ?? null;
  let md: string | null = null;
  try {
    md = readFileSync(resolve(process.cwd(), 'souls', rel), 'utf8').trim() || null;
  } catch {
    md = null;
  }
  cache.set(rel, md);
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
