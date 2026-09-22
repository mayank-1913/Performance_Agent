# Baseline fixtures (Phase 0)

Read-only golden copies captured before any Phase 1+ enhancements begin.
Use these as regression references — future changes to K6 generation and
report rendering should be compared byte-for-byte or shape-for-shape against
the corresponding file here.

Captured on 2026-09-15 against the current `main` at Phase 0 baseline. See
`docs/performance-agent-baseline.md` for the corresponding architecture,
test, and build documentation.

## Contents

### `scripts/`
- `good-single-request.js`
  A representative generated K6 script that parses cleanly under Node ESM
  and passes `k6 archive`. Use as the "known-good shape" reference for
  generator output.
- `buggy-apostrophe-label.js`
  A generated script that fails `node --check` because a request label
  contains a single quote (`User's Carts`) and the generator emits it into
  a single-quoted `console.warn` without escaping. Kept as a regression
  fixture for the documented bug in
  `docs/performance-agent-baseline.md` (known limitation #1). Do NOT fix
  this file — future generator fixes must reproduce, then eliminate, this
  failure mode.

### `reports/`
- `sample-report.html`         self-contained HTML report (post K6 run).
- `sample-parsed-summary.json` output of `parseRunArtifacts()`.
- `sample-k6-summary.json`     raw K6 `--summary-export` payload.

## Rules

- These files are byte-identical copies of production artifacts at Phase 0.
- Do NOT edit or regenerate any file in this directory as part of routine
  work; regenerate only when the baseline itself is intentionally
  advanced, and note the reason in the baseline doc.
