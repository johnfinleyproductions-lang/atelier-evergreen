#!/usr/bin/env bash
# Deploy the current local Atelier to M90t (the always-on host).
# Usage: bash scripts/deploy-m90t.sh   (run from the repo root on the Mac)
set -euo pipefail
echo "→ syncing to M90t…"
rsync -az --exclude node_modules --exclude .next --exclude 'public/uploads/atelier-qa' ./ think:atelier-evergreen/
echo "→ building on M90t…"
ssh think 'bash -lc "export PATH=\$HOME/.local/node/current/bin:\$PATH; cd ~/atelier-evergreen && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build 2>&1 | tail -3"'
echo "→ restarting the service…"
ssh think 'bash -lc "export XDG_RUNTIME_DIR=/run/user/\$(id -u); systemctl --user restart atelier.service && sleep 4 && systemctl --user is-active atelier.service"'
echo "✓ deployed → http://192.168.4.200:3040"
