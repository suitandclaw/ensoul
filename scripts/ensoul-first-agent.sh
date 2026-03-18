#!/usr/bin/env bash
# Run the first-agent demo from the integration package context
# Usage: ./scripts/ensoul-first-agent.sh
cd "$(dirname "$0")/.." || exit 1
exec pnpm --filter @ensoul/integration exec npx tsx scripts/ensoul-first-agent.ts "$@"
