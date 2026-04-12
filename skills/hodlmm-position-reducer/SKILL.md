---
name: hodlmm-position-reducer
description: "Reduces sBTC exposure with a capped Bitflow swap when sBTC HODLMM pools breach configured risk thresholds."
metadata:
  author: "Ololadestephen"
  author-agent: "Wide Eden"
  user-invocable: "false"
  arguments: "doctor | install-packs | status | run"
  entry: "hodlmm-position-reducer/hodlmm-position-reducer.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# HODLMM Position Reducer

## What it does

Monitors live sBTC HODLMM pool conditions on Bitflow and, when risk thresholds are breached, executes a capped `sBTC -> USDCx` Bitflow swap to reduce the wallet's sBTC exposure. This is a write skill: it unlocks the selected AIBTC wallet, checks live risk and quote conditions, enforces spend and reserve limits, and only broadcasts after explicit confirmation.

## Why agents need it

Agents holding sBTC need a practical exit primitive when HODLMM conditions deteriorate. This skill gives them a disciplined way to de-risk inventory using the same Bitflow ecosystem they monitor, without draining gas or selling the full balance by default.

## Safety notes

- Writes to chain. `run` signs and broadcasts a real Bitflow swap transaction.
- Mainnet only. Pool scoring and swap execution target live Bitflow / Stacks mainnet endpoints.
- Wallet password required. The skill unlocks the local AIBTC wallet at execution time using `AIBTC_WALLET_PASSWORD`.
- Exposure cap enforced. The reduction size is capped by `--max-reduce-sats` and must stay above the retained `--reserve-sats`.
- Gas reserve enforced. The wallet must keep at least `--min-gas-reserve-ustx` after the write path.
- Risk trigger enforced. `run` refuses to execute unless the selected or best sBTC HODLMM pool breaches `--trigger-risk-score`.
- Liquidity floor enforced. `run` refuses to execute when pool volume is below `--min-volume-usd`.
- Explicit confirmation required. `run` refuses to execute unless `--confirm=REDUCE` is provided.
- Slippage floor enforced. The swap uses a quote-derived minimum output based on `--slippage-bps`.
- Cooldown enforced. Recent reductions block repeated execution until `--cooldown-hours` has elapsed.
- Wallet-scoped state enforced. Cooldown and prior reduction metadata are stored per wallet under `~/.aibtc/`.
- Wallet is re-locked after the attempted write path.

## Commands

### doctor
Checks wallet resolution, STX and sBTC balances, Bitflow connectivity, HODLMM risk data, and whether the current configuration could execute a reduction safely.

```bash
bun run skills/hodlmm-position-reducer/hodlmm-position-reducer.ts doctor
```

### install-packs
Lists the runtime packages the environment must already provide.

```bash
bun run skills/hodlmm-position-reducer/hodlmm-position-reducer.ts install-packs
```

### status
Shows live wallet balances, the top sBTC HODLMM risk candidate, the planned reduction size, the current quote, and any blockers.

```bash
bun run skills/hodlmm-position-reducer/hodlmm-position-reducer.ts status
```

### run
Unlocks the wallet, re-checks HODLMM risk and quote conditions, executes the Bitflow `sBTC -> USDCx` reduction, and returns the txid plus explorer link.

```bash
AIBTC_WALLET_PASSWORD='your-password' bun run skills/hodlmm-position-reducer/hodlmm-position-reducer.ts run --confirm=REDUCE
```

Example tuned run:

```bash
AIBTC_WALLET_PASSWORD='your-password' bun run skills/hodlmm-position-reducer/hodlmm-position-reducer.ts run --wallet-id=b4d575f8-0865-4d6f-b1d6-5627b645a03c --max-reduce-sats=150 --reserve-sats=100 --trigger-risk-score=35 --min-volume-usd=100 --min-gas-reserve-ustx=100000 --slippage-bps=300 --confirm=REDUCE
```

## Output contract

All outputs are JSON to stdout.

**Success:**

```json
{
  "status": "success",
  "action": "Reduced sBTC exposure via Bitflow",
  "data": {
    "operation": "reduce-exposure",
    "txid": "0x...",
    "explorerUrl": "https://explorer.hiro.so/txid/0x...?chain=mainnet"
  },
  "error": null
}
```

**Blocked:**

```json
{
  "status": "blocked",
  "action": "Hold current sBTC exposure until risk and execution gates are satisfied",
  "data": {},
  "error": {
    "code": "PREFLIGHT_BLOCKED",
    "message": "No sBTC HODLMM pool breached the configured trigger",
    "next": "Re-run later or lower the trigger with explicit operator approval"
  }
}
```

**Error:**

```json
{ "error": "descriptive message" }
```

## Known constraints

- This skill reduces sBTC inventory based on live sBTC HODLMM pool conditions; it does not withdraw LP bins directly from a HODLMM contract.
- The write path currently targets `USDCx` as the defensive asset after reduction.
- Requires both sBTC inventory and enough STX to preserve post-transaction gas reserve.
- Quote precision on very small swaps may round output down; the skill blocks when quote output is below `--min-receive-base`.
- HODLMM assessment intentionally caps bin fetches to the strongest sBTC pools first so status checks remain bounded as Bitflow pool count grows.
