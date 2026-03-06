# Repo Layout (single package)

```
openawa/
  README.md
  package.json
  tsconfig.json
  tsup.config.ts
  docs/
    cli-spec.md
    repo-layout.md
  src/
    openawa.ts
    porto-wallet.ts
    cli.ts
    lib/
    porto/
    signer/
  test/
    e2e/
  skills/
    porto-wallet/
      SKILL.md
```

## docs

Specs and decisions.

## src

TypeScript CLI implementation for signer + Porto adapter.

## test/e2e

Live-network oriented CLI-level tests (guarded by env flag).

## skills/porto-wallet

ClawHub skill folder (publish this directory).
