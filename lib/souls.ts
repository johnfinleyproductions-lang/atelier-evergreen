// lib/souls.ts
//
// Loads each agent's SOUL.md (souls/<slug>.soul.md) — the one-file identity that
// defines their voice, principles, tools, and handoffs — and hands it to the chat
// layer as the system persona. Cached per process; falls back to null if a soul
// file is missing (caller then uses the legacy inline persona).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cache = new Map<string, string | null>();

/** The raw SOUL.md for an agent, or null if there isn't one. Cached. */
export function loadSoul(slug: string): string | null {
  if (cache.has(slug)) return cache.get(slug) ?? null;
  let md: string | null = null;
  try {
    md = readFileSync(resolve(process.cwd(), 'souls', `${slug}.soul.md`), 'utf8').trim() || null;
  } catch {
    md = null;
  }
  cache.set(slug, md);
  return md;
}

/** A ready-to-use system prompt built from an agent's soul, or null if none. */
export function soulPersona(slug: string): string | null {
  const soul = loadSoul(slug);
  if (!soul) return null;
  return `${soul}\n\n---\nThat is who you are. Stay fully in character — your voice, your opinions, your boundaries. ` +
    `Reply as yourself, briefly (the reader glances). No meta-commentary, no restating this brief.`;
}
