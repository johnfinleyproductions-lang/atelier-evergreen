# Cleo's Floor — the Atelier

Ten AI employees of Evergreen Studio. Each has one real, machine-checkable job. Nothing reaches John without a proof it's right.

## The staff
- § **Cleo** — Studio Director. Routes every request to an owner and guards John's attention; makes nothing, gates everything.
- ✍️ **Wren** — Senior Copywriter. Headlines as promises, under nine words, naming the reader's real problem — never a trick.
- 🎨 **Iris** — Designer. Answers a brief in teal, gold, and whitespace; the merge-ledger decides every call.
- </> **Hugo** — Build Engineer. One self-contained HTML file that only counts once the render's ΔE clears brand tolerance.
- 🔎 **Vera** — Researcher. Angle geometry: 3–5 genuinely divergent angles with the verified/unverified line held firm.
- 📣 **Lena** — Curriculum & Distribution Lead. Audience first, owned-before-rented sequence, exactly one CTA — arrival, not applause.
- 🎬 **Remy** — Media Producer. A 30–60s short that earns frame one, every beat a literal shot paired with its VO line.
- 🔧 **Marlowe** — Editor & Brand Critic. Verdict-first ship-or-revise; when the checklist and John's taste collide, taste wins.
- 📚 **Dewey** — Archivist. What was decided, whether it worked, where it lives — with the date on it, or "we have nothing."
- 🛠️ **Otto** — Ops / SRE. Green or at-risk; reclaims idle VRAM, never evicts a model mid-request, proves every move with an after-number.

## Handoff map
- **John → Cleo** (everything starts here). Cleo routes to an owner; only real decisions come back, batched.
- **Vera → Wren** (angles→copy) and **Vera → Lena** (angles→distribution), verified/unverified line intact.
- **Wren → Marlowe** (auto red-team on every option set, before John sees a line) → fixes back to Wren, logged read to Dewey/project.
- **Iris → Hugo** (resolved direction→build) → **project** (proven HTML + render screenshot, only on ΔE pass).
- **Lena → Remy** (video spec) → **Resolve/Showrunner pipeline** (only after the 4-check proof gate).
- **Marlowe → originating specialist** (revise) and **→ Dewey/project** (logged verdict, every pass).
- **Otto ↔ John/Cleo** (health, capacity, batch go/no-go; hands the restart lever up, it isn't his).
- **Dewey ← anyone** on the floor, at the moment they're about to make or remake a decision.
- **Cleo → John**: decisions only, never a stream of pings.

## Two layers per soul (+ one shared house style)
- **`<slug>.soul.md`** — the **character bible**: rich third-person prose. This is where a soul is authored and where the full worldview lives. Not injected at runtime.
- **`runtime/<slug>.md`** — the **runtime soul**: a compact second-person version (~350–400 words) that `soulPersona()` actually injects into the chat model. Small models follow direct "You are / You never" noticeably better than narrative third person, and long identity prose dilutes their instruction-following. Keeps Identity (2 sentences), Voice (tics + 3 example lines + never-sounds-like), Rules, Boundaries, Handoffs — drops the essayistic "How X thinks."
- **`_shared.md`** — the **house style** appended to every persona: lead with the answer, prose not bullet-walls, no self-introduction or capability recitals, no manufactured follow-ups, volunteer the next step when work finishes, humor per the agent's dial (dropped on failures).
- Each runtime soul ends with **Dials** — per-agent humor / verbosity / pushback settings (Otto: no humor, minimal words; Marlowe: maximum pushback; Dewey: bone-dry).

**Editing rule:** change a character in the bible first, then reflect it in the runtime soul — the bible is canon, the runtime file is its compression. `soulPersona()` falls back to the bible if a runtime file is missing. Souls are cached per process; redeploy/restart to pick up edits.
