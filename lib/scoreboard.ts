// lib/scoreboard.ts
//
// The proof-score scoreboard: the studio's free eval harness. Every build
// writes an append-only atelier_proof row with a score, every background job
// records status + duration, and every Marlowe read logs a ship/revise verdict
// — so persona/model changes stop being vibes and become an A/B against last
// window's numbers. This module aggregates those ground-truth rows per agent
// (pass rates, score averages, palette-ΔE spread, job error rates) and per
// model (Hugo's tiered brains), with a previous-window comparison.
//
// Read-only over real tables; no new schema. Surfaced on /scoreboard and via
// Otto's chat ("scoreboard" / "pass rate") — Otto reports the numbers, he
// doesn't judge the work.

import { sql } from './db';
import { ATELIER_WS } from './atelier';

type Row = Record<string, unknown>;

export interface AgentScore {
  slug: string;
  name: string;
  proofs: { total: number; pass: number; passRate: number | null; avgScore: number | null; lastAt: string | null };
  prevPassRate: number | null; // previous window, for the trend arrow
  deltaE: { n: number; avg: number | null; max: number | null };
  jobs: { total: number; done: number; error: number; avgSecs: number | null };
}

export interface ModelScore {
  model: string;
  n: number;
  passRate: number;
  avgScore: number | null;
  avgDeltaE: number | null;
}

export interface Scoreboard {
  windowDays: number;
  agents: AgentScore[];
  models: ModelScore[]; // proofs that recorded which model produced them (Hugo's tiers)
  wrenReviews: { ship: number; revise: number }; // Marlowe verdicts in the window
  totals: { proofs: number; pass: number; passRate: number | null };
}

const rate = (pass: number, total: number): number | null => (total ? pass / total : null);
const num = (v: unknown): number | null => (v == null ? null : Number(v));

export async function getScoreboard(windowDays = 30): Promise<Scoreboard> {
  const employees = (await sql`
    select slug, name from atelier_employee where workspace_id = ${ATELIER_WS}
  `) as unknown as { slug: string; name: string }[];

  // Proof outcomes per agent, current window.
  const proofAgg = (await sql`
    select employee_slug,
           count(*)::int                                   as total,
           count(*) filter (where status = 'pass')::int    as pass,
           avg(score)                                      as avg_score,
           max(created_at)                                 as last_at
      from atelier_proof
     where workspace_id = ${ATELIER_WS} and employee_slug is not null
       and created_at > now() - make_interval(days => ${windowDays})
     group by employee_slug
  `) as unknown as Row[];

  // Previous window (for trend): the windowDays before the current one.
  const prevAgg = (await sql`
    select employee_slug,
           count(*)::int                                as total,
           count(*) filter (where status = 'pass')::int as pass
      from atelier_proof
     where workspace_id = ${ATELIER_WS} and employee_slug is not null
       and created_at <= now() - make_interval(days => ${windowDays})
       and created_at >  now() - make_interval(days => ${windowDays * 2})
     group by employee_slug
  `) as unknown as Row[];

  // Palette-ΔE spread per agent (only proofs that measured one).
  const deAgg = (await sql`
    select employee_slug,
           count(*)::int                          as n,
           avg((detail->>'paletteDeltaE')::real)  as avg_de,
           max((detail->>'paletteDeltaE')::real)  as max_de
      from atelier_proof
     where workspace_id = ${ATELIER_WS} and employee_slug is not null
       and detail->>'paletteDeltaE' is not null
       and created_at > now() - make_interval(days => ${windowDays})
     group by employee_slug
  `) as unknown as Row[];

  // Background-job reliability per agent.
  const jobAgg = (await sql`
    select agent_slug,
           count(*)::int                                 as total,
           count(*) filter (where status = 'done')::int  as done,
           count(*) filter (where status = 'error')::int as error,
           avg(extract(epoch from (finished_at - started_at)))
             filter (where status = 'done')              as avg_secs
      from atelier_job
     where workspace_id = ${ATELIER_WS} and agent_slug is not null
       and created_at > now() - make_interval(days => ${windowDays})
     group by agent_slug
  `) as unknown as Row[];

  // Per-model outcomes, where the proof recorded its producing model
  // (Hugo's tiered brains — the data that decides who gets a bigger one).
  const modelAgg = (await sql`
    select detail->>'model' as model,
           count(*)::int                                as n,
           count(*) filter (where status = 'pass')::int as pass,
           avg(score)                                   as avg_score,
           avg((detail->>'paletteDeltaE')::real)        as avg_de
      from atelier_proof
     where workspace_id = ${ATELIER_WS} and detail->>'model' is not null
       and created_at > now() - make_interval(days => ${windowDays})
     group by detail->>'model'
     order by count(*) desc
  `) as unknown as Row[];

  // Marlowe verdicts on Wren's sets (the revision-loop signal).
  const verdictAgg = (await sql`
    select payload->>'verdict' as verdict, count(*)::int as n
      from atelier_dossier_entry
     where workspace_id = ${ATELIER_WS} and employee_slug = 'marlowe'
       and payload->>'verdict' is not null
       and created_at > now() - make_interval(days => ${windowDays})
     group by payload->>'verdict'
  `) as unknown as Row[];

  const bySlug = <T extends Row>(rows: T[], key: string) =>
    new Map(rows.map((r) => [r[key] as string, r]));
  const proofs = bySlug(proofAgg, 'employee_slug');
  const prev = bySlug(prevAgg, 'employee_slug');
  const des = bySlug(deAgg, 'employee_slug');
  const jobs = bySlug(jobAgg, 'agent_slug');

  const agents: AgentScore[] = employees
    .map((e) => {
      const p = proofs.get(e.slug);
      const pv = prev.get(e.slug);
      const d = des.get(e.slug);
      const j = jobs.get(e.slug);
      return {
        slug: e.slug,
        name: e.name,
        proofs: {
          total: (p?.total as number) ?? 0,
          pass: (p?.pass as number) ?? 0,
          passRate: p ? rate(p.pass as number, p.total as number) : null,
          avgScore: num(p?.avg_score),
          lastAt: p?.last_at ? String(p.last_at) : null,
        },
        prevPassRate: pv ? rate(pv.pass as number, pv.total as number) : null,
        deltaE: { n: (d?.n as number) ?? 0, avg: num(d?.avg_de), max: num(d?.max_de) },
        jobs: {
          total: (j?.total as number) ?? 0,
          done: (j?.done as number) ?? 0,
          error: (j?.error as number) ?? 0,
          avgSecs: num(j?.avg_secs),
        },
      };
    })
    // agents with any activity first, most proofs first; idle agents at the end
    .sort((a, b) => (b.proofs.total + b.jobs.total) - (a.proofs.total + a.jobs.total));

  const models: ModelScore[] = modelAgg.map((m) => ({
    model: m.model as string,
    n: m.n as number,
    passRate: rate(m.pass as number, m.n as number) ?? 0,
    avgScore: num(m.avg_score),
    avgDeltaE: num(m.avg_de),
  }));

  const verdicts = new Map(verdictAgg.map((v) => [v.verdict as string, v.n as number]));
  const totalProofs = agents.reduce((a, x) => a + x.proofs.total, 0);
  const totalPass = agents.reduce((a, x) => a + x.proofs.pass, 0);

  return {
    windowDays,
    agents,
    models,
    wrenReviews: { ship: verdicts.get('ship') ?? 0, revise: verdicts.get('revise') ?? 0 },
    totals: { proofs: totalProofs, pass: totalPass, passRate: rate(totalPass, totalProofs) },
  };
}

const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);

/** Otto-voice text rendering for chat: verdict first, numbers, no judgment of the work. */
export function formatScoreboard(sb: Scoreboard): string {
  const head = sb.totals.proofs
    ? `Scoreboard, last ${sb.windowDays}d: ${sb.totals.pass}/${sb.totals.proofs} proofs passing (${pct(sb.totals.passRate)}).`
    : `Scoreboard, last ${sb.windowDays}d: no proof rows in the window.`;

  const lines = sb.agents
    .filter((a) => a.proofs.total || a.jobs.total)
    .map((a) => {
      const parts: string[] = [];
      if (a.proofs.total) {
        let s = `proofs ${a.proofs.pass}/${a.proofs.total} (${pct(a.proofs.passRate)}`;
        if (a.prevPassRate != null && a.proofs.passRate != null) {
          const d = Math.round((a.proofs.passRate - a.prevPassRate) * 100);
          s += `, ${d >= 0 ? '+' : ''}${d} vs prior ${sb.windowDays}d`;
        }
        s += ')';
        if (a.proofs.avgScore != null) s += `, avg score ${a.proofs.avgScore.toFixed(2)}`;
        parts.push(s);
      }
      if (a.deltaE.n) parts.push(`ΔE avg ${a.deltaE.avg?.toFixed(1)} / max ${a.deltaE.max?.toFixed(1)} over ${a.deltaE.n}`);
      if (a.jobs.total) {
        let s = `jobs ${a.jobs.done}/${a.jobs.total} done`;
        if (a.jobs.error) s += `, ${a.jobs.error} failed`;
        if (a.jobs.avgSecs != null) s += `, ~${Math.round(a.jobs.avgSecs)}s`;
        parts.push(s);
      }
      return `  ${a.name}: ${parts.join(' · ')}`;
    });

  const out: string[] = [head];
  if (lines.length) out.push(...lines);
  if (sb.wrenReviews.ship + sb.wrenReviews.revise) {
    out.push(`  Marlowe on Wren's sets: ${sb.wrenReviews.ship} ship / ${sb.wrenReviews.revise} revise.`);
  }
  if (sb.models.length) {
    out.push('By model (proofs that recorded one):');
    for (const m of sb.models) {
      out.push(`  ${m.model}: ${pct(m.passRate)} pass over ${m.n}${m.avgScore != null ? `, avg score ${m.avgScore.toFixed(2)}` : ''}${m.avgDeltaE != null ? `, ΔE avg ${m.avgDeltaE.toFixed(1)}` : ''}`);
    }
  }
  return out.join('\n');
}
