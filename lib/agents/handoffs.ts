// lib/agents/handoffs.ts
//
// The proactive half of the job queue. Background jobs finish long after the
// chat turn that enqueued them, so the enqueue ack ("I'll post it shortly")
// was where the conversation died — the result landed on the project log and
// nobody volunteered the next step. This module closes that loop: when a job
// finishes, the owning agent reports back in their own chat thread — result
// first, then a volunteered handoff, per the house style in souls/_shared.md
// ("propose, don't wait to be asked") and each soul's Handoffs section.
//
// A volunteered handoff is not just prose: it ships a machine-readable
// nextStep in the message's meta, so a plain "yes" in that thread executes the
// real enqueue (lib/agents/chat.ts runTool layer 2) instead of being
// role-played by the model.
//
// Messages are best-effort: a failure to post never fails the job.

import { sql } from '../db';
import { ATELIER_WS } from '../atelier';

/** A concrete, executable follow-up the user can accept with a plain "yes". */
export interface NextStep {
  kind: 'hugo_build' | 'marlowe_critique' | 'wren_headlines' | 'wren_rerun' | 'remy_script';
  [k: string]: unknown;
}

export interface CompletionMessage { text: string; nextStep?: NextStep }

async function postToThread(slug: string, content: string, meta?: Record<string, unknown>, thread = 'default'): Promise<void> {
  await sql`insert into atelier_message (workspace_id, agent_slug, thread, role, content, meta)
            values (${ATELIER_WS}, ${slug}, ${thread}, 'assistant', ${content}, ${sql.json((meta ?? {}) as never)})`;
}

// Minimal views of the runner result shapes (owned by lib/agents/*).
interface HugoR { ok: boolean; proofPass: boolean; matchScore: number; paletteDeltaE: number | null; copyText?: string; error?: string }
interface VeraR { angles: string[]; grounded: boolean; error?: string }
interface LenaR { audience: string; channels: { name: string; format?: string; angle?: string }[]; error?: string }
interface RemyR { hook: string; beats: unknown[]; error?: string }
interface MarloweR { ok: boolean; subject?: string; critique: { verdict: string; score: number; note: string; issues: { problem: string; fix?: string }[] } | null; error?: string }

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The in-character completion message for a finished job: verdict first, then
 * the volunteered next step (with its executable nextStep when one exists).
 * Exported separately so it can be tested without a DB.
 */
export function jobCompletionMessage(kind: string, result: unknown): CompletionMessage | null {
  switch (kind) {
    case 'hugo_build': {
      const r = result as HugoR;
      if (!r.ok || !r.proofPass) {
        const why = r.error
          ?? (r.paletteDeltaE != null
            ? `palette measured off — ΔE ${r.paletteDeltaE.toFixed(1)} out of tolerance`
            : `render-QC failed (score ${pct(r.matchScore ?? 0)})`);
        return { text: `Build didn't pass — ${why}. Nothing advanced; it stays with me. Say "build …" again when you want another pass.` };
      }
      const de = r.paletteDeltaE != null ? `, ΔE ${r.paletteDeltaE.toFixed(1)} max` : '';
      const base = `Build passed — render cleared the gate (score ${pct(r.matchScore)}${de}). Proven HTML + screenshot are on the project.`;
      if (r.copyText) {
        return {
          text: `${base} Want Marlowe to read the copy on it?`,
          nextStep: { kind: 'marlowe_critique', content: r.copyText, subject: 'the copy on the new build' },
        };
      }
      return { text: base };
    }
    case 'vera_research': {
      const r = result as VeraR;
      if (!r.angles?.length) {
        return { text: `I couldn't get a plan out of that brief${r.error ? ` (${r.error})` : ''}. Nothing was posted — give me a sharper one?` };
      }
      const g = r.grounded ? '' : ' All angles are marked (unverified) — no knowledge key wired.';
      return {
        text: `Research plan's on the project log — ${r.angles.length} angles.${g} Worth checking first: "${r.angles[0]}". Want Wren on that one?`,
        nextStep: { kind: 'wren_headlines', brief: `headlines for: ${r.angles[0]}` },
      };
    }
    case 'marlowe_review': {
      const r = result as MarloweR;
      if (!r.ok || !r.critique) {
        const why = r.error === 'NO_WREN_DECISION' ? "there's no option set of Wren's to review" : (r.error ?? 'nothing parseable came back');
        return { text: `No read — ${why}.` };
      }
      const c = r.critique;
      if (c.verdict === 'ship') {
        return { text: `Ship. ${c.note || 'On-voice, nothing material to fix.'} (on-voice ${pct(c.score)}.) Cleared for your pick.` };
      }
      const first = c.issues.length
        ? `${c.issues.length} thing${c.issues.length > 1 ? 's' : ''} — first: ${c.issues[0].problem}.`
        : (c.note || 'It drifts off-voice.');
      return {
        text: `Revise. ${first} The read's logged on the project. Want Wren to re-run the set with the fixes?`,
        nextStep: {
          kind: 'wren_rerun',
          question: r.subject ?? 'the option set',
          issues: c.issues.map((i) => (i.fix ? `${i.problem} → ${i.fix}` : i.problem)),
        },
      };
    }
    case 'marlowe_critique': {
      const r = result as MarloweR;
      if (!r.ok || !r.critique) {
        return { text: `Couldn't get a clean read on ${r.subject ?? 'that'}${r.error ? ` (${r.error})` : ''}. No verdict recorded.` };
      }
      const c = r.critique;
      if (c.verdict === 'ship') {
        return { text: `Read ${r.subject ?? 'it'}. Ship. ${c.note || 'On-voice, nothing material to fix.'} (on-voice ${pct(c.score)}.) Logged to the project.` };
      }
      const fixes = c.issues.slice(0, 3).map((i) => `• ${i.problem}${i.fix ? ` → ${i.fix}` : ''}`).join('\n');
      return { text: `Read ${r.subject ?? 'it'}. Revise. (on-voice ${pct(c.score)}.)\n${fixes || c.note}\nLogged to the project; the fixes go back to the owner.` };
    }
    case 'lena_plan': {
      const r = result as LenaR;
      if (!r.channels?.length) {
        return { text: `I couldn't build a plan from that${r.error ? ` (${r.error})` : ''}. Who's the audience, exactly? Give me that and I'll re-cut it.` };
      }
      const video = r.channels.find((c) => /video|reel|short|youtube|tiktok/i.test(`${c.name} ${c.format ?? ''}`));
      const base = `Distribution plan's on the project log — ${r.audience || 'audience named'}, ${r.channels.length} channels, one CTA.`;
      if (video) {
        return {
          text: `${base} The ${video.name} slot needs motion — want Remy to script it?`,
          nextStep: { kind: 'remy_script', brief: video.angle ? `${video.name}: ${video.angle}` : `${video.name} for ${r.audience || 'the plan'}` },
        };
      }
      return { text: `${base} Want Marlowe's read on the hooks before anything fires? Paste them to him with "critique: …".` };
    }
    case 'remy_script': {
      const r = result as RemyR;
      if (!r.beats?.length) {
        return { text: `No script — the angle wasn't sharp enough to hang a first frame on${r.error ? ` (${r.error})` : ''}. Send it back with the hook named and I'll shoot it.` };
      }
      return { text: `Script's on the project log — hook: "${r.hook}", ${r.beats.length} beats, one CTA. Next stop is the Resolve pipeline when you're ready.` };
    }
    default:
      return null; // unknown kind → stay silent rather than speak out of character
  }
}

/** Post the owning agent's completion report (+ volunteered handoff) to their chat thread. */
export async function announceJobResult(kind: string, agentSlug: string, result: unknown): Promise<void> {
  const msg = jobCompletionMessage(kind, result);
  if (msg) await postToThread(agentSlug, msg.text, msg.nextStep ? { nextStep: msg.nextStep } : undefined);
}

/** Post an honest failure note — plain, no humor (house style), nothing dressed up. */
export async function announceJobError(kind: string, agentSlug: string, error: string): Promise<void> {
  await postToThread(agentSlug, `That background job (${kind.replace(/_/g, ' ')}) failed — ${error}. Nothing was posted.`);
}
