// lib/dashboard.ts
//
// The Project Command Center data layer. Aggregates Atelier's REAL tables
// (tasks, proofs, dossier entries, style cards, employees) into the shape the
// HERMES-style dashboard renders — KPIs, the 6-stage Project Flow, the
// Confidence score (from real proof scores, not vibes), the decision queue, the
// activity feed, latest outputs, and knowledge bases in use.

import { sql } from './db';
import { ATELIER_WS } from './atelier';

type Row = Record<string, unknown>;

export interface FlowSubTask {
  title: string;
  status: 'done' | 'active' | 'pending';
}
export interface FlowStage {
  key: string;
  label: string;
  role: string;
  status: 'complete' | 'in_progress' | 'pending';
  subtasks: FlowSubTask[];
}
export interface DecisionOption {
  key: string;
  label: string;
  detail: string;
}
export interface OutputCard {
  title: string;
  kind: string;
  screenshotRef: string | null;
  updated: string;
}
export interface ActivityItem {
  employee: string;
  body: string;
  type: string;
  at: string;
}
export interface KnowledgeBase {
  handle: string;
  name: string;
  count: number;
}
export interface ProjectDashboard {
  slug: string;
  title: string;
  objective: string;
  status: string;
  kpis: {
    progressPct: number;
    agentsActive: number;
    agentsTotal: number;
    tasksDone: number;
    tasksTotal: number;
    confidence: number; // 0-100, from proof scores
  };
  briefing: { summary: string; bullets: string[] };
  decision: { question: string; options: DecisionOption[] } | null;
  flow: FlowStage[];
  outputs: OutputCard[];
  activity: ActivityItem[];
  knowledgeBases: KnowledgeBase[];
}

// The 6-stage Project Flow, mapped to the Atelier assembly line (employee role).
const STAGES: { key: string; label: string; role: string }[] = [
  { key: 'discover', label: 'Discover', role: 'vera' },
  { key: 'design', label: 'Design', role: 'iris' },
  { key: 'build', label: 'Build', role: 'hugo' },
  { key: 'produce', label: 'Produce', role: 'remy' },
  { key: 'verify', label: 'Verify', role: 'marlowe' },
  { key: 'launch', label: 'Launch', role: 'lena' },
];

const DONE = new Set(['shipped', 'review', 'proofed']);
const ACTIVE = new Set(['active', 'scoped']);

function timeAgo(d: Date | string): string {
  const t = typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export async function listProjects(): Promise<{ slug: string; title: string }[]> {
  const rows = (await sql`
    select slug, title from atelier_dossier
     where workspace_id = ${ATELIER_WS} order by created_at desc
  `) as unknown as Row[];
  return rows.map((r) => ({ slug: r.slug as string, title: r.title as string }));
}

export async function getProjectDashboard(slug: string): Promise<ProjectDashboard | null> {
  const dRows = (await sql`
    select * from atelier_dossier where workspace_id = ${ATELIER_WS} and slug = ${slug} limit 1
  `) as unknown as Row[];
  if (!dRows[0]) return null;
  const dossier = dRows[0];
  const did = dossier.id as string;

  const tasks = (await sql`
    select * from atelier_task where workspace_id = ${ATELIER_WS} and dossier_id = ${did}
     order by created_at
  `) as unknown as Row[];
  const proofs = (await sql`
    select p.* from atelier_proof p where p.workspace_id = ${ATELIER_WS}
       and p.task_id in (select id from atelier_task where dossier_id = ${did})
     order by p.created_at desc
  `) as unknown as Row[];
  const entries = (await sql`
    select * from atelier_dossier_entry where workspace_id = ${ATELIER_WS} and dossier_id = ${did}
     order by created_at desc limit 8
  `) as unknown as Row[];
  const cards = (await sql`
    select handle, name, merged_profile from atelier_style_card where workspace_id = ${ATELIER_WS}
  `) as unknown as Row[];
  const employees = (await sql`
    select slug, name, role from atelier_employee where workspace_id = ${ATELIER_WS}
  `) as unknown as Row[];

  // ── KPIs ──────────────────────────────────────────────────────────────
  const tasksTotal = tasks.length;
  const tasksDone = tasks.filter((t) => t.state === 'shipped').length;
  const progressPct = tasksTotal ? Math.round((tasks.filter((t) => DONE.has(t.state as string)).length / tasksTotal) * 100) : 0;
  const activeSlugs = new Set(tasks.filter((t) => ACTIVE.has(t.state as string)).map((t) => t.assignee_employee_slug));
  const agentsActive = [...activeSlugs].filter(Boolean).length;
  const passScores = proofs.filter((p) => p.status === 'pass' && p.score != null).map((p) => Number(p.score));
  const confidence = passScores.length
    ? Math.round((passScores.reduce((a, b) => a + b, 0) / passScores.length) * 100)
    : tasksTotal
      ? Math.round((tasksDone / tasksTotal) * 100)
      : 0;

  // ── Project Flow ──────────────────────────────────────────────────────
  const flow: FlowStage[] = STAGES.map((s) => {
    const stageTasks = tasks.filter((t) => (t.assignee_employee_slug as string) === s.role);
    const subtasks: FlowSubTask[] = stageTasks.map((t) => ({
      title: t.title as string,
      status: DONE.has(t.state as string) ? 'done' : ACTIVE.has(t.state as string) ? 'active' : 'pending',
    }));
    let status: FlowStage['status'] = 'pending';
    if (stageTasks.length && stageTasks.every((t) => t.state === 'shipped')) status = 'complete';
    else if (stageTasks.some((t) => ACTIVE.has(t.state as string) || DONE.has(t.state as string))) status = 'in_progress';
    return { ...s, status, subtasks };
  });

  // ── Decision queue: a task kind='decision' with spec.options ──────────
  const decisionTask = tasks.find((t) => t.kind === 'decision');
  let decision: ProjectDashboard['decision'] = null;
  if (decisionTask) {
    const spec = (decisionTask.spec ?? {}) as { question?: string; options?: DecisionOption[] };
    if (spec.question && Array.isArray(spec.options)) decision = { question: spec.question, options: spec.options };
  }

  // ── Outputs: proofs that produced a screenshot ───────────────────────
  const outputs: OutputCard[] = proofs
    .map((p) => {
      const detail = (p.detail ?? {}) as { screenshotRef?: string };
      const t = tasks.find((x) => x.id === p.task_id);
      return {
        title: (t?.title as string) ?? 'Output',
        kind: p.kind as string,
        screenshotRef: detail.screenshotRef ?? null,
        updated: timeAgo(p.created_at as string),
      };
    })
    .filter((o) => o.screenshotRef)
    .slice(0, 4);

  // ── Activity feed (the Dossier log) ──────────────────────────────────
  const empName = new Map(employees.map((e) => [e.slug as string, e.name as string]));
  const activity: ActivityItem[] = entries.map((e) => ({
    employee: empName.get(e.employee_slug as string) ?? (e.employee_slug as string) ?? 'System',
    body: (e.body as string) ?? (e.entry_type as string),
    type: e.entry_type as string,
    at: timeAgo(e.created_at as string),
  }));

  // ── Knowledge bases (the style cards in play) ────────────────────────
  const knowledgeBases: KnowledgeBase[] = cards.map((c) => {
    const mp = (c.merged_profile ?? {}) as Record<string, unknown>;
    return { handle: c.handle as string, name: (c.name as string) ?? (c.handle as string), count: Object.keys(mp).length || 1 };
  });

  // ── Executive briefing (Cleo) — opinionated, from real state ─────────
  const standoutProof = proofs.find((p) => p.status === 'pass' && p.kind === 'render_qc');
  const bullets = [
    confidence >= 80 ? `Confidence ${confidence}/100 — proofs are clearing the bar.` : `Confidence ${confidence}/100 — watch the open proofs.`,
    `${tasksDone}/${tasksTotal} shipped · ${agentsActive} specialist${agentsActive === 1 ? '' : 's'} working now.`,
    standoutProof ? `On-brand render verified (palette ΔE within tolerance).` : `No verified render yet — Hugo/Remy still building.`,
    decision ? `One decision needs you: "${decision.question}".` : `No blocking decisions — the line is moving.`,
  ];
  const briefing = {
    summary: `${dossier.objective ?? dossier.title} — proof-gated, ${progressPct}% through the flow.`,
    bullets,
  };

  return {
    slug: dossier.slug as string,
    title: dossier.title as string,
    objective: (dossier.objective as string) ?? '',
    status: (dossier.status as string) ?? 'active',
    kpis: { progressPct, agentsActive, agentsTotal: employees.length, tasksDone, tasksTotal, confidence },
    briefing,
    decision,
    flow,
    outputs,
    activity,
    knowledgeBases,
  };
}
