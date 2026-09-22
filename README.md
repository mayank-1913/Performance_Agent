# Performance Agent — AI-Powered Performance Testing Platform

Phase 1 MVP foundation. Frontend (React + Vite + Tailwind) and Backend (Node + Express) only.

## Prerequisites

- Node.js >= 18.17
- npm >= 9

## Install

From the repo root:

```bash
npm install
```

## Run (dev)

Starts both API (port 4000) and web (port 5173) in parallel:

```bash
npm run dev
```

Or run individually:

```bash
npm run dev:api
npm run dev:web
```

- API:  http://localhost:4000
- Web:  http://localhost:5173
- Health: http://localhost:4000/api/v1/health

## Project Layout

```
apps/
  api/        Express backend (file upload, health, logger, error handling)
  web/        React + Vite + Tailwind frontend (upload page, dashboard layout)
```
