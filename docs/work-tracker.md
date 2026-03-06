# Work Tracker

## Snapshot (2026-02-20)
- Branch: `main`
- Active command surface: `configure`, `sign`, `status`
- Canonical spec: `/Users/jean/src/github.com/jeanregisser/agent-wallet/docs/cli-spec.md`
- Workflow policy: `/Users/jean/src/github.com/jeanregisser/agent-wallet/AGENTS.md`

Latest validation on this machine (2026-03-06):
- `pnpm install` -> pass
- `pnpm run typecheck` -> pass
- `pnpm run build` -> pass
- `pnpm run test` -> pass (`23 passed / 0 failed`)
- `pnpm run test:e2e` -> pass (`1 passed / 0 failed`, ~26s)

## Key Insights (Precall Model)
- Configure can be frictionless and still safe by using Porto precalls first (`wallet_grantPermissions`) and deferring activation to first real send.
- Relay key reads (`wallet_getKeys`) are reliable for active onchain permissions, but they do not represent all pending precall intent.
- Human UX needs explicit state, so configure now reports one of:
  - `active_onchain`
  - `pending_activation`
- Idempotency with precalls requires local pending-state memory to avoid re-queuing the same permission envelope on rerun.
- If intent changes before activation, queueing a newer precall is acceptable, but configure must state that activation is still pending.

## Key Insights (Multichain Permission Model)
- Porto `wallet_connect` response permissions each have `chainId?: number` (confirmed from `rpc.d.ts` and live responses).
- Porto returns **2 entries** per permission per response. The dialog server (`id.porto.sh`) returns both the relay's currently stored key AND the newly requested key in `capabilities.permissions`. Porto has no persistent client-side state between CLI runs (`Storage.memory()` in Node.js), so both entries originate server-side.
  - Entry 1 = relay's stored representation: `token: "0x0000..."` for native, includes fee-relay call `0x36a7...`, **old spend amounts** (on-chain update is async/pending so stored amounts are stale).
  - Entry 2 = newly requested key: `token: null` for native, just the requested calls, **new spend amounts** after `resolvePermissions`.
  - Both share the same `chainId`, `id`, and `expiry` (the new expiry from this grant).
- In multi-chain responses, Porto returns entries for ALL chains the key has active permissions on, each tagged with the correct `chainId`.
- `findGrantedPermission` filters by `publicKey`, then by `chainId`, then picks the **last** entry when expiries are equal (`>=` not `>`) to get entry 2 (newly requested, correct permissions) not entry 1 (relay-stored, stale).
- Spend limits are **per-chain** (enforced by the per-chain smart contract); the relay stores `HashMap<ChainId, Vec<AuthorizeKeyResponse>>`. Entry 1 for a new chain echoes whatever the relay last stored for that key globally — stale data from a prior chain's grant.
- The native spend value in entry 2 is larger than what you request: `resolvePermissions` in Porto merges the native `feeToken.limit` into the native `spend` entry (user spend + fee cap = stored native limit).
- Vitest `pretty-format` serializes plain object keys ALPHABETICALLY: `"11155420"` sorts before `"84532"` in inline snapshots.

## Known Upstream Issues

### Relay: `wallet_getKeys` leaks session keys cross-chain for pre-delegation accounts
- **Root cause**: `upgradeAccount` stores a `CreatableAccount` in the `accounts` table keyed by address only (no chain_id). When `wallet_getKeys` is called for a chain where the account isn't yet delegated, `get_keys_for_chain` falls back to `read_account` and returns ALL keys — including session keys that were only granted on the original chain.
- **Fix authored** (not yet merged): `~/src/github.com/ithacaxyz/relay` — added `chain_id: Option<u64>` to `CreatableAccount`, filter to admin-only keys in the fallback when chain doesn't match. Files: `src/types/storage.rs`, `src/rpc/relay.rs`, `tests/e2e/cases/keys.rs`, `tests/storage/roundtrip.rs`.
- **Agent-wallet impact**: Low. `getActivePermissions` already passes `chainIds: [chain.id]` and filters by `role === 'normal'` + public key match, so it won't misuse leaked keys. Worst case: `status` could show a permission as present on a chain where it's only pending via precall.

## Now
- Expand colocated unit coverage under `src/**` (ongoing).
- Decide CI strategy for live passkey e2e (scheduled/manual vs per-PR).

## Next
- Move Secure Enclave opaque handle storage from config into keychain item.
- Introduce account profile model with alias + default selection.

## Later
- Remote-admin setup (out-of-band admin ceremony from separate device).
- Multi-account aliases and default profile ergonomics.
- Evaluate additional backend adapters after Porto-first UX stabilizes.

## Done (2026-03-05)
- Updated configure funding detection to check balances across all Porto-supported fee tokens for the selected chain (native + ERC-20 fee tokens).
- Switched fee-token discovery to Porto SDK `RelayActions.getCapabilities` and removed silent fallback/error-swallowing from configure funding detection.

## Done (2026-03-06)
- Switched the chipkey npm dependency/import from `@jeanregisser/chipkey` to `@chipkey/cli`.
- Switched the repo package manager from npm to pnpm and replaced `package-lock.json` with `pnpm-lock.yaml`.
- Upgraded `incur` from `0.1.17` to `0.2.2` and revalidated `typecheck`, `test`, and `test:e2e`.
- Aligned caret lower bounds in `package.json` to the current resolved versions for direct deps, except `@types/node`.
- Switched `porto` from an exact version spec to a caret range for consistency with the direct dependency policy.
- Reduced the README local key management section to a single linked sentence pointing at `chipkey` and `@chipkey/cli`.

## Done (2026-03-03)
- Added colocated unit tests for `getChainByIdOrName` and `resolveCommandChain` (`src/porto/service.test.ts`, 20 tests).

## Done (2026-03-02 → latest)
- Multichain E2E flow test fully passing (`configure → sign → status → idempotent rerun → regrant → second chain`).
  - Fixed snapshot key ordering: Vitest `pretty-format` sorts object keys alphabetically, so `"11155420"` comes before `"84532"` in serialized `chains` objects.
  - Fixed `findGrantedPermission` helper: Porto returns 2 entries per permission (before/after state); added `chainId` filtering + changed `>` to `>=` in reduce so we always store the "after" state (entry 2, as-requested) rather than the "before" state (entry 1, stale relay cache).
  - Updated `configAfterRegrant` and `configAfterSecondChain` snapshots to reflect correct "after" state: single call entry without fee-relay address, `token: null` for native spend, correct 20e15 native limit (user 10e15 + fee 10e15).
- `pnpm run test:e2e` → pass (`1 passed / 0 failed`, ~21s).

## Done (2026-03-02)
- Implemented proper multichain support (`--chain` flag, `chainIds[]` config, per-chain status).
  - Replaced `--testnet` with `--chain <name|id>` across all commands.
  - Added `getChainByIdOrName` and `resolveCommandChain` helpers in `porto/service.ts`.
  - Config schema: `chainId`+`testnet` → `chainIds: number[]` (with migration for legacy configs).
  - `configure`: interactive chain picker (single-select, all Porto chains, mainnets first) when TTY and no `--chain`.
  - `sign`: `AMBIGUOUS_CHAIN` error when multiple chains configured and no `--chain` flag.
  - `status`: per-chain permissions + balance for all configured `chainIds`.
  - E2E flow test extended with second-chain step (OP Sepolia) + multichain invariants.
  - Porto initialized with `Chains.all` (all supported chains), not just Base+BaseSepolia.
  - `docs/cli-spec.md` updated to v0.3 with full multichain model documentation.

## Done
- Reworked `configure` into explicit linear phases and steps with `Now`/`You`/`Result`/`Next`.
- Made `configure` human-only (`--json` rejected with `CONFIGURE_HUMAN_ONLY`).
- Removed configure send/funding finalization dependency and switched to a Porto-precall-first reconciliation flow.
- Added persisted `pendingPermission` state in config for idempotent reruns and clear `pending_activation` reporting.
- Removed hidden configure self-call allowance injection and added explicit rejection of insecure broad self-call allowlist entries.
- Added explicit activation classification and human summary output (`Activation state`, pending details, and next action).
- Renamed configure checkpoint names to human-meaningful identifiers: `account`, `agent_key`, `permission_state`, `permission_preparation`, `permission_classification`, `outcome`.
- Removed ambiguous fallback behavior in configure permission preparation/finalization.
- Updated `configure.e2e` assertions to the new human flow markers and state model.
- Hardened Porto RPC/send diagnostics with explicit operation timeouts and stage-specific error codes (`RELAY_REQUEST_TIMEOUT`, `PORTO_SEND_*_TIMEOUT`).
- Switched `sign` transport to relay mode (headless, no dialog dependency) and removed explicit permission-id usage from sign send flow.
- Added research/debug scripts for investigation (not runtime/CI):
  - `/Users/jean/src/github.com/jeanregisser/agent-wallet/scripts/debug-selfcall-escalation.mjs`
  - `/Users/jean/src/github.com/jeanregisser/agent-wallet/scripts/debug-wallet-getkeys.mjs`
- Kept `sign` and `status` command surfaces unchanged while preserving security model constraints.
- Kept Porto internal-only as adapter/backend.
- Updated sign send/result semantics to reduce ambiguity between `txHash` (chain identifier) and `bundleId` (relay identifier).
