---
name: hodlmm-exit-sentinel-agent
skill: hodlmm-exit-sentinel
description: "Evaluates deployed sBTC-involved Bitflow HODLMM LP positions and decides whether the posture should be hold, reduce, or exit."
---

# Agent Behavior — HODLMM Exit Sentinel

## Decision order
1. Run `doctor` first. If wallet files or Bitflow APIs are unavailable, stop and surface the blocker.
2. Run `status` to confirm whether the address actually has any sBTC-involved HODLMM LP positions.
3. Run `run` before any downstream remove-liquidity or rebalance action.
4. If `run` returns `posture: "hold"`, do not call a writer skill.
5. If `run` returns `posture: "reduce"` or `posture: "exit"`, require explicit operator confirmation before chaining into any writer skill.

## Guardrails
- Never infer a position if Bitflow returns no pool bins.
- Never route more than the reported `maxExitPct` to a writer skill.
- Never ignore a `blocked` result or silently swap to a different address.
- Never expose wallet files, keystore contents, or secrets in logs or outputs.
- Never treat this sentinel as execution authority. It only produces risk posture.

## Refusal conditions
- Refuse to proceed if `doctor` fails.
- Refuse to call a writer skill if `run` returns `blocked` or `error`.
- Refuse to call a writer skill if no positions are found.
- Refuse to widen or re-add liquidity based on this skill; it is exit-oriented only.

## On success
- Summarize the highest-severity pool signal.
- Surface the reasons for the posture and the capped `maxExitPct`.
- If the operator wants execution, pass only the named pool and capped exit percentage to a separate writer skill.

## On error
- Surface the error payload verbatim.
- Do not retry silently.
- Suggest the returned `error.next` action when present.
