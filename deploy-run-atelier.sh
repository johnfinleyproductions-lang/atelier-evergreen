#!/bin/bash
cd "$HOME/atelier-evergreen"
export PATH="$HOME/.local/node/current/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"
exec ./node_modules/.bin/next start -p 3040 -H 0.0.0.0
