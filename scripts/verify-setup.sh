#!/usr/bin/env bash
# Verify local dev environment is correctly configured.
# Run: bash scripts/verify-setup.sh

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

echo "Verifying restaurant-platform local setup..."
echo ""

# Node version
NODE_VERSION=$(node -v 2>/dev/null || echo "missing")
if [[ "$NODE_VERSION" =~ ^v22\. ]]; then
  ok "Node $NODE_VERSION"
else
  fail "Node 22 required (found: $NODE_VERSION). Run: nvm use"
fi

# pnpm
if command -v pnpm &>/dev/null; then
  ok "pnpm $(pnpm -v)"
else
  fail "pnpm not installed. Run: npm install -g pnpm"
fi

# Doppler CLI
if command -v doppler &>/dev/null; then
  ok "doppler $(doppler --version)"
else
  fail "Doppler CLI not installed. macOS: brew install dopplerhq/cli/doppler"
fi

# Doppler login state
if doppler me &>/dev/null; then
  ok "Doppler authenticated as $(doppler me --json | jq -r '.workplace.name' 2>/dev/null || echo 'user')"
else
  fail "Doppler not logged in. Run: doppler login"
fi

# Doppler project linked
if [ -f .doppler.yaml ] || doppler configure get project &>/dev/null; then
  PROJECT=$(doppler configure get project --plain 2>/dev/null || echo "?")
  CONFIG=$(doppler configure get config --plain 2>/dev/null || echo "?")
  ok "Doppler linked: project=$PROJECT config=$CONFIG"
  
  if [ "$CONFIG" != "dev" ]; then
    warn "Current Doppler config is '$CONFIG' (not 'dev'). For local work: doppler setup --config dev"
  fi
else
  fail "Doppler project not linked. Run: doppler setup"
fi

# Check core env vars are reachable
echo ""
echo "Checking env vars via Doppler..."
REQUIRED_VARS=("DATABASE_URL" "BETTER_AUTH_SECRET" "NEXT_PUBLIC_PLATFORM_URL")
for var in "${REQUIRED_VARS[@]}"; do
  VALUE=$(doppler secrets get "$var" --plain 2>/dev/null || echo "")
  if [ -n "$VALUE" ]; then
    ok "$var is set"
  else
    fail "$var is missing in Doppler $CONFIG config"
  fi
done

# Node modules
if [ -d node_modules ]; then
  ok "node_modules exists (pnpm install completed)"
else
  warn "node_modules missing. Run: pnpm install"
fi

echo ""
echo -e "${GREEN}All checks passed.${NC} Start dev with: doppler run -- pnpm dev"
