#!/usr/bin/env bash
# Deploy origin/main to this host. Run on the VM (directly, or via: ssh vm 'bash -s' < deploy/deploy.sh).
# Requires: git, docker with compose v2, and a .env in the checkout (never committed).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mayank-1913/Performance_Agent.git}"
APP_DIR="${APP_DIR:-$HOME/performance-agent}"
BRANCH="main"

if [ ! -d "$APP_DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "error: $APP_DIR/.env missing. Copy .env.example to .env and set secrets." >&2
  exit 1
fi

# Checkout is deploy-only: discard any local edits so the running code == origin/main.
git fetch --prune origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"
echo "deploying $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"

docker compose up -d --build --remove-orphans
docker compose ps
