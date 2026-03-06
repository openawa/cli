# Agent Workflow Notes

## Documentation Source Of Truth

- Treat `docs/cli-spec.md` as the canonical spec for behavior, security model, flags, defaults, and error semantics.
- Keep `README.md` concise and high-level; avoid duplicating large normative sections from the spec.
- Track execution state in `docs/work-tracker.md` using `Now`, `Next`, `Later`, and `Done`.

## Update Rules

- Any behavior change must update code and `docs/cli-spec.md` in the same commit.
- If product direction changes, update `docs/cli-spec.md` first, then implementation.
- Update `README.md` only for overview/onboarding/status changes.

## Commit Style

- Use Conventional Commits for commit titles (for example: `feat: ...`, `fix: ...`, `chore: ...`, `chore(deps): ...`).
- Do not add a `Co-Authored-By` trailer to commits.

## Iteration Hygiene

- At the end of each working session, update `docs/work-tracker.md` with remaining work and newly completed items.
- Keep checklist items short, concrete, and testable.
- When a durable repo-specific workflow rule, dependency policy, or repeated source of confusion becomes clear during work, update `AGENTS.md` in the same session so future runs inherit it.
- Keep `Done` in `docs/work-tracker.md` as a short rolling summary of recent high-signal completions, not a full historical log.
- Use git history as the source of truth for older completed work and trim stale `Done` entries once they stop helping the next session.

## Tooling Workflow

- Use `pnpm run format` for repository formatting and `pnpm run lint` for linting; do not add Prettier or ESLint back unless the repo intentionally returns to a mixed-tooling setup.
- Run `pnpm run check` before wrapping up changes that touch TypeScript, scripts, docs, or CI.
- Husky and lint-staged own the pre-commit workflow; keep pre-commit scoped to staged-file formatting/linting and leave full-repo validation to `pnpm run check` and CI.
