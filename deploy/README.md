# Deploying Performance Agent to the shared VM

The VM at `ubuntu@65.0.168.138` already runs a shared `deploy-gateway` nginx
container that terminates TLS for `qa.mtraction.com` and reverse-proxies every
tool by path:

- `https://qa.mtraction.com/perf-agent/` → `pa-web:80` (served by this repo)
- `https://qa.mtraction.com/perf-agent/api/` → `pa-api:4000` (served by this repo)

The gateway is **shared infrastructure** — do not touch it. It was configured
once with this app's prefix hardcoded (`/perf-agent/`).

## First-time VM setup

Done already. For reference:

```bash
# On the VM
cd ~
git clone https://github.com/mayank-1913/Performance_Agent.git performance-agent
cd performance-agent
cp .env.example .env
# Edit .env: set JWT_SECRET, ADMIN_PASSWORD, PUBLIC_ORIGIN=https://qa.mtraction.com
# (never commit .env)
bash deploy/deploy.sh
```

## Routine deploy (after pushing a change to `main`)

```bash
ssh ubuntu@65.0.168.138 'cd ~/performance-agent && bash deploy/deploy.sh'
```

What `deploy.sh` does:

1. `git fetch origin main` + `git reset --hard origin/main` — the VM checkout
   is deploy-only; local edits on the VM are discarded intentionally.
2. `docker compose up -d --build --remove-orphans` — rebuilds `pa-api` and
   `pa-web` images, swaps running containers, preserves the `api-storage` and
   `api-logs` volumes (SQLite DB and run artifacts are not touched).
3. `docker compose ps` — prints container status.

No manual gateway reload is needed: the gateway nginx resolves `pa-web`'s IP
on every request (see its own `nginx.conf`).

## Data safety

- `api-storage` volume: SQLite DB, uploaded collections/environments, generated
  scripts, run artifacts, reports. **Not** recreated by `docker compose up`.
- `api-logs` volume: combined/error log files. **Not** recreated.

## Image size / build time

First build pulls `grafana/k6:latest` and `node:20-bookworm-slim` (~400 MB).
Subsequent `--build` runs reuse those layers and typically rebuild only the
app code layer (~10–30 s depending on dependency changes).

## Rolling back

```bash
ssh ubuntu@65.0.168.138 'cd ~/performance-agent && git log --oneline -5'
ssh ubuntu@65.0.168.138 'cd ~/performance-agent && git reset --hard <sha> && docker compose up -d --build'
```

## Troubleshooting

- `pa-api` is healthy but UI 404s under `/perf-agent/`: `VITE_BASE_PATH` was
  not baked in at build time. Rebuild with `docker compose up -d --build web`.
- `pa-web` cannot reach `pa-api`: the two containers must share the default
  compose network (they do, via service names) — check `docker compose ps`.
- Gateway can't reach `pa-web`: `pa-web` must be on the external `gateway`
  docker network (it is, via `networks.gateway` in `docker-compose.yml`).
