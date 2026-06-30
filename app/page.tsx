import { getFloor } from "@/lib/atelier";

export const dynamic = "force-dynamic";

// The floor's shape is owned by lib/atelier.ts (getFloor). We derive every
// presentational type from its inferred return so this view stays in lockstep
// with the repository instead of re-declaring it.
type Floor = Awaited<ReturnType<typeof getFloor>>;
type NeedsYouItem = Floor["needsYou"][number];
type Employee = Floor["employees"][number];
type FloorTask = Floor["inFlight"][number];

// --- theme tokens (mirror app/globals.css; hex fallbacks keep SSR honest) ---
const TEAL = "var(--teal, #0d9488)";
const GOLD = "var(--gold, #c79320)";
const PAGE = "var(--page, #f5f3ec)";
const INK = "var(--ink, #15201c)";
const INK_SOFT = "color-mix(in srgb, var(--ink, #15201c) 62%, transparent)";
const LINE = "color-mix(in srgb, var(--ink, #15201c) 12%, transparent)";
const CARD = "#ffffff";

const STATUS_COLORS: Record<string, string> = {
  idle: "color-mix(in srgb, var(--ink, #15201c) 38%, transparent)",
  working: "var(--teal, #0d9488)",
  blocked: "#c0392b",
  waiting: "var(--gold, #c79320)",
};

function fmtWhen(value: unknown): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function CleosFloor() {
  const floor = await getFloor();
  const { employees, needsYou, inFlight, blocked, shipped } = floor;

  return (
    <main
      style={{
        minHeight: "100vh",
        background: PAGE,
        color: INK,
        padding: "40px 28px 72px",
        maxWidth: 1180,
        margin: "0 auto",
      }}
    >
      {/* ---------------- header brief ---------------- */}
      <header
        style={{
          borderBottom: `2px solid ${GOLD}`,
          paddingBottom: 22,
          marginBottom: 36,
        }}
      >
        <div
          style={{
            fontSize: 12,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: TEAL,
            fontWeight: 700,
          }}
        >
          Atelier — Cleo&apos;s Floor
        </div>
        <h1
          style={{
            margin: "10px 0 14px",
            fontSize: 34,
            fontWeight: 800,
            letterSpacing: "-0.01em",
          }}
        >
          The work that needs you.
        </h1>
        <a href="/project/launch-course-19" style={{ display: "inline-block", marginBottom: 10, fontSize: 13, fontWeight: 700, color: TEAL, textDecoration: "none" }}>
          → Open the Project Command Center
        </a>
        <a href="/wren" style={{ display: "inline-block", marginLeft: 14, marginBottom: 10, fontSize: 13, fontWeight: 700, color: "#7c5cff", textDecoration: "none" }}>
          ✍️ Talk to Wren
        </a>
        <a href="/talk/cleo" style={{ display: "inline-block", marginLeft: 14, marginBottom: 10, fontSize: 13, fontWeight: 700, color: "#19c39a", textDecoration: "none" }}>
          💬 Talk to your team
        </a>
        <p style={{ margin: 0, fontSize: 15.5, color: INK_SOFT }}>
          <strong style={{ color: needsYou.length ? GOLD : INK_SOFT }}>
            {needsYou.length}
          </strong>{" "}
          awaiting your approval
          {"  ·  "}
          <strong style={{ color: TEAL }}>{inFlight.length}</strong> in flight
          {"  ·  "}
          <strong>{shipped.length}</strong> shipped
          {blocked.length > 0 ? (
            <>
              {"  ·  "}
              <strong style={{ color: "#c0392b" }}>{blocked.length}</strong>{" "}
              blocked
            </>
          ) : null}
        </p>
      </header>

      {/* ---------------- NEEDS YOU ---------------- */}
      <section style={{ marginBottom: 48 }}>
        <SectionLabel accent={GOLD}>Needs you</SectionLabel>
        {needsYou.length === 0 ? (
          <EmptyNote>Nothing is waiting on a decision. The floor is clear.</EmptyNote>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 14 }}>
            {needsYou.map((item) => (
              <NeedsYouRow key={item.task.id} item={item} />
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- IN FLIGHT (employee grid) ---------------- */}
      <section style={{ marginBottom: 48 }}>
        <SectionLabel accent={TEAL}>In flight</SectionLabel>
        {employees.length === 0 ? (
          <EmptyNote>No employees on the floor yet. Seed the workspace.</EmptyNote>
        ) : (
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
            }}
          >
            {employees.map((employee) => (
              <EmployeeCard key={employee.id} employee={employee} />
            ))}
          </div>
        )}
      </section>

      {/* ---------------- BLOCKED ---------------- */}
      {blocked.length > 0 ? (
        <section style={{ marginBottom: 48 }}>
          <SectionLabel accent="#c0392b">Blocked</SectionLabel>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {blocked.map((task) => (
              <li
                key={task.id}
                style={{
                  background: CARD,
                  border: `1px solid ${LINE}`,
                  borderLeft: "4px solid #c0392b",
                  borderRadius: 10,
                  padding: "12px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  fontSize: 14.5,
                }}
              >
                <span style={{ fontWeight: 600 }}>{task.title}</span>
                <span style={{ color: INK_SOFT, fontSize: 13 }}>
                  {task.station ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---------------- SHIPPED strip ---------------- */}
      <section>
        <SectionLabel accent={INK}>Shipped</SectionLabel>
        {shipped.length === 0 ? (
          <EmptyNote>Nothing has shipped yet today.</EmptyNote>
        ) : (
          <div
            style={{
              display: "flex",
              gap: 12,
              overflowX: "auto",
              paddingBottom: 6,
            }}
          >
            {shipped.map((task) => (
              <ShippedChip key={task.id} task={task} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

/* ============================ pieces ============================ */

function SectionLabel({
  children,
  accent,
}: {
  children: React.ReactNode;
  accent: string;
}) {
  return (
    <h2
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 13,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        fontWeight: 700,
        color: INK,
        margin: "0 0 16px",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: accent,
          display: "inline-block",
        }}
      />
      {children}
    </h2>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: 14,
        color: INK_SOFT,
        fontStyle: "italic",
        padding: "14px 16px",
        background: CARD,
        border: `1px dashed ${LINE}`,
        borderRadius: 10,
      }}
    >
      {children}
    </p>
  );
}

function NeedsYouRow({ item }: { item: NeedsYouItem }) {
  const { task, proof } = item;
  return (
    <li
      style={{
        background: CARD,
        border: `1px solid ${LINE}`,
        borderLeft: `4px solid ${GOLD}`,
        borderRadius: 12,
        padding: "16px 18px",
        display: "flex",
        gap: 18,
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 240, flex: "1 1 320px" }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{task.title}</div>
        {task.intent ? (
          <div style={{ fontSize: 13.5, color: INK_SOFT, marginTop: 4 }}>
            {task.intent}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 10,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {task.assigneeSlug ? (
            <Pill>@{task.assigneeSlug}</Pill>
          ) : null}
          {task.station ? <Pill>{task.station}</Pill> : null}
          <ProofBadge proof={proof} />
        </div>
      </div>

      {/* native POST -> /api/approve (no client JS in week 1) */}
      <form action="/api/approve" method="post" style={{ margin: 0 }}>
        <input type="hidden" name="taskId" value={task.id} />
        <button
          type="submit"
          style={{
            background: TEAL,
            color: "#ffffff",
            border: "none",
            borderRadius: 9,
            padding: "11px 22px",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
            letterSpacing: "0.01em",
          }}
        >
          Approve &amp; ship
        </button>
      </form>
    </li>
  );
}

function ProofBadge({ proof }: { proof: NeedsYouItem["proof"] }) {
  if (!proof) {
    return (
      <span style={{ fontSize: 12.5, color: "#c0392b", fontWeight: 600 }}>
        no proof
      </span>
    );
  }
  const passing = proof.status === "pass";
  const color = passing ? TEAL : proof.status === "warn" ? GOLD : "#c0392b";
  const hasScore = typeof proof.score === "number";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12.5,
        fontWeight: 700,
        color,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: color }} />
      {proof.kind} · {proof.status}
      {hasScore ? (
        <span style={{ color: INK_SOFT, fontWeight: 600 }}>
          ({proof.score}
          {typeof proof.threshold === "number" ? ` / ${proof.threshold}` : ""})
        </span>
      ) : null}
    </span>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: INK_SOFT,
        background: "color-mix(in srgb, var(--ink, #15201c) 6%, transparent)",
        borderRadius: 999,
        padding: "3px 10px",
      }}
    >
      {children}
    </span>
  );
}

function EmployeeCard({ employee }: { employee: Employee }) {
  const dot = STATUS_COLORS[employee.status] ?? STATUS_COLORS.idle;
  return (
    <a
      href={`/talk/${employee.slug}`}
      style={{
        background: CARD,
        border: `1px solid ${LINE}`,
        borderRadius: 12,
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 15.5, fontWeight: 700 }}>{employee.name}</span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color: dot,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: 999, background: dot }} />
          {employee.status}
        </span>
      </div>
      <div style={{ fontSize: 13.5, color: INK_SOFT }}>{employee.role}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: employee.tier === "specialist" ? GOLD : TEAL,
            border: `1px solid ${employee.tier === "specialist" ? GOLD : TEAL}`,
            borderRadius: 6,
            padding: "2px 7px",
          }}
        >
          {employee.tier}
        </span>
        {employee.brainModel ? (
          <span style={{ fontSize: 12, color: INK_SOFT }}>{employee.brainModel}</span>
        ) : null}
      </div>
      <span style={{ fontSize: 11, color: TEAL, fontWeight: 600 }}>💬 Talk →</span>
    </a>
  );
}

function ShippedChip({ task }: { task: FloorTask }) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        minWidth: 200,
        maxWidth: 280,
        background: CARD,
        border: `1px solid ${LINE}`,
        borderTop: `3px solid ${TEAL}`,
        borderRadius: 10,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {task.title}
      </div>
      <div style={{ fontSize: 12, color: INK_SOFT, marginTop: 4 }}>
        {task.shippedAt ? `shipped ${fmtWhen(task.shippedAt)}` : "shipped"}
      </div>
    </div>
  );
}
