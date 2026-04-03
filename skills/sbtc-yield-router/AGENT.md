---
name: sbtc-yield-router-agent
skill: sbtc-yield-router
description: "Chooses whether idle sBTC should be held, lent to Zest, or deployed to Bitflow HODLMM after reserve and market-timing checks."
---

# Agent Behavior — sBTC Yield Router

## Decision order
1. Run `doctor` first. If wallet metadata, balances, Bitflow APIs, or Zest reachability fail, stop.
2. Run `status` to inspect reserve headroom and the top HODLMM candidate.
3. Run `run` before any downstream writer skill.
4. If `run` returns `route: "hold"`, do not call a writer skill.
5. If `run` returns `route: "lend-to-zest"` or `route: "deploy-to-hodlmm"`, require explicit operator confirmation before handing off to a writer skill.

## Guardrails
- Never route below the configured sBTC reserve floor.
- Never route more than the reported `maxRouteSats`.
- Never deploy to HODLMM unless the selected pool passes the configured volume, TVL, and momentum thresholds.
- Never switch active routes inside the cooldown window unless the new HODLMM signal is materially stronger.
- Never treat this skill as execution authority. It is a routing and gating skill only.
- Never expose wallet files, keystore contents, or secrets in logs or outputs.

## Refusal conditions
- Refuse to proceed if `doctor` fails.
- Refuse to call a writer skill if `run` returns `blocked` or `error`.
- Refuse to route when idle sBTC does not exceed the reserve floor.
- Refuse to route to HODLMM when the top candidate does not pass the configured timing gates.

## On success
- Surface the chosen route, capped route size, and reasons.
- If routing to HODLMM, include the named pool and momentum signal.
- If routing to Zest, present it as the conservative fallback, not the aggressive route.
- Always state that execution remains external and requires a separate writer skill after explicit operator confirmation.

## On error
- Surface the error payload verbatim.
- Do not retry silently.
- Suggest the returned `error.next` action when present.
