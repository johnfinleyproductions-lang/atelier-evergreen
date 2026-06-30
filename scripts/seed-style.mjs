// scripts/seed-style.mjs
//
// Atelier — Style Library seed (the brand rubric + one demo style card).
//
// Standalone Node ESM script (run: `node scripts/seed-style.mjs`). Like
// scripts/seed.mjs, it talks to the shared Evergreen Postgres directly via the
// `postgres` driver — no Next.js runtime, no drizzle — and reads DATABASE_URL
// from .env.local. Everything is workspace-scoped to ATELIER_WS.
//
// IDEMPOTENT: deterministic UUIDs + ON CONFLICT (id) DO UPDATE, so re-runs are
// safe. It seeds the two rows the Style Library needs to be useful on first boot:
//
//   1) the DEFAULT brand_rubric "Evergreen" — the house tokens (teal/gold/page/
//      ink) and the brand-lock rules the merge ledger enforces. Before marking
//      Evergreen as default we clear is_default on every other rubric in the
//      workspace, so there is exactly one default.
//   2) one demo style_card @warm-editorial — a sensible merged_profile (layout,
//      typography, spacing, mood) plus a few REAL-looking palette swatches and
//      do/dont rules, so the @mention picker has something to show.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as postgresModule from "postgres";

// --- tiny .env.local loader (only fills values that aren't already set) -------
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// `postgres` ships as both ESM + CJS; normalize the callable factory.
const createPostgres = (
  "default" in postgresModule ? postgresModule.default : postgresModule
);

// --- the workspace constant (the spine's tenancy key) ------------------------
const ATELIER_WS = "00000000-0000-0000-0000-000000000a11";

// --- deterministic ids (idempotency + cross-row references) ------------------
const ID = {
  rubric: {
    evergreen: "00000000-0000-0000-0000-0000000b0001", // brand rubric "Evergreen"
  },
  card: {
    warmEditorial: "00000000-0000-0000-0000-0000000c0001", // @warm-editorial
  },
};

// --- the house brand rubric --------------------------------------------------
// tokens shape: { colors:{teal,gold,page,ink}, type, spacing, rules[] }
const EVERGREEN_TOKENS = {
  colors: {
    teal: "#0d9488",
    gold: "#c79320",
    page: "#f5f3ec",
    ink: "#15201c",
  },
  type: {
    heading: "serif display, tight tracking, generous size",
    body: "humanist sans, 1.6 line-height, ~68ch measure",
    scale: "1.25 (major third)",
  },
  spacing: {
    base: 8,
    rhythm: "8px baseline grid",
    sectionGap: 64,
  },
  rules: [
    "gold = CTA only, never fill",
    "one accent max",
    "teal is the primary brand color; gold accents sparingly",
    "page is warm off-white; ink is the near-black text color",
    "respect AA contrast on all text",
  ],
};

// --- the demo style card @warm-editorial -------------------------------------
// merged_profile is the resolved look this card injects (the style-owned half:
// layout / type-rhythm / spacing / mood / motifs). Brand-locked tokens (colors,
// a11y) come from the rubric at resolve time — this is just the editorial feel.
const WARM_EDITORIAL_MERGED_PROFILE = {
  layout: {
    structure: "single-column editorial with wide margins",
    grid: "12-col, 8px gutter, centered ~720px measure",
    rhythm: "asymmetric — large hero, then calm stacked sections",
    density: "airy",
  },
  typography: {
    headingFamily: "serif display",
    bodyFamily: "humanist sans",
    scale: "1.25 (major third)",
    feel: "literary, magazine-like, confident",
  },
  spacing: {
    base: 8,
    sectionGap: 72,
    paragraphGap: 20,
    feel: "generous whitespace, unhurried",
  },
  mood: ["warm", "editorial", "calm", "premium", "human"],
  motifs: ["thin rule lines", "drop caps", "pull quotes", "wide photo bleeds"],
  // a few REAL-looking palette swatches (hex + weight, sorted by weight desc) —
  // the same {hex,weight}[] shape lib/palette.ts produces from real pixels.
  palette: [
    { hex: "#f5f3ec", weight: 0.46 },
    { hex: "#15201c", weight: 0.21 },
    { hex: "#0d9488", weight: 0.14 },
    { hex: "#c79320", weight: 0.09 },
    { hex: "#d8d2c2", weight: 0.06 },
    { hex: "#8a9a92", weight: 0.04 },
  ],
};

const WARM_EDITORIAL_DO_RULES = [
  "Lead with a large serif headline over generous whitespace",
  "Keep the body measure narrow (~68ch) for readability",
  "Use thin rule lines and pull quotes to break long sections",
  "Let one strong photo bleed wide; keep the rest calm",
];

const WARM_EDITORIAL_DONT_RULES = [
  "Don't crowd the layout — airy beats dense",
  "Don't introduce a second accent color (one accent max)",
  "Don't fill blocks with gold — gold is for CTAs only",
  "Don't mix more than two type families",
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Atelier seeds the shared Evergreen Postgres.",
    );
  }

  const sql = createPostgres(connectionString, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    console.log(`[seed-style] workspace ${ATELIER_WS}`);

    // 1) Brand rubric "Evergreen" (the default) ------------------------------
    // Guarantee a single default: clear is_default on every other rubric first.
    await sql`
      update atelier_brand_rubric
         set is_default = ${false}
       where workspace_id = ${ATELIER_WS}
         and id <> ${ID.rubric.evergreen}
    `;

    await sql`
      insert into atelier_brand_rubric
        (id, workspace_id, name, tokens, is_default)
      values
        (${ID.rubric.evergreen}, ${ATELIER_WS}, ${"Evergreen"},
         ${sql.json(EVERGREEN_TOKENS)}, ${true})
      on conflict (id) do update set
        name       = excluded.name,
        tokens     = excluded.tokens,
        is_default = excluded.is_default
    `;
    console.log(`[seed-style] brand_rubric: Evergreen (default)`);

    // 2) Demo style card @warm-editorial -------------------------------------
    await sql`
      insert into atelier_style_card
        (id, workspace_id, handle, name, merged_profile, hero_reference_ids,
         do_rules, dont_rules, brand_locked, usage_count, status)
      values
        (${ID.card.warmEditorial}, ${ATELIER_WS}, ${"warm-editorial"},
         ${"Warm Editorial"},
         ${sql.json(WARM_EDITORIAL_MERGED_PROFILE)},
         ${sql.json([])},
         ${sql.json(WARM_EDITORIAL_DO_RULES)},
         ${sql.json(WARM_EDITORIAL_DONT_RULES)},
         ${true}, ${0}, ${"ready"})
      on conflict (id) do update set
        handle             = excluded.handle,
        name               = excluded.name,
        merged_profile     = excluded.merged_profile,
        hero_reference_ids = excluded.hero_reference_ids,
        do_rules           = excluded.do_rules,
        dont_rules         = excluded.dont_rules,
        brand_locked       = excluded.brand_locked,
        status             = excluded.status
    `;
    console.log(`[seed-style] style_card: @warm-editorial (ready)`);

    console.log(
      "[seed-style] done. Style Library has the Evergreen rubric + @warm-editorial card.",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
