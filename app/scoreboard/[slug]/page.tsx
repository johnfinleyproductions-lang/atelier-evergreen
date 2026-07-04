import { getProofLog } from "@/lib/scoreboard";
import { getAgent } from "@/lib/agents/chat";
import { notFound } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- theme tokens (mirror app/globals.css; hex fallbacks keep SSR honest) ---
const TEAL = "var(--teal, #0d9488)";
const GOLD = "var(--gold, #c79320)";
const PAGE = "var(--page, #f5f3ec)";
const INK = "var(--ink, #15201c)";
const INK_SOFT = "color-mix(in srgb, var(--ink, #15201c) 62%, transparent)";
const LINE = "color-mix(in srgb, var(--ink, #15201c) 12%, transparent)";
const CARD = "#ffffff";
const RED = "#c0392b";

const th: React.CSSProperties = {
  textAlign: "left", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase",
  color: INK_SOFT, fontWeight: 700, padding: "10px 14px", borderBottom: `1px solid ${LINE}`,
};
const td: React.CSSProperties = {
  padding: "12px 14px", fontSize: 13.5, borderBottom: `1px solid ${LINE}`,
  fontVariantNumeric: "tabular-nums", verticalAlign: "top",
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function ProofLogPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const days = sp.days === "7" ? 7 : sp.days === "90" ? 90 : 30;
  const agent = await getAgent(slug);
  if (!agent) notFound();
  const log = await getProofLog(slug, days);

  return (
    <main style={{ minHeight: "100vh", background: PAGE, color: INK, padding: "40px 28px 72px", maxWidth: 1180, margin: "0 auto" }}>
      <header style={{ borderBottom: `2px solid ${GOLD}`, paddingBottom: 22, marginBottom: 30 }}>
        <div style={{ fontSize: 12, letterSpacing: "0.22em", textTransform: "uppercase", color: TEAL, fontWeight: 700 }}>
          Atelier — Proof Log
        </div>
        <h1 style={{ margin: "10px 0 14px", fontSize: 34, fontWeight: 800, letterSpacing: "-0.01em" }}>
          {agent.name} — every measurement, last {days}d
        </h1>
        <a href="/scoreboard" style={{ fontSize: 13, fontWeight: 700, color: TEAL, textDecoration: "none" }}>← Scoreboard</a>
        <a href={`/talk/${slug}`} style={{ marginLeft: 16, fontSize: 13, fontWeight: 700, color: GOLD, textDecoration: "none" }}>💬 Talk to {agent.name}</a>
      </header>

      <section style={{ background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Task</th>
                <th style={th}>Kind</th>
                <th style={th}>Result</th>
                <th style={th}>Score</th>
                <th style={th}>ΔE (mean / max)</th>
                <th style={th}>Model</th>
                <th style={th}>Soul</th>
                <th style={th}>Render</th>
              </tr>
            </thead>
            <tbody>
              {log.map((p) => (
                <tr key={p.id}>
                  <td style={{ ...td, whiteSpace: "nowrap", color: INK_SOFT }}>{fmtWhen(p.createdAt)}</td>
                  <td style={{ ...td, maxWidth: 220 }}>{p.taskTitle ?? <span style={{ color: INK_SOFT }}>—</span>}</td>
                  <td style={td}>
                    {p.kind}
                    {p.evidence ? <span style={{ marginLeft: 6, fontSize: 10.5, color: INK_SOFT, textTransform: "uppercase", letterSpacing: "0.08em" }}>{p.evidence}</span> : null}
                  </td>
                  <td style={{ ...td, fontWeight: 800, color: p.status === "pass" ? TEAL : p.status === "fail" ? RED : GOLD }}>
                    {p.status}
                  </td>
                  <td style={td}>
                    {p.score != null ? p.score.toFixed(2) : "—"}
                    {p.threshold != null ? <span style={{ color: INK_SOFT, fontSize: 11.5 }}> / {p.threshold}</span> : null}
                  </td>
                  <td style={td}>
                    {p.deMean != null || p.deMax != null
                      ? <>{p.deMean != null ? p.deMean.toFixed(1) : "—"} / <span style={{ color: (p.deMax ?? 0) > 30 ? RED : INK }}>{p.deMax != null ? p.deMax.toFixed(1) : "—"}</span></>
                      : "—"}
                  </td>
                  <td style={{ ...td, fontSize: 12 }}>{p.model ?? "—"}</td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}>
                    {p.soulVersion ? (p.soulVersion === "inline" ? <span style={{ color: INK_SOFT }}>inline</span> : `@${p.soulVersion}`) : "—"}
                  </td>
                  <td style={td}>
                    {p.screenshotRef ? (
                      <a href={p.screenshotRef} target="_blank" style={{ display: "block" }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.screenshotRef} alt="render" style={{ width: 120, borderRadius: 6, border: `1px solid ${LINE}`, display: "block" }} />
                      </a>
                    ) : "—"}
                  </td>
                </tr>
              ))}
              {!log.length ? (
                <tr><td style={{ ...td, color: INK_SOFT }} colSpan={9}>No proof rows for {agent.name} in this window.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 16px 14px", fontSize: 12.5, color: INK_SOFT }}>
          Every row is an append-only measurement — this is the evidence behind the scoreboard&apos;s aggregates.
        </div>
      </section>
    </main>
  );
}
