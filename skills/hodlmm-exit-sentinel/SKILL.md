---
name: hodlmm-exit-sentinel
description: "Scans sBTC-involved Bitflow HODLMM LP positions and emits hold, reduce, or exit signals when drift, divergence, or liquidity stress gets too high."
metadata:
  author: "ololadestephen"
  author-agent: "Wide Eden"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "hodlmm-exit-sentinel/hodlmm-exit-sentinel.ts"
  requires: "wallet, settings"
  tags: "defi, infrastructure, read-only, mainnet-only, l2"
---

# HODLMM Exit Sentinel

## What it does
Scans Bitflow HODLMM pools involving sBTC, finds LP positions for the active AIBTC wallet or a specified Stacks address, and returns hold, reduce, or exit signals when a deployed LP position drifts too far from the active bin or the pool quality deteriorates. It is a read-only safety and portfolio-protection primitive.

## Why agents need it
Autonomous LP agents need to know not just where to deploy, but when to stop bleeding. This skill gives agents a hard safety layer for deployed HODLMM capital by combining position drift, active-bin price divergence, 24h volume, TVL, and pool volatility into an actionable exit posture before a writer skill touches funds.

## Safety notes
- Read-only. This skill never signs, simulates, or submits transactions.
- Mainnet only. It evaluates live Bitflow mainnet HODLMM pool state and position endpoints.
- Wallet-aware. By default it reads the active AIBTC wallet address from the local operator environment.
- Refuses to produce an execution recommendation if no HODLMM LP positions are found.
- Only emits capped posture outputs: `hold`, `reduce`, or `exit`, plus `maxExitPct` for downstream writers.

## Commands

### doctor
Checks AIBTC wallet metadata, Bitflow HODLMM APIs, Hiro balances, and discovery of sBTC-involved pools.
```bash
bun run skills/hodlmm-exit-sentinel/hodlmm-exit-sentinel.ts doctor
```

### status
Finds the current address's sBTC-involved HODLMM LP positions and returns a portfolio snapshot.
```bash
bun run skills/hodlmm-exit-sentinel/hodlmm-exit-sentinel.ts status
```

### run
Evaluates discovered LP positions and emits `hold`, `reduce`, or `exit` posture with reasons and a capped `maxExitPct`.
```bash
bun run skills/hodlmm-exit-sentinel/hodlmm-exit-sentinel.ts run
```

Optional flags:
```bash
bun run skills/hodlmm-exit-sentinel/hodlmm-exit-sentinel.ts run --address SP... --pool-id dlmm_1 --min-volume-usd 25000 --max-price-divergence-pct 1.0 --reduce-drift-bins 4 --exit-drift-bins 12 --max-volatility-score 60
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "action": "Reduce exposure in dlmm_1",
  "data": {
    "summary": {
      "positionsFound": 1,
      "highestSeverity": "reduce"
    },
    "positions": [
      {
        "poolId": "dlmm_1",
        "posture": "reduce",
        "maxExitPct": 0.5
      }
    ]
  },
  "error": null
}
```

**Blocked:**
```json
{
  "status": "blocked",
  "action": "No sBTC-involved HODLMM LP positions were found for the requested address",
  "data": {
    "positionsFound": 0
  },
  "error": {
    "code": "NO_POSITIONS",
    "message": "No sBTC-involved HODLMM LP positions were found",
    "next": "Pass a different --address or deploy capital before using this sentinel"
  }
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints
- Requires local AIBTC wallet metadata to resolve the default active address.
- Uses Bitflow public app and quote APIs plus Bitflow user-position endpoints.
- Position discovery depends on live Bitflow position responses and treats missing pool bins as "no position".
- This is a position-protection signal, not an execution skill. Any actual withdraw or rebalance must happen in a separate writer skill.
