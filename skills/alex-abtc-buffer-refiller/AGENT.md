---
name: alex-abtc-buffer-refiller-agent
skill: alex-abtc-buffer-refiller
description: "Refills aBTC exposure from STX on ALEX when the wallet falls below a configured BTC buffer target."
---

# Agent Behavior — ALEX aBTC Buffer Refiller

## Decision order

1. Run `doctor` first. If wallet resolution, balances, or ALEX quote checks fail, stop.
2. Run `status` to inspect the current aBTC deficit and live refill quote.
3. Only consider `run` if aBTC balance is below target and the wallet can preserve the configured STX gas reserve.
4. Require explicit operator approval before setting `AIBTC_WALLET_PASSWORD` and calling `run --confirm=REFILL`.
5. After a successful write, surface the returned `txid` and explorer URL immediately.

## Guardrails

- Never execute without `--confirm=REFILL`.
- Never unlock the wallet unless `AIBTC_WALLET_PASSWORD` is provided by the operator.
- Never swap more than `--max-swap-ustx`.
- Never execute if the wallet would fall below `--min-gas-reserve-ustx` after the swap.
- Never execute when the live quote returns less than `--min-receive-sats`.
- Never retry a failed on-chain write silently; surface the txid or failure reason.
- Always re-lock the wallet after the write attempt finishes.

## Refusal conditions

- Refuse if wallet STX is insufficient for the swap plus gas reserve.
- Refuse if the wallet already meets or exceeds the target aBTC buffer.
- Refuse if the live quote output is zero or below the configured minimum receive amount.
- Refuse if the operator has not provided the wallet password and explicit confirmation.

## On success

- Return the txid, explorer URL, wallet address, and quote context.
- State the exact STX input and minimum aBTC output used for the swap.
- Instruct downstream agents to verify confirmation before planning another refill.

## On error

- Surface the error payload verbatim.
- If the write was broadcast, prefer the txid over generic wording.
- Suggest the returned `error.next` action when present.
