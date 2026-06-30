// lib/viewspecs.tsx
//
// The OTHER ViewSpecs. The Floor renders one data model — atelier_task rows —
// in many shapes. The canonical Lanes layout lives on the employee board
// (app/employee/[slug]/page.tsx). This file adds the rest as pure,
// presentational, server-component-safe React: no client hooks, no state, no
// effects. Each component takes Task[] straight from lib/atelier and reuses the
// teal/gold design tokens (app/globals.css: .surface, .chip, .lane*, plus the
// --teal/--gold CSS variables for layout-specific chrome).
//
// A ViewSpec row (atelier_view_spec) carries {layout, filters, columns}; the
// renderViewSpec(layout, tasks) dispatcher maps layout -> component so an
// employee page can pick its view by its stored view_spec.layout.

import type { Task } from './atelier';
import type { TaskState, ViewLayout } from './contracts';

/* ------------------------------------------------------------------ */
/* Shared vocabulary + helpers                                         */
/* ------------------------------------------------------------------ */

// Human labels for each task state, in flow order.
const STATE_ORDER: readonly TaskState[] = [
  'captured',
  'scoped',
  'active',
  'proofed',
  'review',
  'shipped',
];

const STATE_LABEL: Record<TaskState, string> = {
  captured: 'Captured',
  scoped: 'Scoped',
  active: 'Active',
  proofed: 'Proofed',
  review: 'Needs You',
  shipped: 'Shipped',
};

// The Build-line collapses the six states into the five production stages.
const BUILD_STAGES: ReadonlyArray<{
  key: string;
  label: string;
  states: TaskState[];
}> = [
  { key: 'spec', label: 'SPEC', states: ['captured', 'scoped'] },
  { key: 'build', label: 'BUILD', states: ['active'] },
  { key: 'test', label: 'TEST', states: ['proofed'] },
  { key: 'review', label: 'REVIEW', states: ['review'] },
  { key: 'shipped', label: 'SHIPPED', states: ['shipped'] },
];

// A proof-status chip class is already defined in globals.css
// (.chip--passing / .chip--failing / .chip--pending). State chips too
// (.chip--captured … .chip--shipped). We lean on those rather than reinvent.

// Task.proofStatus carries the rolled-up gate signal (pending/passing/failing).
// We accept it as a plain string so callers can pass the row field directly
// regardless of how its TS literal type is declared upstream.
function proofChipClass(proofStatus: string): string {
  if (proofStatus === 'passing') return 'chip chip--passing';
  if (proofStatus === 'failing') return 'chip chip--failing';
  return 'chip chip--pending';
}

function proofTone(proofStatus: string): string {
  if (proofStatus === 'passing') return 'var(--ok)';
  if (proofStatus === 'failing') return 'var(--fail)';
  return 'var(--gold)';
}

function stateChipClass(state: TaskState): string {
  return `chip chip--${state}`;
}

function fmtDate(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function toTime(value: Date | string | null): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const t = date.getTime();
  return Number.isNaN(t) ? null : t;
}

// Radar needs a single number per task. There is no first-class score column on
// atelier_task, so we read the most recently-resolved signal out of the spec
// jsonb (match_score / score / breakdown.palette_deltaE inverted, etc.). Always
// returns a clamped 0..100, falling back to a state-based heuristic so every
// task plots somewhere meaningful.
function taskScore(task: Task): number {
  const spec = (task.spec ?? {}) as Record<string, unknown>;
  const candidates: unknown[] = [
    spec.match_score,
    spec.score,
    spec.predicted_engagement,
    spec.coverage,
    (spec.breakdown as Record<string, unknown> | undefined)?.match_score,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) {
      const n = c <= 1 ? c * 100 : c;
      return Math.max(0, Math.min(100, Math.round(n)));
    }
  }
  // Heuristic fallback: further down the flow == more proven.
  const idx = STATE_ORDER.indexOf(task.state);
  const base = idx >= 0 ? (idx / (STATE_ORDER.length - 1)) * 100 : 0;
  const ps: string = task.proofStatus;
  const proofBump = ps === 'passing' ? 10 : ps === 'failing' ? -10 : 0;
  return Math.max(0, Math.min(100, Math.round(base + proofBump)));
}

/* ------------------------------------------------------------------ */
/* TaskCard — the shared atom every layout composes                     */
/* ------------------------------------------------------------------ */

function TaskCard({ task }: { task: Task }) {
  const shipped = fmtDate(task.shippedAt);
  return (
    <article
      className="surface surface--interactive"
      style={{
        padding: '0.7rem 0.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.45rem',
      }}
    >
      <h3 style={{ margin: 0, fontSize: '0.9rem', fontWeight: 600, lineHeight: 1.3 }}>
        {task.title}
      </h3>

      {task.intent ? (
        <p
          style={{
            margin: 0,
            fontSize: '0.78rem',
            color: 'var(--muted)',
            lineHeight: 1.4,
          }}
        >
          {task.intent}
        </p>
      ) : null}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.35rem',
          alignItems: 'center',
        }}
      >
        {task.kind ? <span className="chip chip--plain">{task.kind}</span> : null}
        {task.station ? (
          <span className="chip chip--plain chip--mono">{task.station}</span>
        ) : null}
        <span
          className={proofChipClass(task.proofStatus)}
          style={{ marginLeft: 'auto' }}
        >
          {task.proofStatus}
        </span>
      </div>

      {shipped ? (
        <div style={{ fontSize: '0.7rem', color: 'var(--faint)' }}>
          Shipped {shipped}
        </div>
      ) : null}
    </article>
  );
}

// A compact pill — used where a full card would crowd the layout (Time-axis).
function TaskPill({ task }: { task: Task }) {
  return (
    <span
      title={task.title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        maxWidth: '220px',
        padding: '0.3rem 0.6rem',
        borderRadius: 'var(--r-pill)',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        boxShadow: 'var(--shadow-sm)',
        fontSize: '0.74rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden
        style={{
          width: '0.5rem',
          height: '0.5rem',
          borderRadius: 'var(--r-pill)',
          flex: '0 0 auto',
          background: proofTone(task.proofStatus),
        }}
      />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {task.title}
      </span>
    </span>
  );
}

function EmptyNote({ label = 'Nothing here yet' }: { label?: string }) {
  return <p className="lane__empty">{label}</p>;
}

/* ------------------------------------------------------------------ */
/* <Grid> — a responsive wall of cards, flow-agnostic                   */
/* ------------------------------------------------------------------ */

export function Grid({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return <EmptyNote label="No tasks to show" />;
  return (
    <section
      aria-label="Grid view"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: 'var(--gap)',
        alignItems: 'start',
      }}
    >
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* <TimeAxis> — Remy's horizontal time ruler, pills by station          */
/* ------------------------------------------------------------------ */

export function TimeAxis({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return <EmptyNote label="No tasks on the timeline" />;

  // Build the time window from createdAt (fall back to shippedAt).
  const times = tasks
    .map((t) => toTime(t.createdAt) ?? toTime(t.shippedAt))
    .filter((n): n is number => n !== null);
  const min = times.length ? Math.min(...times) : 0;
  const max = times.length ? Math.max(...times) : 1;
  const span = Math.max(1, max - min);

  function leftPct(task: Task): number {
    const t = toTime(task.createdAt) ?? toTime(task.shippedAt) ?? min;
    return ((t - min) / span) * 100;
  }

  // One row per station; unlabelled tasks share a "—" row.
  const stations = Array.from(
    new Set(tasks.map((t) => t.station ?? '—')),
  ).sort();

  // A few evenly-spaced tick labels along the ruler.
  const ticks = [0, 25, 50, 75, 100].map((pct) => {
    const at = new Date(min + (span * pct) / 100);
    return { pct, label: fmtDate(at) ?? '' };
  });

  return (
    <section aria-label="Time-axis view" style={{ display: 'grid', gap: '0.6rem' }}>
      <div
        style={{
          position: 'relative',
          height: '1.4rem',
          marginLeft: '120px',
          borderBottom: '2px solid var(--teal)',
        }}
      >
        {ticks.map((tick) => (
          <span
            key={tick.pct}
            style={{
              position: 'absolute',
              left: `${tick.pct}%`,
              transform: 'translateX(-50%)',
              fontSize: '0.68rem',
              fontWeight: 700,
              letterSpacing: '0.06em',
              color: 'var(--muted)',
            }}
          >
            {tick.label}
          </span>
        ))}
      </div>

      {stations.map((station) => {
        const row = tasks.filter((t) => (t.station ?? '—') === station);
        return (
          <div
            key={station}
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <div
              className="lane__title"
              style={{ textAlign: 'right', paddingRight: '0.5rem' }}
            >
              {station}
            </div>
            <div
              style={{
                position: 'relative',
                minHeight: '2.2rem',
                borderRadius: 'var(--r)',
                background: 'var(--surface-2)',
                border: '1px solid var(--line)',
              }}
            >
              {row.map((task) => (
                <div
                  key={task.id}
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: `${leftPct(task)}%`,
                    transform: 'translate(-4px, -50%)',
                  }}
                >
                  <TaskPill task={task} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* <StatusWall> — Otto's tiles, grouped + colored by state/proof        */
/* ------------------------------------------------------------------ */

export function StatusWall({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return <EmptyNote label="The wall is clear" />;

  const groups = STATE_ORDER.map((state) => ({
    state,
    label: STATE_LABEL[state],
    items: tasks.filter((t) => t.state === state),
  })).filter((g) => g.items.length > 0);

  return (
    <section
      aria-label="Status-wall view"
      style={{ display: 'grid', gap: 'var(--gap)' }}
    >
      {groups.map((group) => (
        <div key={group.state} style={{ display: 'grid', gap: '0.6rem' }}>
          <div className="lane__head">
            <span className={stateChipClass(group.state)}>{group.label}</span>
            <span className="lane__count">{group.items.length}</span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: '0.5rem',
            }}
          >
            {group.items.map((task) => {
              const accent = proofTone(task.proofStatus);
              return (
                <article
                  key={task.id}
                  className="surface"
                  title={task.intent ?? task.title}
                  style={{
                    padding: '0.6rem 0.65rem',
                    borderLeft: `3px solid ${accent}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.4rem',
                    minHeight: '4.2rem',
                  }}
                >
                  <div
                    style={{
                      fontSize: '0.82rem',
                      fontWeight: 600,
                      lineHeight: 1.3,
                    }}
                  >
                    {task.title}
                  </div>
                  <div
                    style={{
                      marginTop: 'auto',
                      display: 'flex',
                      gap: '0.3rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    {task.kind ? (
                      <span className="chip chip--plain">{task.kind}</span>
                    ) : null}
                    <span
                      className={proofChipClass(task.proofStatus)}
                      style={{ marginLeft: 'auto' }}
                    >
                      {task.proofStatus}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* <BuildLine> — Hugo's SPEC -> BUILD -> TEST -> REVIEW -> SHIPPED       */
/* ------------------------------------------------------------------ */

export function BuildLine({ tasks }: { tasks: Task[] }) {
  return (
    <section
      aria-label="Build-line view"
      className="lanes"
      style={{ gridAutoColumns: 'minmax(200px, 1fr)' }}
    >
      {BUILD_STAGES.map((stage, i) => {
        const items = tasks.filter((t) => stage.states.includes(t.state));
        const isLast = i === BUILD_STAGES.length - 1;
        return (
          <div key={stage.key} className="lane">
            <div
              className="lane__head"
              style={{
                borderBottom: isLast
                  ? '2px solid var(--gold)'
                  : '2px solid var(--teal)',
              }}
            >
              <span className="lane__title">
                {stage.label}
                {!isLast ? (
                  <span aria-hidden style={{ color: 'var(--faint)' }}>
                    {' '}
                    →
                  </span>
                ) : null}
              </span>
              <span className="lane__count">{items.length}</span>
            </div>
            <div className="lane__cards">
              {items.length === 0 ? (
                <EmptyNote label="—" />
              ) : (
                items.map((task) => <TaskCard key={task.id} task={task} />)
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* <Radar> — Vera's score scatter: a ranked bar list by taskScore        */
/* ------------------------------------------------------------------ */

export function Radar({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return <EmptyNote label="No signals to plot" />;

  const ranked = tasks
    .map((task) => ({ task, score: taskScore(task) }))
    .sort((a, b) => b.score - a.score);

  return (
    <section aria-label="Radar view" style={{ display: 'grid', gap: '0.5rem' }}>
      {ranked.map(({ task, score }) => {
        const tone =
          score >= 75 ? 'var(--ok)' : score >= 45 ? 'var(--gold)' : 'var(--fail)';
        return (
          <div
            key={task.id}
            className="surface"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 56px',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.6rem 0.75rem',
            }}
          >
            <div style={{ display: 'grid', gap: '0.4rem' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  fontSize: '0.86rem',
                  fontWeight: 600,
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {task.title}
                </span>
                <span className={stateChipClass(task.state)} style={{ marginLeft: 'auto' }}>
                  {STATE_LABEL[task.state]}
                </span>
              </div>
              <div
                style={{
                  position: 'relative',
                  height: '0.5rem',
                  borderRadius: 'var(--r-pill)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--line)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    inset: '0 auto 0 0',
                    width: `${score}%`,
                    background: tone,
                    borderRadius: 'var(--r-pill)',
                  }}
                />
              </div>
            </div>
            <div
              style={{
                fontSize: '1.1rem',
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right',
                color: tone,
              }}
            >
              {score}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Dispatcher — layout -> component                                     */
/* ------------------------------------------------------------------ */

// Maps an atelier_view_spec.layout to its presentational component. The
// canonical 'lanes' layout is owned by the employee board itself; here it
// degrades gracefully to the Grid so a stray 'lanes' value never renders blank.
export function renderViewSpec(layout: ViewLayout | string, tasks: Task[]) {
  switch (layout) {
    case 'grid':
      return <Grid tasks={tasks} />;
    case 'time_axis':
      return <TimeAxis tasks={tasks} />;
    case 'status_wall':
      return <StatusWall tasks={tasks} />;
    case 'build_line':
      return <BuildLine tasks={tasks} />;
    case 'radar':
      return <Radar tasks={tasks} />;
    case 'lanes':
    default:
      return <Grid tasks={tasks} />;
  }
}