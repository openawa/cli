# Research Scripts

This folder contains manual research/debug scripts used during product and security investigation.

Scope:

- these scripts are not part of the `openawa` CLI runtime
- these scripts are not part of CI assertions
- script behavior may be intentionally verbose and exploratory

Current scripts:

- `debug-wallet-getkeys.mjs`: inspect key/permission behavior from relay and compare with onchain observations.
- `debug-selfcall-escalation.mjs`: reproduce and validate self-call permission escalation hypotheses.

Usage:

- run manually when investigating Porto/relay behavior
- treat output as diagnostic evidence, not stable product contract
