// lib/agents/wren-chat.ts
//
// The persistent "talk to Wren" layer — the heart of the Hermes wrap, in-app.
// Wren holds a conversation (persisted), recalls Tyler's learned taste, and
// calls her local model. This is the identity + conversation + memory shell;
// Slack/LXC is a later transport over this same store and endpoint.

import { sql } from '../db';
import { ATELIER_WS } from '../atelier';
import { recallTasteForPrompt } from '../taste-memory';
import { soulPersona } from '../souls';

const OLLAMA_URL = process.env.ATELIER_OLLAMA_URL ?? 'http://192.168.4.176:11434';
const WREN_MODEL = process.env.ATELIER_WREN_MODEL ?? 'qwen3.5:9b';

const PERSONA = `You are Wren, Evergreen's senior copywriter — a real teammate Tyler talks to.
Voice: warm, sharp, concise; no hype, no clichés, no emoji. You remember context from this
conversation and Tyler's learned taste. When he asks for headlines/copy you produce tight
options (numbered). When he asks to revise ("punchier", "shorter", "more contrarian") you
rework the LAST set using the conversation. When he asks a question, answer briefly as a
colleague. Keep replies short — he reads by glancing.`;

export interface WrenMessage { role: 'user' | 'assistant'; content: string; createdAt: string }

export async function getWrenThread(thread = 'default', limit = 30): Promise<WrenMessage[]> {
  const rows = (await sql`
    select role, content, created_at from atelier_message
     where workspace_id = ${ATELIER_WS} and agent_slug = 'wren' and thread = ${thread}
     order by created_at asc limit ${limit}
  `) as unknown as { role: string; content: string; created_at: string }[];
  return rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content, createdAt: r.created_at }));
}

async function saveMessage(thread: string, role: 'user' | 'assistant', content: string): Promise<void> {
  await sql`
    insert into atelier_message (workspace_id, agent_slug, thread, role, content)
    values (${ATELIER_WS}, 'wren', ${thread}, ${role}, ${content})
  `;
}

export interface WrenChatResult { ok: boolean; reply: string; model: string; latencyMs: number; usedTaste: boolean; error?: string }

/** Send a message to Wren. Persists the turn, recalls taste + history, replies. */
export async function wrenChat(message: string, thread = 'default'): Promise<WrenChatResult> {
  const t0 = Date.now();
  await saveMessage(thread, 'user', message);
  try {
    const history = await getWrenThread(thread, 20);
    const taste = await recallTasteForPrompt('wren_option');
    const msgs = [
      { role: 'system' as const, content: (soulPersona('wren') ?? PERSONA) + taste },
      ...history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
    ];
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: WREN_MODEL, stream: false, options: { temperature: 0.7 }, messages: msgs }),
    });
    if (!res.ok) return { ok: false, reply: '', model: WREN_MODEL, latencyMs: Date.now() - t0, usedTaste: !!taste, error: `OLLAMA_HTTP_${res.status}` };
    const j = (await res.json()) as { message?: { content?: string } };
    const reply = (j.message?.content ?? '').trim();
    if (!reply) return { ok: false, reply: '', model: WREN_MODEL, latencyMs: Date.now() - t0, usedTaste: !!taste, error: 'EMPTY_REPLY' };
    await saveMessage(thread, 'assistant', reply);
    return { ok: true, reply, model: WREN_MODEL, latencyMs: Date.now() - t0, usedTaste: !!taste };
  } catch (err) {
    return { ok: false, reply: '', model: WREN_MODEL, latencyMs: Date.now() - t0, usedTaste: false, error: err instanceof Error ? err.message : 'OLLAMA_UNREACHABLE' };
  }
}
