import { notFound } from "next/navigation";
import Link from "next/link";
import { getEmployee, getEmployeeTasks } from "@/lib/atelier";
import type { TaskState } from "@/lib/contracts";

export const dynamic = "force-dynamic";

// Row shapes are derived straight from the repository return types so this
// board stays in lockstep with lib/atelier.ts (one data model -> role board).
type EmployeeRow = NonNullable<Awaited<ReturnType<typeof getEmployee>>>;
type TaskRow = Awaited<ReturnType<typeof getEmployeeTasks>>[number];

// The Lanes ViewSpec: the canonical left-to-right flow of the floor.
const LANES: ReadonlyArray<{ state: TaskState; label: string; hint: string }> = [
  { state: "captured", label: "Captured", hint: "Came in the door" },
  { state: "scoped", label: "Scoped", hint: "Intent is clear" },
  { state: "active", label: "Active", hint: "On the bench" },
  { state: "proofed", label: "Proofed", hint: "Has a passing proof" },
  { state: "review", label: "Needs You", hint: "Awaiting approval" },
  { state: "shipped", label: "Shipped", hint: "Out the door" },
];

const PROOF_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  passing: { label: "proof passing", bg: "rgba(13,148,136,0.12)", fg: "#0d9488" },
  failing: { label: "proof failing", bg: "rgba(180,35,35,0.12)", fg: "#b42323" },
  pending: { label: "proof pending", bg: "rgba(199,147,32,0.14)", fg: "#9a7016" },
};

function fmtTime(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const employee = await getEmployee(slug);
  return { title: employee ? `${employee.name} — Atelier` : "Atelier" };
}

export default async function EmployeeBoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const employee: EmployeeRow | null | undefined = await getEmployee(slug);
  if (!employee) notFound();

  const tasks: TaskRow[] = await getEmployeeTasks(slug);

  const byState = new Map<TaskState, TaskRow[]>();
  for (const lane of LANES) byState.set(lane.state, []);
  for (const task of tasks) {
    const bucket = byState.get(task.state as TaskState);
    if (bucket) bucket.push(task);
  }

  const open = tasks.filter((t) => t.state !== "shipped").length;

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--page, #f5f3ec)",
        color: "var(--ink, #15201c)",
        padding: "2rem clamp(1rem, 4vw, 3rem)",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <header
        style={{
          maxWidth: "1280px",
          margin: "0 auto 1.75rem",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: "1rem",
        }}
      >
        <div>
          <Link
            href="/"
            style={{
              color: "var(--teal, #0d9488)",
              textDecoration: "none",
              fontSize: "0.82rem",
              fontWeight: 600,
              letterSpacing: "0.02em",
            }}
          >
            ← Cleo&rsquo;s Floor
          </Link>
          <h1
            style={{
              margin: "0.4rem 0 0.25rem",
              fontSize: "clamp(1.5rem, 3vw, 2.1rem)",
              fontWeight: 700,
              letterSpacing: "-0.01em",
            }}
          >
            {employee.name}
          </h1>
          <p
            style={{
              margin: 0,
              color: "rgba(21,32,28,0.66)",
              fontSize: "0.95rem",
            }}
          >
            <span style={{ fontWeight: 600 }}>{employee.role}</span>
            <span aria-hidden> · </span>
            <span style={{ textTransform: "capitalize" }}>{employee.tier}</span>
            {employee.brainModel ? (
              <>
                <span aria-hidden> · </span>
                <span>{employee.brainModel}</span>
              </>
            ) : null}
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.35rem 0.7rem",
              borderRadius: "999px",
              background: "#fff",
              border: "1px solid rgba(21,32,28,0.1)",
              fontSize: "0.8rem",
              fontWeight: 600,
              textTransform: "capitalize",
            }}
          >
            <span
              style={{
                width: "0.55rem",
                height: "0.55rem",
                borderRadius: "999px",
                background:
                  employee.status === "blocked"
                    ? "#b42323"
                    : employee.status === "working"
                      ? "var(--teal, #0d9488)"
                      : employee.status === "waiting"
                        ? "var(--gold, #c79320)"
                        : "rgba(21,32,28,0.3)",
              }}
            />
            {employee.status}
          </span>
          <span
            style={{
              padding: "0.35rem 0.7rem",
              borderRadius: "999px",
              background: "var(--ink, #15201c)",
              color: "var(--page, #f5f3ec)",
              fontSize: "0.8rem",
              fontWeight: 600,
            }}
          >
            {open} open
          </span>
        </div>
      </header>

      <section
        aria-label="Lanes view"
        style={{
          maxWidth: "1280px",
          margin: "0 auto",
          display: "grid",
          gridAutoFlow: "column",
          gridAutoColumns: "minmax(248px, 1fr)",
          gap: "0.9rem",
          overflowX: "auto",
          paddingBottom: "0.75rem",
          alignItems: "start",
        }}
      >
        {LANES.map((lane) => {
          const laneTasks = byState.get(lane.state) ?? [];
          return (
            <div
              key={lane.state}
              style={{
                background: "rgba(255,255,255,0.55)",
                border: "1px solid rgba(21,32,28,0.08)",
                borderRadius: "14px",
                padding: "0.75rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.6rem",
                minHeight: "120px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: "0.5rem",
                  paddingBottom: "0.4rem",
                  borderBottom:
                    lane.state === "review"
                      ? "2px solid var(--gold, #c79320)"
                      : "2px solid rgba(13,148,136,0.25)",
                }}
              >
                <div>
                  <div style={{ fontSize: "0.92rem", fontWeight: 700 }}>
                    {lane.label}
                  </div>
                  <div
                    style={{
                      fontSize: "0.72rem",
                      color: "rgba(21,32,28,0.5)",
                    }}
                  >
                    {lane.hint}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: "0.78rem",
                    fontWeight: 700,
                    color:
                      lane.state === "review"
                        ? "var(--gold, #c79320)"
                        : "var(--teal, #0d9488)",
                  }}
                >
                  {laneTasks.length}
                </span>
              </div>

              {laneTasks.length === 0 ? (
                <p
                  style={{
                    margin: "0.25rem 0",
                    fontSize: "0.78rem",
                    color: "rgba(21,32,28,0.35)",
                    fontStyle: "italic",
                  }}
                >
                  Empty lane
                </p>
              ) : (
                laneTasks.map((task) => {
                  const badge =
                    PROOF_BADGE[task.proofStatus] ?? PROOF_BADGE.pending;
                  const shipped = fmtTime(task.shippedAt);
                  return (
                    <article
                      key={task.id}
                      style={{
                        background: "#fff",
                        border: "1px solid rgba(21,32,28,0.1)",
                        borderRadius: "10px",
                        padding: "0.7rem 0.75rem",
                        boxShadow: "0 1px 2px rgba(21,32,28,0.04)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.45rem",
                      }}
                    >
                      <h3
                        style={{
                          margin: 0,
                          fontSize: "0.9rem",
                          fontWeight: 600,
                          lineHeight: 1.3,
                        }}
                      >
                        {task.title}
                      </h3>

                      {task.intent ? (
                        <p
                          style={{
                            margin: 0,
                            fontSize: "0.78rem",
                            color: "rgba(21,32,28,0.6)",
                            lineHeight: 1.4,
                          }}
                        >
                          {task.intent}
                        </p>
                      ) : null}

                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "0.35rem",
                          alignItems: "center",
                        }}
                      >
                        {task.kind ? (
                          <span
                            style={{
                              fontSize: "0.68rem",
                              fontWeight: 600,
                              padding: "0.15rem 0.45rem",
                              borderRadius: "999px",
                              background: "rgba(13,148,136,0.1)",
                              color: "var(--teal, #0d9488)",
                            }}
                          >
                            {task.kind}
                          </span>
                        ) : null}
                        {task.station ? (
                          <span
                            style={{
                              fontSize: "0.68rem",
                              fontWeight: 600,
                              padding: "0.15rem 0.45rem",
                              borderRadius: "999px",
                              background: "rgba(21,32,28,0.06)",
                              color: "rgba(21,32,28,0.6)",
                            }}
                          >
                            {task.station}
                          </span>
                        ) : null}
                        <span
                          style={{
                            fontSize: "0.68rem",
                            fontWeight: 600,
                            padding: "0.15rem 0.45rem",
                            borderRadius: "999px",
                            background: badge.bg,
                            color: badge.fg,
                            marginLeft: "auto",
                          }}
                        >
                          {badge.label}
                        </span>
                      </div>

                      {shipped ? (
                        <div
                          style={{
                            fontSize: "0.7rem",
                            color: "rgba(21,32,28,0.45)",
                          }}
                        >
                          Shipped {shipped}
                        </div>
                      ) : null}
                    </article>
                  );
                })
              )}
            </div>
          );
        })}
      </section>
    </main>
  );
}
