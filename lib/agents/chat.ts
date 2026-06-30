// lib/agents/chat.ts
//
// Generic "talk to any employee" chat — the in-app way to converse with your
// whole team, no Slack needed. Reuses the per-agent atelier_message store and
// the taste memory. Everyone routes through a local model (no cloud); each gets
// a role-appropriate persona.

import { sql } from '../db';
import { ATELIER_WS } from '../atelier';
import { recallTasteForPrompt } from '../taste-memory';
import { generateHeadlines } from './wren';
import { enqueueHugoBuild } from '../jobs';
import { getStyleCard, getDefaultBrandRubric } from '../style-repo';
import { resolveSpec } from '../merge-ledger';

const PUBLIC_URL = process.env.ATELIER_PUBLIC_URL ?? 'http://192.168.4.200:3040';

// ── Real tools: when you ASK an agent to do something, it does it ──────────
// Returns a result string when a tool fired, else null (→ conversational reply).
async function runTool(slug: string, message: string): Promise<string | null> {
  const m = message.trim();

  // Wren: "headlines / copy / titles ..." → really generate them.
  if (slug === 'wren' && /\b(headline|headlines|copy|titles?|tagline|hook|subject lines?)\b/i.test(m)) {
    const taste = await recallTasteForPrompt('wren_option');
    const g = await generateHeadlines(m, 6, taste);
    if (!g.ok) return null;
    return `Here are 6${taste ? ' (tuned to your taste)' : ''}:\n` + g.headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  }

  // Hugo: an imperative "build/make/create ..." → kick off a background build.
  // The coder model + Visual-QA gate take ~30–90s, so we enqueue and ack instantly
  // instead of blocking the chat turn; the result lands in Latest Outputs.
  if (slug === 'hugo' && /^(build|make|create|code)\b/i.test(m)) {
    const brief = m.replace(/^(build|make|create|code)\b/i, '').trim() || m;
    const jobId = await enqueueHugoBuild('launch-course-19', brief);
    return `On it — building that now (qwen2.5-coder, then the on-brand QC gate; ~30–90s). It'll appear in the project's Latest Outputs once the proof passes. Track it: ${PUBLIC_URL}/project/launch-course-19 · job ${jobId.slice(0, 8)}`;
  }

  // Iris: "design / style / layout ..." → resolve real brand+style direction.
  if (slug === 'iris' && /^(design|style|lay\s?out|mock|theme)\b/i.test(m)) {
    const card = await getStyleCard('@warm-editorial');
    const rubric = await getDefaultBrandRubric();
    if (!card) return null;
    const r = resolveSpec(card as never, rubric as never);
    const colors = (r.resolvedSpec.colors ?? {}) as Record<string, string>;
    const dos = ((card as { do_rules?: string[] }).do_rules ?? []).slice(0, 3).join(' · ');
    return [
      `Here's the on-brand direction (merge ledger, @warm-editorial):`,
      `• Colors (brand-locked): teal ${colors.teal} headline, gold ${colors.gold} CTA, ${colors.page} page, ${colors.ink} text`,
      `• Layout: ${JSON.stringify(r.resolvedSpec.layout) === '{}' ? 'editorial-split, asymmetric hero' : 'from the style card'}; serif headline, generous spacing`,
      dos ? `• Do: ${dos}` : '',
      `Want Hugo to build it? Say "hugo: build ${m.replace(/^(design|style|lay\s?out|mock|theme)\b/i, '').trim()}".`,
    ].filter(Boolean).join('\n');
  }

  return null;
}

const OLLAMA_URL = process.env.ATELIER_OLLAMA_URL ?? 'http://192.168.4.176:11434';
const CHAT_MODEL = process.env.ATELIER_CHAT_MODEL ?? 'qwen3.5:9b';

// Role-flavored personas. Keyed by slug; falls back to a generic one.
const PERSONAS: Record<string, string> = {
  cleo: `You are Cleo, Evergreen's Studio Director / chief of staff. You manage the team and Tyler's attention. You're warm, decisive, and brief. You summarize what's happening, route work to the right specialist, and surface only what needs a decision. You never do the specialist work yourself — you delegate and keep the floor moving.`,
  wren: `You are Wren, Evergreen's senior copywriter. Warm, sharp, concise; no hype, no clichés, no emoji. You write tight headline/copy options (numbered), revise the last set on request ("punchier", "shorter"), and answer briefly as a colleague.`,
  iris: `You are Iris, Evergreen's designer. You think in layout, palette, and hierarchy. You speak in concrete design direction (teal/gold brand, generous spacing, serif headlines). You suggest, you don't ramble. You can describe a layout or critique one.`,
  hugo: `You are Hugo, Evergreen's build engineer. Pragmatic, precise, plain-spoken. You talk about what to build and how, in small scoped steps. You favor clean semantic HTML/components and "if it isn't proven, it isn't done."`,
  vera: `You are Vera, Evergreen's researcher/designer. You turn fuzzy questions into sharp, sourced angles. You're curious and direct, and you flag what's worth making and why.`,
  lena: `You are Lena, Evergreen's curriculum & distribution lead. You think in audience, channels, and what actually lands. You're practical and outcome-focused.`,
  remy: `You are Remy, Evergreen's media producer/researcher. You think in scripts, shots, and what makes a video land. Concrete and energetic, never fluffy.`,
  marlowe: `You are Marlowe, Evergreen's editor and brand critic. You red-team work for voice, clarity, and on-brand-ness. Honest, exacting, kind. You name the 2-3 specific fixes, never vague praise.`,
  dewey: `You are Dewey, Evergreen's archivist. You keep the team's memory — what was decided, what worked, where things live. You answer "have we done this?" and "what did we decide about X?" precisely.`,
  otto: `You are Otto, Evergreen's ops/SRE. You keep the substrate healthy. Calm, terse, reassuring. You talk about service health, GPU lanes, and what's green vs at risk.`,
};

const TASTE_AGENTS = new Set(['wren', 'iris', 'marlowe', 'cleo']);

export interface ChatMessage { role: 'user' | 'assistant'; content: string; createdAt: string }
export interface AgentChatResult { ok: boolean; reply: string; model: string; latencyMs: number; usedTaste: boolean; error?: string }

export async function getAgent(slug: string): Promise<{ slug: string; name: string; role: string } | null> {
  const rows = (await sql`
    select slug, name, role from atelier_employee where workspace_id = ${ATELIER_WS} and slug = ${slug} limit 1
  `) as unknown as { slug: string; name: string; role: string }[];
  return rows[0] ?? null;
}

export async function listAgents(): Promise<{ slug: string; name: string; role: string; tier: string }[]> {
  const rows = (await sql`
    select slug, name, role, tier from atelier_employee where workspace_id = ${ATELIER_WS} order by tier, name
  `) as unknown as { slug: string; name: string; role: string; tier: string }[];
  return rows;
}

export async function getThread(slug: string, thread = 'default', limit = 40): Promise<ChatMessage[]> {
  const rows = (await sql`
    select role, content, created_at from atelier_message
     where workspace_id = ${ATELIER_WS} and agent_slug = ${slug} and thread = ${thread}
     order by created_at asc limit ${limit}
  `) as unknown as { role: string; content: string; created_at: string }[];
  return rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content, createdAt: r.created_at }));
}

async function save(slug: string, thread: string, role: 'user' | 'assistant', content: string) {
  await sql`insert into atelier_message (workspace_id, agent_slug, thread, role, content)
            values (${ATELIER_WS}, ${slug}, ${thread}, ${role}, ${content})`;
}

function personaFor(slug: string, name: string, role: string): string {
  return PERSONAS[slug] ?? `You are ${name}, Evergreen's ${role}. You're a sharp, concise teammate. Answer briefly and helpfully, in your domain. No fluff, no emoji.`;
}

/** Talk to any employee. Persists the turn, recalls taste where relevant, replies. */
export async function agentChat(slug: string, message: string, thread = 'default'): Promise<AgentChatResult> {
  const t0 = Date.now();
  const agent = await getAgent(slug);
  if (!agent) return { ok: false, reply: '', model: CHAT_MODEL, latencyMs: 0, usedTaste: false, error: 'AGENT_NOT_FOUND' };
  await save(slug, thread, 'user', message);
  try {
    // First: did the user ASK the agent to do real work? If so, do it.
    const toolResult = await runTool(slug, message);
    if (toolResult !== null) {
      await save(slug, thread, 'assistant', toolResult);
      return { ok: true, reply: toolResult, model: 'tool', latencyMs: Date.now() - t0, usedTaste: slug === 'wren' };
    }

    const history = await getThread(slug, thread, 20);
    const taste = TASTE_AGENTS.has(slug) ? await recallTasteForPrompt('wren_option') : '';
    const persona = personaFor(slug, agent.name, agent.role) + ' Keep replies short — Tyler reads by glancing.' + taste;
    const msgs = [
      { role: 'system' as const, content: persona },
      ...history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
    ];
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: CHAT_MODEL, stream: false, options: { temperature: 0.7 }, messages: msgs }),
    });
    if (!res.ok) return { ok: false, reply: '', model: CHAT_MODEL, latencyMs: Date.now() - t0, usedTaste: !!taste, error: `OLLAMA_HTTP_${res.status}` };
    const j = (await res.json()) as { message?: { content?: string } };
    const reply = (j.message?.content ?? '').trim();
    if (!reply) return { ok: false, reply: '', model: CHAT_MODEL, latencyMs: Date.now() - t0, usedTaste: !!taste, error: 'EMPTY_REPLY' };
    await save(slug, thread, 'assistant', reply);
    return { ok: true, reply, model: CHAT_MODEL, latencyMs: Date.now() - t0, usedTaste: !!taste };
  } catch (err) {
    return { ok: false, reply: '', model: CHAT_MODEL, latencyMs: Date.now() - t0, usedTaste: false, error: err instanceof Error ? err.message : 'OLLAMA_UNREACHABLE' };
  }
}
