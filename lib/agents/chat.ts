// lib/agents/chat.ts
//
// Generic "talk to any employee" chat — the in-app way to converse with your
// whole team, no Slack needed. Reuses the per-agent atelier_message store and
// the taste memory. Everyone routes through a local model (no cloud); each gets
// a role-appropriate persona.
//
// Three routing layers run before the model sees anything:
//   1. "agent: command" prefix — dispatch to another specialist from any thread
//      (this is the canonical handoff syntax the souls teach, e.g. "hugo: build …").
//   2. yes/no to the last volunteered handoff — completed jobs and tools attach a
//      machine-readable nextStep to their message (atelier_message.meta), so a
//      plain "yes" executes the real enqueue instead of being role-played.
//   3. TOOLS[slug] — the agent's own tools. Cleo's "tool" is the router itself:
//      she probes the specialists' tools in order and hands the work to the
//      first one that takes it.

import { sql } from '../db';
import { ATELIER_WS } from '../atelier';
import { recallTasteForPrompt } from '../taste-memory';
import { generateHeadlines } from './wren';
import { enqueueHugoBuild } from '../jobs';
import { getStyleCard, getDefaultBrandRubric } from '../style-repo';
import { resolveSpec } from '../merge-ledger';
import { systemHealth, formatHealth } from './otto';
import { soulPersona } from '../souls';
import { getLanesState, currentZone, formatLanes, kickIdle } from '../lanes';
import { enqueueVeraResearch, enqueueMarloweReview, enqueueLenaPlan, enqueueRemyScript, enqueueMarloweCritique } from '../jobs';
import { recall, formatRecall } from './dewey';
import { critique, formatCritique } from './marlowe';
import type { NextStep } from './handoffs';

const PUBLIC_URL = process.env.ATELIER_PUBLIC_URL ?? 'http://192.168.4.200:3040';

const AGENT_NAMES: Record<string, string> = {
  cleo: 'Cleo', wren: 'Wren', iris: 'Iris', hugo: 'Hugo', vera: 'Vera',
  lena: 'Lena', remy: 'Remy', marlowe: 'Marlowe', dewey: 'Dewey', otto: 'Otto',
};

export interface ToolReply { text: string; nextStep?: NextStep }
type Tool = (m: string) => Promise<ToolReply | string | null>;

// ── Real tools: when you ASK an agent to do something, it does it ──────────
// Each returns a reply (string, or {text, nextStep} to volunteer a follow-up),
// or null → the conversational model answers instead.
const TOOLS: Record<string, Tool> = {
  // Wren: "headlines / copy / titles ..." → really generate them.
  wren: async (m) => {
    if (!/\b(headline|headlines|copy|titles?|tagline|hook|subject lines?)\b/i.test(m)) return null;
    const taste = await recallTasteForPrompt('wren_option');
    const g = await generateHeadlines(m, 6, taste);
    if (!g.ok) return null;
    return `Here are 6${taste ? ' (tuned to your taste)' : ''}:\n` + g.headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  },

  // Hugo: an imperative "build/make/create ..." → kick off a background build.
  // The coder model + Visual-QA gate take ~30–90s, so we enqueue and ack instantly
  // instead of blocking the chat turn; the result lands in Latest Outputs.
  hugo: async (m) => {
    if (!/^(build|make|create|code)\b/i.test(m)) return null;
    const heavy = /\b(heavy|big|complex|full[\s-]?page|multi[\s-]?section|80b|large|advanced)\b/i.test(m);
    const brief = m.replace(/^(build|make|create|code)\b/i, '').trim() || m;
    const jobId = await enqueueHugoBuild('launch-course-19', brief, heavy);
    return heavy
      ? `On it — HEAVY build with the vidbox 80B coder (qwen3-coder-next). It cold-starts (evicts ComfyUI, loads ~27GB) so give it a few minutes; it goes through the same on-brand QC gate and lands in Latest Outputs. I'll report back here when the gate rules. Track it: ${PUBLIC_URL}/project/launch-course-19 · job ${jobId.slice(0, 8)}`
      : `On it — building that now (qwen2.5-coder, then the on-brand QC gate; ~30–90s). It'll appear in the project's Latest Outputs once the proof passes, and I'll report back here either way. Track it: ${PUBLIC_URL}/project/launch-course-19 · job ${jobId.slice(0, 8)}`;
  },

  // Iris: "design / style / layout ..." → resolve real brand+style direction,
  // and volunteer the build handoff (say "yes", or "hugo: build …" with tweaks).
  iris: async (m) => {
    if (!/^(design|style|lay\s?out|mock|theme)\b/i.test(m)) return null;
    const card = await getStyleCard('@warm-editorial');
    const rubric = await getDefaultBrandRubric();
    if (!card) return null;
    const r = resolveSpec(card as never, rubric as never);
    const colors = (r.resolvedSpec.colors ?? {}) as Record<string, string>;
    const dos = ((card as { do_rules?: string[] }).do_rules ?? []).slice(0, 3).join(' · ');
    const brief = m.replace(/^(design|style|lay\s?out|mock|theme)\b/i, '').trim() || m;
    const text = [
      `Here's the on-brand direction (merge ledger, @warm-editorial):`,
      `• Colors (brand-locked): teal ${colors.teal} headline, gold ${colors.gold} CTA, ${colors.page} page, ${colors.ink} text`,
      `• Layout: ${JSON.stringify(r.resolvedSpec.layout) === '{}' ? 'editorial-split, asymmetric hero' : 'from the style card'}; serif headline, generous spacing`,
      dos ? `• Do: ${dos}` : '',
      `Want Hugo to build it? Say yes — or "hugo: build ${brief}" with tweaks.`,
    ].filter(Boolean).join('\n');
    return { text, nextStep: { kind: 'hugo_build', brief } };
  },

  // Otto: kick/lanes/scoreboard/health — all real reads (and one guarded write).
  otto: async (m) => {
    // "kick / free / evict <lane>" → unload idle models to free VRAM.
    if (/\b(kick|free|evict|unload|clear)\b/i.test(m) && /(lane|gpu|vram|framer|vidbox|m90t|think|model)/i.test(m)) {
      const laneId = /framer/i.test(m) ? 'framerstation' : /vidbox/i.test(m) ? 'vidbox' : /m90t|think|lynn/i.test(m) ? 'm90t' : 'framerstation';
      const force = /\b(force|hard|anyway|all)\b/i.test(m); // override in-use protection
      const r = await kickIdle(laneId, [], !force);
      await new Promise((res) => setTimeout(res, 1200)); // let Ollama settle the unload before re-reading
      const [lanes, zone] = [await getLanesState(), currentZone()];
      return `${r.note}.\n\n${formatLanes(lanes, zone)}`;
    }

    // "lanes / gpu / vram ..." → the live GPU lane map + active zone + deferred jobs.
    if (/\b(lanes?|gpu|gpus|vram|model lane|scheduler|zone|deferred|queue)\b/i.test(m)) {
      const [lanes, zone] = [await getLanesState(), currentZone()];
      const { listRecentJobs } = await import('../jobs');
      const deferred = (await listRecentJobs(40)).filter((j) => j.status === 'deferred');
      let out = formatLanes(lanes, zone);
      if (deferred.length) {
        out += `\n\nDeferred batch work (waiting for its window):\n` +
          deferred.map((j) => `  ⏸ ${j.kind} → runs after ${j.runAfter ? new Date(j.runAfter).toLocaleString() : '?'}`).join('\n');
      }
      return out;
    }

    // "scoreboard / scores / pass rate ..." → the proof-score scoreboard
    // (per-agent pass rates, ΔE spread, job reliability, per-model outcomes).
    if (/\b(scoreboard|scores?|pass rates?|proof stats?|win rates?)\b/i.test(m)) {
      const { getScoreboard, formatScoreboard } = await import('../scoreboard');
      const days = /\b(7|seven) ?d(ays?)?\b|\bweek\b/i.test(m) ? 7 : /\b90 ?d(ays?)?\b|\bquarter\b/i.test(m) ? 90 : 30;
      return formatScoreboard(await getScoreboard(days)) + `\n\nFull board: ${PUBLIC_URL}/scoreboard`;
    }

    // "health / status / are we green / services ..." → a real live snapshot.
    if (/\b(health|status|healthy|green|services?|substrate|how are we|everything (ok|up)|systems?)\b/i.test(m)) {
      const h = await systemHealth();
      return formatHealth(h);
    }
    return null;
  },

  // Vera: "research / angles / look into ..." → kick off a background research
  // plan. The local model can cold-load (~80s) on the shared GPU, so we enqueue
  // and ack instantly; Vera posts the plan to the project log when it's ready.
  vera: async (m) => {
    if (!/^(research|angles?|investigate|explore|look into|dig into|find out|brief me)\b/i.test(m)) return null;
    const brief = m.replace(/^(research|angles?|investigate|explore|look into|dig into|find out|brief me)\b(\s+(on|about|into))?/i, '').trim() || m;
    const jobId = await enqueueVeraResearch(brief);
    return `On it — researching “${brief}”. I'll post the plan (angles, key questions, what to verify) to the project log and report back here. Cold model loads on the shared GPU can take a minute. · job ${jobId.slice(0, 8)}`;
  },

  // Dewey: "what did we decide / have we / recall ..." → real recall from memory.
  dewey: async (m) => {
    if (!/\b(recall|remember|what did we|have we|did we|decide|decided|notes? on|history|did i|what do we know)\b/i.test(m)) return null;
    const { hits, terms } = await recall(m);
    return formatRecall(m, hits, terms);
  },

  // Marlowe: critique. "review the latest copy" → background auto-review of Wren's
  // last option set; "critique <text>" → red-team the supplied copy inline.
  marlowe: async (m) => {
    if (!/^(critique|review|red.?team|check|proof|tighten|edit)\b/i.test(m)) return null;
    if (/\b(latest|last|the copy|the output|wren|headlines?|options?)\b/i.test(m) && !/[:"]/.test(m)) {
      const jobId = await enqueueMarloweReview();
      return `On it — reviewing Wren's latest option set against voice + your taste. I'll post my read to the project log and give you the verdict here. · job ${jobId.slice(0, 8)}`;
    }
    const content = m.replace(/^(critique|review|red.?team|check|proof|tighten|edit)\b(\s+(this|that|this copy|the following)\s*:?)?/i, '').trim();
    if (content.length < 3) return `Paste the copy and I'll red-team it — e.g. "critique: <your headline>".`;
    const c = await critique(content);
    return formatCritique(c, 'the copy');
  },

  // Lena: "distribution / launch / channels / promote ..." → a channel plan.
  lena: async (m) => {
    if (!/^(distribution|distribute|launch|channels?|promote|plan|roll ?out|go to market|gtm)\b/i.test(m)) return null;
    const brief = m.replace(/^(distribution|distribute|launch|channels?|promote|plan|roll ?out|go to market|gtm)\b(\s+(for|of|the|a|an|on|plan))?/i, '').trim() || m;
    const jobId = await enqueueLenaPlan(brief);
    return `On it — building a distribution plan for “${brief}” (audience, channels, sequence, CTA). I'll post it to the project log and report back here. · job ${jobId.slice(0, 8)}`;
  },

  // Remy: "script / video / reel / shoot ..." → a short-form video script.
  remy: async (m) => {
    if (!/^(script|video|reel|short|shoot|storyboard|vsl|film)\b/i.test(m)) return null;
    const brief = m.replace(/^(script|video|reel|short|shoot|storyboard|vsl|film)\b(\s+(for|of|the|a|an|about))?/i, '').trim() || m;
    const jobId = await enqueueRemyScript(brief);
    return `On it — drafting a short-form video script for “${brief}” (hook, beats, CTA). I'll post it to the project log and report back here. · job ${jobId.slice(0, 8)}`;
  },

  // Cleo: the router. She makes nothing — she probes the specialists' tools in
  // order (most-specific matchers first, Wren's broad one last) and hands the
  // work to the first that takes it, recording the exchange on their thread.
  cleo: async (m) => {
    const ROUTE_ORDER = ['hugo', 'vera', 'lena', 'remy', 'marlowe', 'iris', 'dewey', 'otto', 'wren'];
    for (const s of ROUTE_ORDER) {
      const r = await TOOLS[s](m);
      if (r === null) continue;
      const t: ToolReply = typeof r === 'string' ? { text: r } : r;
      await save(s, 'default', 'user', `(routed by Cleo) ${m}`);
      await save(s, 'default', 'assistant', t.text, t.nextStep ? { nextStep: t.nextStep } : undefined);
      return { text: `That's ${AGENT_NAMES[s]}'s — handed over, moving.\n\n${AGENT_NAMES[s]}: ${t.text}`, nextStep: t.nextStep };
    }
    return null;
  },
};

// ── The three-layer router (prefix → handoff yes/no → own tools) ────────────

const AFFIRM_RE = /^(y(es|ep|eah|up)?|sure|ok(ay)?|do it|go ahead|please(,? do( it)?)?|yes,? please|send it|hand it (off|over)|fire away)[.! ]*$/i;
const DECLINE_RE = /^(no+( thanks| thank you)?|nah|nope|not (now|yet)|skip( it)?|later|park it|hold off)[.! ]*$/i;

async function runTool(slug: string, message: string, thread = 'default'): Promise<ToolReply | null> {
  let m = message.trim();

  // 1) "agent: command" — the canonical handoff syntax, routable from any thread.
  const prefix = m.match(/^([a-z]+)\s*:\s*(.+)$/is);
  if (prefix && AGENT_NAMES[prefix[1].toLowerCase()]) {
    const target = prefix[1].toLowerCase();
    const rest = prefix[2].trim();
    if (rest && target !== slug) {
      const r = await agentChat(target, rest, 'default');
      return {
        text: r.ok
          ? `→ ${AGENT_NAMES[target]}: ${r.reply}`
          : `Couldn't hand that to ${AGENT_NAMES[target]} (${r.error ?? 'error'}).`,
      };
    }
    if (rest) m = rest; // "hugo: build x" said to Hugo himself → strip and continue
  }

  // 2) A bare yes/no answers the last volunteered handoff in this thread.
  const affirm = AFFIRM_RE.test(m);
  if (affirm || DECLINE_RE.test(m)) {
    const pending = await latestPendingHandoff(slug, thread);
    if (pending) {
      await markHandoff(pending.id, affirm ? 'accepted' : 'declined');
      if (!affirm) return { text: 'Parked. Say the word when you want it.' };
      return { text: await executeNextStep(pending.nextStep) };
    }
  }

  // 3) The agent's own tools.
  const tool = TOOLS[slug];
  if (!tool) return null;
  const r = await tool(m);
  return r === null ? null : typeof r === 'string' ? { text: r } : r;
}

/** The most recent assistant message in this thread, if it carries an unconsumed handoff. */
async function latestPendingHandoff(slug: string, thread: string): Promise<{ id: string; nextStep: NextStep } | null> {
  const rows = (await sql`
    select id, meta from atelier_message
     where workspace_id = ${ATELIER_WS} and agent_slug = ${slug} and thread = ${thread} and role = 'assistant'
     order by created_at desc limit 1
  `) as unknown as { id: string; meta: { nextStep?: NextStep; nextStepDone?: string } | null }[];
  const meta = rows[0]?.meta;
  if (rows[0] && meta?.nextStep && !meta.nextStepDone) return { id: rows[0].id, nextStep: meta.nextStep };
  return null;
}

async function markHandoff(id: string, outcome: 'accepted' | 'declined'): Promise<void> {
  await sql`
    update atelier_message
       set meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{nextStepDone}', to_jsonb(${outcome}::text))
     where workspace_id = ${ATELIER_WS} and id = ${id}
  `;
}

/** Execute an accepted handoff — the real enqueue/generation, never role-play. */
async function executeNextStep(step: NextStep): Promise<string> {
  switch (step.kind) {
    case 'hugo_build': {
      const jobId = await enqueueHugoBuild('launch-course-19', String(step.brief ?? ''), Boolean(step.heavy));
      return `Handed to Hugo — building now (coder model, then the on-brand QC gate). He'll report back in his thread when the gate rules. · job ${jobId.slice(0, 8)}`;
    }
    case 'marlowe_critique': {
      const jobId = await enqueueMarloweCritique(String(step.content ?? ''), String(step.subject ?? 'the copy'));
      return `Handed to Marlowe — he's reading it now. The verdict lands in his thread and the project log. · job ${jobId.slice(0, 8)}`;
    }
    case 'remy_script': {
      const jobId = await enqueueRemyScript(String(step.brief ?? ''));
      return `Handed to Remy — scripting it now (hook, beats, CTA). It posts to the project log and his thread. · job ${jobId.slice(0, 8)}`;
    }
    case 'wren_headlines':
    case 'wren_rerun': {
      const brief = step.kind === 'wren_headlines'
        ? String(step.brief ?? '')
        : `${String(step.question ?? 'the option set')} — rework the set to address these editor notes: ${((step.issues as string[]) ?? []).join('; ')}`;
      const taste = await recallTasteForPrompt('wren_option');
      const g = await generateHeadlines(brief, 6, taste);
      if (!g.ok) return `Handed to Wren, but her model didn't come back (${g.error ?? 'error'}). Try again in a minute.`;
      const text = `Wren's set${taste ? ' (tuned to your taste)' : ''}:\n` + g.headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
      await save('wren', 'default', 'user', `(handoff) ${brief}`);
      await save('wren', 'default', 'assistant', text);
      return text;
    }
    default:
      return `That handoff isn't wired to a real lane yet — nothing was fired.`;
  }
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

/** The most recent `limit` messages of a thread, oldest → newest. */
export async function getThread(slug: string, thread = 'default', limit = 40): Promise<ChatMessage[]> {
  const rows = (await sql`
    select role, content, created_at from (
      select role, content, created_at from atelier_message
       where workspace_id = ${ATELIER_WS} and agent_slug = ${slug} and thread = ${thread}
       order by created_at desc limit ${limit}
    ) recent order by created_at asc
  `) as unknown as { role: string; content: string; created_at: string }[];
  return rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content, createdAt: r.created_at }));
}

/** Messages newer than `afterISO` — the polling feed that makes proactive job reports visible. */
export async function getThreadAfter(slug: string, thread: string, afterISO: string): Promise<ChatMessage[]> {
  const rows = (await sql`
    select role, content, created_at from atelier_message
     where workspace_id = ${ATELIER_WS} and agent_slug = ${slug} and thread = ${thread}
       and created_at > ${afterISO}::timestamptz
     order by created_at asc limit 100
  `) as unknown as { role: string; content: string; created_at: string }[];
  return rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content, createdAt: r.created_at }));
}

async function save(slug: string, thread: string, role: 'user' | 'assistant', content: string, meta?: Record<string, unknown>) {
  await sql`insert into atelier_message (workspace_id, agent_slug, thread, role, content, meta)
            values (${ATELIER_WS}, ${slug}, ${thread}, ${role}, ${content}, ${sql.json((meta ?? {}) as never)})`;
}

function personaFor(slug: string, name: string, role: string): string {
  // Prefer the agent's SOUL.md identity; fall back to the legacy inline persona.
  return soulPersona(slug)
    ?? PERSONAS[slug]
    ?? `You are ${name}, Evergreen's ${role}. You're a sharp, concise teammate. Answer briefly and helpfully, in your domain. No fluff, no emoji.`;
}

/** Talk to any employee. Persists the turn, recalls taste where relevant, replies. */
export async function agentChat(slug: string, message: string, thread = 'default'): Promise<AgentChatResult> {
  const t0 = Date.now();
  const agent = await getAgent(slug);
  if (!agent) return { ok: false, reply: '', model: CHAT_MODEL, latencyMs: 0, usedTaste: false, error: 'AGENT_NOT_FOUND' };
  await save(slug, thread, 'user', message);
  try {
    // First: did the user ASK the agent to do real work? If so, do it.
    const toolResult = await runTool(slug, message, thread);
    if (toolResult !== null) {
      await save(slug, thread, 'assistant', toolResult.text, toolResult.nextStep ? { nextStep: toolResult.nextStep } : undefined);
      return { ok: true, reply: toolResult.text, model: 'tool', latencyMs: Date.now() - t0, usedTaste: slug === 'wren' };
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
