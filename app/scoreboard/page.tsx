import { getScoreboard } from "@/lib/scoreboard";

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

const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const fx = (x: number | null, d = 1) => (x == null ? "—" : x.toFixed(d));

function PassBar({ rate }: { rate: number | null }) {
  if (rate == null) return <span style={{ color: INK_SOFT }}>—</span>;
  const color = rate >= 0.8 ? TEAL : rate >= 0.5 ? GOLD : RED;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 72, height: 6, borderRadius: 3, background: LINE, overflow: "hidden", display: "inline-block" }}>
        <span style={{ display: "block", width: `${Math.round(rate * 100)}%`, height: "100%", background: color }} />
      </span>
      <strong style={{ color, fontVariantNumeric: "tabular-nums" }}>{pct(rate)}</strong>
    </span>
  );
}

function Trend({ now, prev }: { now: number | null; prev: number | null }) {
  if (now == null || prev == null) return <span style={{ color: INK_SOFT }}>—</span>;
  const d = Math.round((now - prev) * 100);
  if (d === 0) return <span style={{ color: INK_SOFT }}>±0</span>;
  return <span style={{ color: d > 0 ? TEAL : RED, fontWeight: 700 }}>{d > 0 ? `▲ +${d}` : `▼ ${d}`}</span>;
}

const th: React.CSSProperties = {
  textAlign: "left", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase",
  color: INK_SOFT, fontWeight: 700, padding: "10px 14px", borderBottom: `1px solid ${LINE}`,
};
const td: React.CSSProperties = {
  padding: "12px 14px", fontSize: 14, borderBottom: `1px solid ${LINE}`,
  fontVariantNumeric: "tabular-nums", verticalAlign: "middle",
};

export default async function ScoreboardPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const sp = await searchParams;
  const days = sp.days === "7" ? 7 : sp.days === "90" ? 90 : 30;
  const sb = await getScoreboard(days);
  const active = sb.agents.filter((a) => a.proofs.total || a.jobs.total);
  const idle = sb.agents.filter((a) => !a.proofs.total && !a.jobs.total);
  const reviews = sb.wrenReviews.ship + sb.wrenReviews.revise;

  return (
    <main style={{ minHeight: "100vh", background: PAGE, color: INK, padding: "40px 28px 72px", maxWidth: 1180, margin: "0 auto" }}>
      <header style={{ borderBottom: `2px solid ${GOLD}`, paddingBottom: 22, marginBottom: 30 }}>
        <div style={{ fontSize: 12, letterSpacing: "0.22em", textTransform: "uppercase", color: TEAL, fontWeight: 700 }}>
          Atelier — Scoreboard
        </div>
        <h1 style={{ margin: "10px 0 14px", fontSize: 34, fontWeight: 800, letterSpacing: "-0.01em" }}>
          Proof-gated, measured.
        </h1>
        <a href="/" style={{ display: "inline-block", marginBottom: 10, fontSize: 13, fontWeight: 700, color: TEAL, textDecoration: "none" }}>
          ← Cleo&apos;s Floor
        </a>
        <span style={{ marginLeft: 18, fontSize: 13, color: INK_SOFT }}>
          Window:{" "}
          {[7, 30, 90].map((d) => (
            <a
              key={d}
              href={`/scoreboard?days=${d}`}
              style={{
                marginLeft: 8, fontWeight: 700, textDecoration: "none",
                color: d === days ? GOLD : INK_SOFT,
                borderBottom: d === days ? `2px solid ${GOLD}` : "none",
              }}
            >
              {d}d
            </a>
          ))}
        </span>
        <p style={{ margin: "12px 0 0", fontSize: 15.5, color: INK_SOFT }}>
          <strong style={{ color: sb.totals.passRate != null && sb.totals.passRate >= 0.8 ? TEAL : GOLD }}>
            {sb.totals.pass}/{sb.totals.proofs}
          </strong>{" "}
          proofs passing ({pct(sb.totals.passRate)})
          {"  ·  "}
          Marlowe&apos;s verdicts (LLM-judged):{" "}
          <strong style={{ color: TEAL }}>{sb.wrenReviews.ship} ship</strong> /{" "}
          <strong style={{ color: GOLD }}>{sb.wrenReviews.revise} revise</strong>
          {reviews ? ` (${Math.round((sb.wrenReviews.ship / reviews) * 100)}% first-pass)` : ""}
        </p>
      </header>

      {/* ---------------- per-agent table ---------------- */}
      <section style={{ background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, overflow: "hidden", marginBottom: 28 }}>
        <div style={{ padding: "14px 16px 0", fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase", color: INK_SOFT, fontWeight: 700 }}>
          Per agent — last {days} days
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
            <thead>
              <tr>
                <th style={th}>Agent</th>
                <th style={th}>Proof pass rate</th>
                <th style={th}>vs prior {days}d</th>
                <th style={th}>Score by kind</th>
                <th style={th}>Palette ΔE (mean / max)</th>
                <th style={th}>Jobs (done / failed)</th>
                <th style={th}>Avg job time</th>
              </tr>
            </thead>
            <tbody>
              {active.map((a) => (
                <tr key={a.slug}>
                  <td style={td}>
                    <a href={`/scoreboard/${a.slug}?days=${days}`} style={{ color: INK, fontWeight: 700, textDecoration: "none", borderBottom: `1px dotted ${INK_SOFT}` }} title="Open the proof log">{a.name}</a>
                  </td>
                  <td style={td}>
                    <PassBar rate={a.proofs.passRate} />
                    {a.proofs.total ? (
                      <span style={{ marginLeft: 8, color: INK_SOFT, fontSize: 12.5 }}>
                        {a.proofs.pass}/{a.proofs.total}
                      </span>
                    ) : null}
                  </td>
                  <td style={td}><Trend now={a.proofs.passRate} prev={a.prevPassRate} /></td>
                  <td style={td}>
                    {a.kinds.length ? a.kinds.map((k) => (
                      <span key={k.kind} style={{ display: "inline-block", marginRight: 10, whiteSpace: "nowrap" }}>
                        <span style={{ color: INK_SOFT, fontSize: 12 }}>{k.kind}</span>{" "}
                        {k.avgScore != null ? k.avgScore.toFixed(2) : "—"}
                        <span style={{ color: INK_SOFT, fontSize: 12 }}>×{k.n}</span>
                      </span>
                    )) : "—"}
                  </td>
                  <td style={td}>
                    {a.deltaE.n ? (
                      <>
                        {fx(a.deltaE.mean)} / <span style={{ color: (a.deltaE.max ?? 0) > 30 ? RED : INK }}>{fx(a.deltaE.max)}</span>
                        <span style={{ color: INK_SOFT, fontSize: 12.5 }}> ({a.deltaE.n})</span>
                      </>
                    ) : "—"}
                  </td>
                  <td style={td}>
                    {a.jobs.total ? (
                      <>
                        {a.jobs.done}/{a.jobs.total}
                        {a.jobs.error ? <strong style={{ color: RED }}> · {a.jobs.error} failed</strong> : null}
                      </>
                    ) : "—"}
                  </td>
                  <td style={td}>{a.jobs.avgSecs != null ? `${Math.round(a.jobs.avgSecs)}s` : "—"}</td>
                </tr>
              ))}
              {!active.length ? (
                <tr><td style={{ ...td, color: INK_SOFT }} colSpan={7}>No proof or job rows in this window yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {idle.length ? (
          <div style={{ padding: "10px 16px 14px", fontSize: 12.5, color: INK_SOFT }}>
            No measurable output this window: {idle.map((a) => a.name).join(", ")} (routers/critics log proofs on others&apos; rows).
          </div>
        ) : null}
      </section>

      {/* ---------------- per-soul-version table ---------------- */}
      <section style={{ background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, overflow: "hidden", marginBottom: 28 }}>
        <div style={{ padding: "14px 16px 0", fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase", color: INK_SOFT, fontWeight: 700 }}>
          By soul version — edit a soul, its hash gets its own row
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
            <thead>
              <tr>
                <th style={th}>Agent</th>
                <th style={th}>Soul</th>
                <th style={th}>Proofs</th>
                <th style={th}>Pass rate</th>
                <th style={th}>Avg score</th>
              </tr>
            </thead>
            <tbody>
              {sb.soulVersions.map((s) => (
                <tr key={`${s.slug}-${s.soulVersion}`}>
                  <td style={{ ...td, fontWeight: 700 }}>{s.name}</td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}>
                    {s.soulVersion === "inline" ? <span style={{ color: INK_SOFT }}>inline (pre-soul)</span> : `@${s.soulVersion}`}
                  </td>
                  <td style={td}>{s.n}</td>
                  <td style={td}><PassBar rate={s.passRate} /></td>
                  <td style={td}>{s.avgScore != null ? s.avgScore.toFixed(2) : "—"}</td>
                </tr>
              ))}
              {!sb.soulVersions.length ? (
                <tr><td style={{ ...td, color: INK_SOFT }} colSpan={5}>No soul-stamped proofs in this window yet — they start with the next job each agent runs.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------------- per-model table ---------------- */}
      <section style={{ background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "14px 16px 0", fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase", color: INK_SOFT, fontWeight: 700 }}>
          By model — who earns a bigger brain
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
            <thead>
              <tr>
                <th style={th}>Model</th>
                <th style={th}>Proofs</th>
                <th style={th}>Pass rate</th>
                <th style={th}>Avg score</th>
                <th style={th}>ΔE (mean)</th>
              </tr>
            </thead>
            <tbody>
              {sb.models.map((m) => (
                <tr key={m.model}>
                  <td style={{ ...td, fontWeight: 700 }}>{m.model}</td>
                  <td style={td}>{m.n}</td>
                  <td style={td}><PassBar rate={m.passRate} /></td>
                  <td style={td}>{m.avgScore != null ? m.avgScore.toFixed(2) : "—"}</td>
                  <td style={td}>{fx(m.avgDeltaE)}</td>
                </tr>
              ))}
              {!sb.models.length ? (
                <tr><td style={{ ...td, color: INK_SOFT }} colSpan={5}>No proofs recorded a producing model in this window.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 16px 14px", fontSize: 12.5, color: INK_SOFT }}>
          Ground truth from append-only proof rows — a soul or model change is an A/B against the prior window, not a vibe.
        </div>
      </section>
    </main>
  );
}
