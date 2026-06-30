import Link from "next/link";
import { listStyleCards, getDefaultBrandRubric } from "@/lib/style-repo";

export const dynamic = "force-dynamic";

// Row shapes are derived straight from the repository return types so this
// view stays in lockstep with lib/style-repo.ts (one data model -> library).
// The jsonb payloads (merged_profile, tokens) are read defensively below, so
// this page never assumes more about their shape than the spec guarantees.
type StyleCard = Awaited<ReturnType<typeof listStyleCards>>[number];
type BrandRubric = NonNullable<Awaited<ReturnType<typeof getDefaultBrandRubric>>>;

type Swatch = { hex: string; weight: number };

/* ---------------------------------------------------------------
   defensive jsonb readers
   The repo maps columns to its own keys; we tolerate either camel or
   snake casing and treat every jsonb blob as untyped until proven.
   --------------------------------------------------------------- */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick<T = unknown>(
  obj: unknown,
  camel: string,
  snake: string,
): T | undefined {
  const rec = asRecord(obj);
  const v = rec[camel] !== undefined ? rec[camel] : rec[snake];
  return v as T | undefined;
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^#?[0-9a-fA-F]{3,8}$/.test(value.trim());
}

function normHex(value: string): string {
  const v = value.trim();
  return v.startsWith("#") ? v : `#${v}`;
}

function paletteOf(card: StyleCard): Swatch[] {
  const merged = pick(card, "mergedProfile", "merged_profile");
  const raw = asRecord(merged).palette;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => asRecord(entry))
    .filter((entry) => isHex(entry.hex))
    .map((entry) => ({
      hex: normHex(String(entry.hex)),
      weight: typeof entry.weight === "number" ? entry.weight : 0,
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6);
}

function rulesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((r) => String(r)).filter(Boolean) : [];
}

/* ============================ page ============================ */

export const metadata = { title: "Style Library — Atelier" };

export default async function StyleLibraryPage() {
  const [cards, rubric] = await Promise.all([
    listStyleCards(),
    getDefaultBrandRubric(),
  ]);

  const totalUsage = cards.reduce(
    (sum, card) =>
      sum + (Number(pick<number>(card, "usageCount", "usage_count")) || 0),
    0,
  );

  return (
    <main className="app">
      {/* ---------------- header brief ---------------- */}
      <header className="brief">
        <div className="brief__lede">
          <div className="brief__eyebrow">Atelier — Style Library</div>
          <h1 className="brief__title">Style Library</h1>
          <p className="brief__sub">
            Reusable @-style cards distilled from references. Mention a card by
            its handle to dress any task; the brand rubric still wins colors,
            logo, accessibility, and components.
          </p>
        </div>
        <div className="brief__stats">
          <div className="stat">
            <span className="stat__num nums">{cards.length}</span>
            <span className="stat__label">Cards</span>
          </div>
          <div className="stat">
            <span className="stat__num nums">{totalUsage}</span>
            <span className="stat__label">Injections</span>
          </div>
        </div>
      </header>

      {/* ---------------- default brand rubric ---------------- */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "var(--gold)",
                display: "inline-block",
              }}
            />
            Brand rubric — the lock
          </h2>
          <span className="section__rule" />
        </div>
        <BrandRubricPanel rubric={rubric} />
      </section>

      {/* ---------------- @-cards grid ---------------- */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "var(--teal)",
                display: "inline-block",
              }}
            />
            Style cards
          </h2>
          <span className="section__rule" />
          <span className="section__count nums">{cards.length}</span>
        </div>

        {cards.length === 0 ? (
          <div className="empty">
            No style cards yet. Add a reference to mint the first one.
          </div>
        ) : (
          <div className="grid grid--employees">
            {cards.map((card) => (
              <StyleCardTile
                key={String(
                  pick(card, "id", "id") ?? pick(card, "handle", "handle"),
                )}
                card={card}
              />
            ))}
          </div>
        )}
      </section>

      {/* ---------------- how to add references ---------------- */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "var(--ink-2)",
                display: "inline-block",
              }}
            />
            Add a reference
          </h2>
          <span className="section__rule" />
        </div>
        <AddReferenceNote />
      </section>
    </main>
  );
}

/* ============================ pieces ============================ */

function StyleCardTile({ card }: { card: StyleCard }) {
  const handle = String(pick(card, "handle", "handle") ?? "");
  const name = String(pick(card, "name", "name") ?? handle);
  const status = String(pick(card, "status", "status") ?? "ready");
  const usage = Number(pick<number>(card, "usageCount", "usage_count")) || 0;
  const brandLocked = pick(card, "brandLocked", "brand_locked") !== false; // default true
  const palette = paletteOf(card);
  const dos = rulesOf(pick(card, "doRules", "do_rules"));
  const donts = rulesOf(pick(card, "dontRules", "dont_rules"));

  return (
    <article className="surface surface--pad surface--interactive employee">
      <div className="spread">
        <div className="employee__id">
          <span
            className="employee__name mono"
            style={{ color: "var(--teal-deep)" }}
          >
            @{handle}
          </span>
          <span className="employee__role">{name}</span>
        </div>
        <span
          className={`chip ${status === "ready" ? "chip--active" : "chip--waiting"}`}
        >
          {status}
        </span>
      </div>

      {/* palette swatches — REAL extracted pixels */}
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Palette
        </div>
        {palette.length === 0 ? (
          <span className="faint" style={{ fontSize: "0.8rem" }}>
            no palette yet
          </span>
        ) : (
          <div
            style={{
              display: "flex",
              gap: 0,
              borderRadius: "var(--r-sm)",
              overflow: "hidden",
              border: "1px solid var(--line)",
            }}
          >
            {palette.map((swatch, i) => (
              <span
                key={`${swatch.hex}-${i}`}
                title={`${swatch.hex} · ${Math.round(swatch.weight * 100)}%`}
                style={{
                  flex: swatch.weight > 0 ? swatch.weight : 1,
                  minWidth: 14,
                  height: 30,
                  background: swatch.hex,
                  display: "block",
                }}
              />
            ))}
          </div>
        )}
      </div>

      {(dos.length > 0 || donts.length > 0) && (
        <div className="col" style={{ gap: 4 }}>
          {dos.slice(0, 2).map((rule, i) => (
            <span
              key={`do-${i}`}
              style={{ fontSize: "0.78rem", color: "var(--ink-2)" }}
            >
              <span style={{ color: "var(--ok)", fontWeight: 700 }}>do</span>{" "}
              {rule}
            </span>
          ))}
          {donts.slice(0, 2).map((rule, i) => (
            <span
              key={`dont-${i}`}
              style={{ fontSize: "0.78rem", color: "var(--ink-2)" }}
            >
              <span style={{ color: "var(--fail)", fontWeight: 700 }}>
                don&rsquo;t
              </span>{" "}
              {rule}
            </span>
          ))}
        </div>
      )}

      <div className="employee__foot">
        <span className="row" style={{ gap: 6 }}>
          {brandLocked ? (
            <span
              className="chip"
              style={{
                color: "var(--gold-deep)",
                background: "var(--gold-tint)",
                borderColor: "rgba(199,147,32,0.32)",
              }}
            >
              brand-locked
            </span>
          ) : (
            <span className="chip chip--plain faint">unlocked</span>
          )}
        </span>
        <span className="nums">
          used <strong>{usage}</strong>×
        </span>
      </div>
    </article>
  );
}

function BrandRubricPanel({
  rubric,
}: {
  rubric: BrandRubric | null | undefined;
}) {
  if (!rubric) {
    return (
      <div className="empty">
        No default brand rubric set. Seed one so style cards have a lock to defer
        to.
      </div>
    );
  }

  const name = String(pick(rubric, "name", "name") ?? "Brand rubric");
  const tokens = pick(rubric, "tokens", "tokens");
  const colors = asRecord(asRecord(tokens).colors);
  const type = asRecord(tokens).type;
  const spacing = asRecord(tokens).spacing;
  const rules = rulesOf(asRecord(tokens).rules);

  const colorEntries: { label: string; hex: string }[] = (
    ["teal", "gold", "page", "ink"] as const
  )
    .map((key) => ({ label: key as string, value: colors[key] }))
    .filter((e) => isHex(e.value))
    .map((e) => ({ label: e.label, hex: normHex(String(e.value)) }));

  return (
    <div
      className="surface surface--pad surface--raised"
      style={{ borderLeft: "3px solid var(--gold)" }}
    >
      <div className="spread" style={{ marginBottom: 14 }}>
        <div className="col" style={{ gap: 2 }}>
          <strong style={{ fontSize: "1.02rem" }}>{name}</strong>
          <span className="muted" style={{ fontSize: "0.84rem" }}>
            Wins colors · logo · accessibility · components on every merge.
          </span>
        </div>
        <span className="chip chip--passing">default</span>
      </div>

      {colorEntries.length > 0 && (
        <div
          className="row row--wrap"
          style={{ gap: 14, marginBottom: rules.length ? 16 : 0 }}
        >
          {colorEntries.map((c) => (
            <div key={c.label} className="row" style={{ gap: 8 }}>
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "var(--r-sm)",
                  background: c.hex,
                  border: "1px solid var(--line-2)",
                  display: "inline-block",
                }}
              />
              <span className="col" style={{ gap: 0 }}>
                <span
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 650,
                    textTransform: "capitalize",
                  }}
                >
                  {c.label}
                </span>
                <span className="mono faint" style={{ fontSize: "0.72rem" }}>
                  {c.hex}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {(typeof type === "string" || typeof spacing === "string") && (
        <p
          className="muted"
          style={{ fontSize: "0.84rem", marginBottom: rules.length ? 14 : 0 }}
        >
          {typeof type === "string" ? (
            <>
              Type: <strong>{type}</strong>.{" "}
            </>
          ) : null}
          {typeof spacing === "string" ? (
            <>
              Spacing: <strong>{spacing}</strong>.
            </>
          ) : null}
        </p>
      )}

      {rules.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
          {rules.map((rule, i) => (
            <li
              key={i}
              style={{ fontSize: "0.84rem", color: "var(--ink-2)" }}
            >
              {rule}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddReferenceNote() {
  return (
    <div className="surface surface--pad surface--quiet">
      <p style={{ marginBottom: 10 }}>
        References mint a style card. <code>POST /api/style/profile</code> with a
        JSON body:
      </p>
      <pre
        className="mono"
        style={{
          margin: "0 0 12px",
          padding: "12px 14px",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-sm)",
          fontSize: "0.8rem",
          overflowX: "auto",
          color: "var(--ink-2)",
        }}
      >
        {`{
  "handle": "editorial-warm",
  "imageUrl": "https://…/screenshot.png"
}`}
      </pre>
      <p className="muted" style={{ fontSize: "0.84rem" }}>
        The palette is read from <strong>real pixels</strong> (k=6, sorted by
        weight). The layout / typography / spacing / mood profile comes from
        qwen2.5-VL when a vision endpoint is configured, otherwise it lands as a
        clearly-marked heuristic stub — never a guess dressed up as data.
      </p>
      <p style={{ marginTop: 12 }}>
        <Link href="/" style={{ fontSize: "0.84rem", fontWeight: 600 }}>
          ← Cleo&rsquo;s Floor
        </Link>
      </p>
    </div>
  );
}
