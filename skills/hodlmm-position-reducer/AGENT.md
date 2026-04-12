---
name: hodlmm-position-reducer-agent
skill: hodlmm-position-reducer
description: "Executes a capped Bitflow sBTC risk reduction only after HODLMM risk gates, reserve checks, and explicit confirmation all pass."
---

# HODLMM Position Reducer Agent

## Purpose

Use this skill to reduce sBTC exposure when Bitflow sBTC HODLMM pools show elevated exit risk and the wallet still has enough STX to operate safely afterwards.

## Decision order

1. Run `doctor` before using `run` on a wallet you have not checked recently.
2. Run `status` to inspect the current top-risk sBTC HODLMM pool, balances, cooldown state, and proposed reduction size.
3. Only use `run` when:
   - the selected wallet is on mainnet
   - the risk score meets or exceeds the configured trigger
   - cooldown has expired
   - sBTC balance exceeds the retained reserve
   - post-transaction STX reserve remains above the configured minimum
   - the Bitflow quote returns a non-zero expected output above the configured minimum
   - explicit operator approval has been given
4. Require `--confirm=REDUCE` before broadcasting.
5. Re-lock the wallet after the write attempt, regardless of success or failure.

## Guardrails

- Never execute without `AIBTC_WALLET_PASSWORD`.
- Never reduce more than `--max-reduce-sats`.
- Never reduce below the retained `--reserve-sats`.
- Never execute when cooldown is still active.
- Never execute when the selected or best sBTC HODLMM pool is below `--trigger-risk-score`.
- Never execute when `volumeUsd1d` is below `--min-volume-usd`.
- Never execute when the quote output is below `--min-receive-base`.
- Never execute when STX reserve would fall below `--min-gas-reserve-ustx`.
- Refuse when no AIBTC wallet can be resolved.
- Refuse when the wallet is not on mainnet.
- Refuse when no sBTC balance is available above reserve.
- Refuse when no eligible sBTC HODLMM pool can be assessed.
- Refuse when the risk trigger is not met.
- Refuse when cooldown is active.
- Refuse when the quote is zero or below the receive floor.
- Refuse when operator confirmation is missing.

## Operational notes

- This is a write skill and will broadcast a real Bitflow swap on success.
- The skill reduces wallet exposure based on HODLMM pool risk; it does not claim to withdraw liquidity bins directly.
- For larger reductions, tighten slippage and increase the retained reserve before execution.
