---
name: sbtc-yield-router
description: "Keeps an operating reserve of sBTC, then routes excess capital to Zest or Bitflow HODLMM based on live timing and safety gates."
metadata:
  author: "Ololadestephen"
  author-agent: "Wide Eden"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "sbtc-yield-router/sbtc-yield-router.ts"
  requires: "wallet, settings"
  tags: "defi, infrastructure, read-only, mainnet-only, l2"
---

# sBTC Yield Router

## What it does
Reads the active AIBTC wallet, keeps a configurable sBTC operating reserve, and produces a routing recommendation for excess sBTC: Bitflow HODLMM when fee and volume momentum are strong, Zest when Bitflow timing is weak but idle capital should still earn, or hold when safety gates fail. It also records local route history and enforces a cooldown between active route changes to reduce churn.

## Why agents need it
Agents need a direct capital decision, not just isolated monitors. This skill answers the practical question: "I have idle sBTC now. Should I hold it, lend it on Zest, or deploy it to Bitflow HODLMM?" It is the routing layer between wallet balances, HODLMM timing, and conservative yield fallback.

## Safety notes
- Read-only. This skill never signs, simulates, or submits transactions.
- Execution is external. Any actual Zest supply or HODLMM deployment must happen in a separate writer skill after explicit operator confirmation.
- Mainnet only. It reads live Bitflow and Hiro mainnet data and validates Zest contract reachability.
- Wallet-aware. By default it resolves the active AIBTC wallet locally.
- Enforces a configurable liquid reserve floor before recommending any routing action.
- Caps any routed amount and never recommends draining the wallet to zero.
- Tracks local route history and can block rapid route changes with a cooldown unless a stronger HODLMM spike appears.

## Commands

### doctor
Checks AIBTC wallet metadata, Hiro balances, Bitflow sBTC pool discovery, and Zest contract reachability.
```bash
bun run skills/sbtc-yield-router/sbtc-yield-router.ts doctor
```

### status
Returns the wallet snapshot, reserve headroom, and the current top HODLMM deployment candidate.
```bash
bun run skills/sbtc-yield-router/sbtc-yield-router.ts status
```

### run
Returns a direct routing posture: `hold`, `lend-to-zest`, or `deploy-to-hodlmm`, plus the required handoff to a separate writer skill when execution is desired.
```bash
bun run skills/sbtc-yield-router/sbtc-yield-router.ts run
```

Optional flags:
```bash
bun run skills/sbtc-yield-router/sbtc-yield-router.ts run --reserve-sats 200000 --max-route-sats 500000 --min-hodlmm-score 120 --min-hodlmm-volume-usd 25000 --min-hodlmm-tvl-usd 25000 --route-cooldown-hours 4
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "action": "Recommend routing 500000 sats to Bitflow HODLMM pool dlmm_6",
  "data": {
    "route": "deploy-to-hodlmm",
    "executionMode": "external-writer-required",
    "nextStep": "After explicit operator confirmation, pass this route to a separate writer skill for execution.",
    "maxRouteSats": 500000,
    "candidate": {
      "poolId": "dlmm_6",
      "momentumSignal": "spike"
    }
  },
  "error": null
}
```

**Blocked / Hold:**
```json
{
  "status": "blocked",
  "action": "Hold idle sBTC until reserve, gas, or market conditions improve",
  "data": {
    "route": "hold",
    "blockedReasons": [
      "Idle sBTC does not exceed the reserve floor"
    ]
  },
  "error": {
    "code": "NO_ROUTE",
    "message": "No route passed the configured safety gates",
    "next": "Re-run later or relax thresholds with explicit operator approval"
  }
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints
- Requires local AIBTC wallet metadata to resolve the default active address.
- Uses Bitflow public app APIs for live HODLMM fee, volume, APR, and liquidity signals.
- Zest readiness is validated by contract reachability rather than a live public APR feed.
- Persists local route history in `~/.sbtc-yield-router-state.json` for trend and cooldown handling.
- Routing output is advisory only; any actual Zest supply or HODLMM deployment must happen in a separate writer skill.
