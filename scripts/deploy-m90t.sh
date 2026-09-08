#!/usr/bin/env bash
# Deploy the current local Atelier to M90t (the always-on host).
# Usage: bash scripts/deploy-m90t.sh   (run from the repo root on the Mac)
#
# Hardened (Tier 3): remote steps run under their own pipefail (the local one
# does not cross ssh), a failed build ABORTS before the restart instead of
# exiting 0 through `| tail`, migrations are applied every deploy (idempotent),
# and health is a real HTTP probe — `systemctl is-active` is true the instant
# `next start` execs, even when every route 500s.
set -euo pipefail

# Preflight: the rsync below ships (and with --delete, can remove) .env.local —
# the Mac copy is the source of truth for env. Deploying without a usable local
# copy would wipe the server's secret and 503 the whole app (fail-closed gate).
if [[ ! -f .env.local ]]; then
  echo "ABORT: no .env.local in $(pwd) — deploying would delete the server's env (rsync --delete)." >&2
  exit 1
fi
if ! grep -qE '^ATELIER_API_SECRET=.+' .env.local && ! grep -qE '^ATELIER_AUTH_DISABLED=1' .env.local; then
  echo "ABORT: .env.local has no ATELIER_API_SECRET (and no explicit ATELIER_AUTH_DISABLED=1) — deploying would ship a secretless env and 503 every route." >&2
  exit 1
fi

echo "→ syncing to M90t…"
# --delete keeps the server tree in lockstep (removed routes actually go away);
# excluded dirs (node_modules/.next/QA screenshots) are left untouched, and
# .env.local ships FROM the Mac — the Mac copy is the source of truth for env,
# including ATELIER_API_SECRET.
rsync -az --delete --exclude node_modules --exclude .next --exclude 'public/uploads/atelier-qa' ./ think:atelier-evergreen/

echo "→ building on M90t…"
ssh think 'bash -lc "set -euo pipefail; export PATH=\$HOME/.local/node/current/bin:\$PATH; cd ~/atelier-evergreen; npm install --no-audit --no-fund >/dev/null; if ! npm run build >/tmp/atelier-build.log 2>&1; then echo \"BUILD FAILED — service NOT restarted:\"; tail -30 /tmp/atelier-build.log; exit 1; fi; tail -3 /tmp/atelier-build.log"'

echo "→ applying migrations (idempotent, all drizzle/*.sql)…"
ssh think 'bash -lc "set -euo pipefail; export PATH=\$HOME/.local/node/current/bin:\$PATH; cd ~/atelier-evergreen; for f in drizzle/*.sql; do node scripts/apply-migration.mjs \"\$(basename \"\$f\")\" >/dev/null || { echo \"MIGRATION FAILED: \$f — service NOT restarted\"; exit 1; }; done; echo \"  applied all migration files\""'

echo "→ restarting the service…"
ssh think 'bash -lc "export XDG_RUNTIME_DIR=/run/user/\$(id -u); systemctl --user restart atelier.service"'

echo "→ probing health (real HTTP, not is-active)…"
ssh think 'bash -lc "set -euo pipefail; sleep 3; if curl -fsS --retry 6 --retry-delay 2 --retry-connrefused http://127.0.0.1:3040/api/health | grep -q \"\\\"ok\\\":true\"; then echo \"  health: ok\"; else echo \"HEALTH PROBE FAILED — recent log:\"; export XDG_RUNTIME_DIR=/run/user/\$(id -u); journalctl --user -u atelier.service -n 30 --no-pager; exit 1; fi"'

echo "✓ deployed → http://192.168.4.200:3040"
