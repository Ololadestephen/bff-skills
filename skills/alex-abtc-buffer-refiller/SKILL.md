---
name: alex-abtc-buffer-refiller
description: "Maintains a minimum aBTC buffer by swapping capped STX into aBTC on ALEX when the wallet falls below target."
metadata:
  author: "Ololadestephen"
  author-agent: "Wide Eden"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "alex-abtc-buffer-refiller/alex-abtc-buffer-refiller.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, alex, btc"
---

# ALEX aBTC Buffer Refiller

## What it does

Keeps a minimum aBTC operating buffer for an AIBTC wallet by swapping a capped amount of STX into aBTC on ALEX when the wallet falls below target. This is a write skill: it unlocks the selected AIBTC wallet, runs live ALEX quote checks, enforces gas and spend reserves, and broadcasts the swap only after explicit confirmation.

## Why agents need it

Agents often hold STX for gas while still needing BTC-denominated inventory for trading, routing, or treasury management. This skill gives agents a disciplined way to rebuild BTC exposure without over-spending STX or draining gas reserves.

## Safety notes

- Writes to chain. `run` signs and broadcasts a real ALEX swap transaction.
- Mainnet only. ALEX swaps and wallet broadcasting are executed on Stacks mainnet.
- Wallet password required. The skill unlocks the local AIBTC wallet at execution time using `AIBTC_WALLET_PASSWORD`.
- Spend cap enforced. The swap amount is capped by `--max-swap-ustx` and must remain below the post-gas reserve.
- Gas reserve enforced. The wallet must keep at least `--min-gas-reserve-ustx` after the swap.
- Explicit confirmation required. `run` refuses to execute unless `--confirm=REFILL` is provided.
- Slippage floor enforced. The swap uses a quote-derived minimum output based on `--slippage-bps`.
- Wallet is re-locked after the attempted write path.

## Commands

### doctor
Checks wallet resolution, STX/aBTC balances, ALEX connectivity, and whether the configured swap amount can clear the gas reserve.

```bash
bun run skills/alex-abtc-buffer-refiller/alex-abtc-buffer-refiller.ts doctor
```

### status
Shows current STX/aBTC balances, target deficit, live quote for the configured refill amount, and whether a refill is currently allowed.

```bash
bun run skills/alex-abtc-buffer-refiller/alex-abtc-buffer-refiller.ts status
```

### run
Unlocks the wallet, executes the ALEX STX→aBTC swap, and returns the txid plus explorer link.

```bash
AIBTC_WALLET_PASSWORD='your-password' bun run skills/alex-abtc-buffer-refiller/alex-abtc-buffer-refiller.ts run --confirm=REFILL
```

Example tuned run:

```bash
AIBTC_WALLET_PASSWORD='your-password' bun run skills/alex-abtc-buffer-refiller/alex-abtc-buffer-refiller.ts run --wallet-id=3fd5fe55-40dd-4a19-b3dd-f71e31ed0b8d --target-abtc-sats=25 --swap-amount-ustx=500000 --max-swap-ustx=500000 --min-gas-reserve-ustx=100000 --slippage-bps=500 --confirm=REFILL
```

## Output contract

All outputs are JSON to stdout.

**Success:**

```json
{
  "status": "success",
  "action": "Refilled aBTC buffer via ALEX",
  "data": {
    "operation": "refill-buffer",
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
  "action": "Increase STX balance or reduce swap size before retrying",
  "data": {},
  "error": {
    "code": "INSUFFICIENT_STX_RESERVE",
    "message": "Swap would break the configured gas reserve",
    "next": "Fund more STX or lower --swap-amount-ustx"
  }
}
```

**Error:**

```json
{ "error": "descriptive message" }
```

## Known constraints

- Targets aBTC on ALEX, not sBTC. This uses the live STX/aBTC route currently exposed by ALEX.
- Requires a wallet with enough STX to cover both the swap and post-transaction gas reserve.
- Requires `AIBTC_WALLET_PASSWORD` to unlock the selected AIBTC wallet for write execution.
- Quote precision on very small swaps may round output down to zero; the skill blocks when quote output is below `--min-receive-sats`.
