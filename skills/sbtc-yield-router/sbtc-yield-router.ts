#!/usr/bin/env bun

import { Command } from "commander";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const AIBTC_HOME = process.env.AIBTC_HOME || join(homedir(), ".aibtc");
const AIBTC_CONFIG_PATH = join(AIBTC_HOME, "config.json");
const AIBTC_WALLETS_PATH = join(AIBTC_HOME, "wallets.json");
const BITFLOW_API = "https://bff.bitflowapis.finance";
const HIRO_API = "https://api.mainnet.hiro.so";
const FETCH_TIMEOUT_MS = 30_000;
const MIN_GAS_USTX = 100_000;
const DEFAULT_RESERVE_SATS = 200_000;
const DEFAULT_MAX_ROUTE_SATS = 500_000;
const DEFAULT_MIN_HODLMM_SCORE = 120;
const DEFAULT_MIN_HODLMM_VOLUME_USD = 25_000;
const DEFAULT_MIN_HODLMM_TVL_USD = 25_000;

type SkillStatus = "success" | "error" | "blocked";
type Route = "hold" | "lend-to-zest" | "deploy-to-hodlmm";
type MomentumSignal = "spike" | "elevated" | "normal" | "cooling" | "flat";

interface WalletConfig {
  version: number;
  activeWalletId?: string;
}

interface StoredWallet {
  id: string;
  name?: string;
  address: string;
  btcAddress?: string;
  taprootAddress?: string;
}

interface WalletStore {
  version: number;
  wallets: StoredWallet[];
}

interface HiroStxResponse {
  balance: string;
  locked: string;
}

interface HiroBalancesResponse {
  fungible_tokens?: Record<string, { balance: string }>;
}

interface AppToken {
  contract: string;
  symbol?: string;
  decimals: number;
  priceUsd: number;
}

interface AppPool {
  poolId: string;
  poolStatus: boolean;
  tvlUsd: number;
  volumeUsd1d: number;
  volumeUsd7d: number;
  feesUsd1d: number;
  feesUsd7d: number;
  apr24h: number;
  binStep?: number | string;
  sbtcIncentives?: boolean;
  tokens: {
    tokenX: AppToken;
    tokenY: AppToken;
  };
}

interface AppPoolsResponse {
  data?: AppPool[];
}

interface WalletSnapshot {
  walletName: string;
  stacksAddress: string;
  bitcoinAddress: string | null;
  taprootAddress: string | null;
  stxUstx: number;
  sbtcSats: number;
}

interface HODLMMCandidate {
  poolId: string;
  pair: string;
  tvlUsd: number;
  volumeUsd1d: number;
  apr24h: number;
  feesUsd1d: number;
  feeVelocity: number;
  volumeVelocity: number;
  aprSpike: number;
  momentumScore: number;
  momentumSignal: MomentumSignal;
  sbtcIncentives: boolean;
  eligible: boolean;
  reasons: string[];
}

interface RunOptions {
  reserveSats: number;
  maxRouteSats: number;
  minHodlmmScore: number;
  minHodlmmVolumeUsd: number;
  minHodlmmTvlUsd: number;
}

interface SkillOutput {
  status: SkillStatus;
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

function printFlatError(message: string): never {
  console.log(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

function printResult(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function toNumber(value: string | number | undefined | null): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadActiveWallet(): StoredWallet {
  const config = parseJsonFile<WalletConfig>(AIBTC_CONFIG_PATH);
  const store = parseJsonFile<WalletStore>(AIBTC_WALLETS_PATH);
  if (!config.activeWalletId) {
    throw new Error("AIBTC config does not contain an activeWalletId");
  }
  const wallet = store.wallets.find((item) => item.id === config.activeWalletId);
  if (!wallet || !wallet.address) {
    throw new Error("Active AIBTC wallet could not be resolved");
  }
  return wallet;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "bff-skills/sbtc-yield-router",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getStxBalance(address: string): Promise<number> {
  const data = await fetchJson<HiroStxResponse>(`${HIRO_API}/extended/v1/address/${address}/stx`);
  return Math.max(0, toNumber(data.balance) - toNumber(data.locked));
}

async function getSbtcBalance(address: string): Promise<number> {
  const data = await fetchJson<HiroBalancesResponse>(`${HIRO_API}/extended/v1/address/${address}/balances`);
  const ftKey = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token";
  return toNumber(data.fungible_tokens?.[ftKey]?.balance);
}

async function getWalletSnapshot(): Promise<WalletSnapshot> {
  const wallet = loadActiveWallet();
  const [stxUstx, sbtcSats] = await Promise.all([
    getStxBalance(wallet.address),
    getSbtcBalance(wallet.address),
  ]);

  return {
    walletName: wallet.name || "aibtc-wallet",
    stacksAddress: wallet.address,
    bitcoinAddress: wallet.btcAddress || null,
    taprootAddress: wallet.taprootAddress || null,
    stxUstx,
    sbtcSats,
  };
}

async function fetchAppPools(): Promise<AppPool[]> {
  const response = await fetchJson<AppPoolsResponse>(`${BITFLOW_API}/api/app/v1/pools`);
  return response.data ?? [];
}

async function checkZestReachable(): Promise<boolean> {
  const url = `${HIRO_API}/v2/contracts/interface/SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N/pool-borrow-v2-3`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "bff-skills/sbtc-yield-router",
      },
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function isSbtcPool(pool: AppPool): boolean {
  const tokens = [
    pool.tokens.tokenX.contract.toLowerCase(),
    pool.tokens.tokenY.contract.toLowerCase(),
    pool.tokens.tokenX.symbol?.toLowerCase() || "",
    pool.tokens.tokenY.symbol?.toLowerCase() || "",
  ];
  return tokens.some((token) => token.includes("sbtc"));
}

function pairLabel(pool: AppPool): string {
  return `${pool.tokens.tokenX.symbol || "tokenX"}-${pool.tokens.tokenY.symbol || "tokenY"}`;
}

function computeMomentumSignal(score: number, feeVelocity: number, volumeVelocity: number): MomentumSignal {
  if (feeVelocity < 0.05 && volumeVelocity < 0.05) return "flat";
  if (score >= 180 || feeVelocity >= 3) return "spike";
  if (score >= 90 || feeVelocity >= 1.5) return "elevated";
  if (score < 30 || feeVelocity < 0.5) return "cooling";
  return "normal";
}

function assessHodlmmPool(pool: AppPool, options: RunOptions): HODLMMCandidate {
  const feesUsd7dDailyAvg = pool.feesUsd7d > 0 ? pool.feesUsd7d / 7 : 0;
  const volumeUsd7dDailyAvg = pool.volumeUsd7d > 0 ? pool.volumeUsd7d / 7 : 0;
  const feeVelocity = feesUsd7dDailyAvg > 0 ? pool.feesUsd1d / feesUsd7dDailyAvg : pool.feesUsd1d > 0 ? 10 : 0;
  const volumeVelocity = volumeUsd7dDailyAvg > 0 ? pool.volumeUsd1d / volumeUsd7dDailyAvg : pool.volumeUsd1d > 0 ? 10 : 0;
  const aprSpike = clamp(pool.apr24h / 100, 0, 4);
  const momentumScore = Number(((feeVelocity * 60) + (volumeVelocity * 30) + (aprSpike * 10)).toFixed(2));
  const momentumSignal = computeMomentumSignal(momentumScore, feeVelocity, volumeVelocity);

  const reasons: string[] = [];
  if (pool.volumeUsd1d < options.minHodlmmVolumeUsd) {
    reasons.push(`24h volume ${pool.volumeUsd1d.toFixed(2)} < ${options.minHodlmmVolumeUsd}`);
  }
  if (pool.tvlUsd < options.minHodlmmTvlUsd) {
    reasons.push(`TVL ${pool.tvlUsd.toFixed(2)} < ${options.minHodlmmTvlUsd}`);
  }
  if (momentumScore < options.minHodlmmScore) {
    reasons.push(`momentum score ${momentumScore} < ${options.minHodlmmScore}`);
  }
  if (momentumSignal === "cooling" || momentumSignal === "flat") {
    reasons.push(`momentum signal is ${momentumSignal}`);
  }

  return {
    poolId: pool.poolId,
    pair: pairLabel(pool),
    tvlUsd: Number(pool.tvlUsd.toFixed(2)),
    volumeUsd1d: Number(pool.volumeUsd1d.toFixed(2)),
    apr24h: Number(pool.apr24h.toFixed(2)),
    feesUsd1d: Number(pool.feesUsd1d.toFixed(2)),
    feeVelocity: Number(feeVelocity.toFixed(3)),
    volumeVelocity: Number(volumeVelocity.toFixed(3)),
    aprSpike: Number(aprSpike.toFixed(3)),
    momentumScore,
    momentumSignal,
    sbtcIncentives: Boolean(pool.sbtcIncentives),
    eligible: reasons.length === 0,
    reasons,
  };
}

async function collectContext(options: RunOptions): Promise<{
  wallet: WalletSnapshot;
  zestReachable: boolean;
  candidates: HODLMMCandidate[];
  bestCandidate: HODLMMCandidate | null;
  routeableSats: number;
}> {
  const [wallet, appPools, zestReachable] = await Promise.all([
    getWalletSnapshot(),
    fetchAppPools(),
    checkZestReachable(),
  ]);

  const routeableSats = Math.max(0, wallet.sbtcSats - options.reserveSats);
  const candidates = appPools
    .filter((pool) => pool.poolStatus && isSbtcPool(pool))
    .map((pool) => assessHodlmmPool(pool, options))
    .sort((left, right) => right.momentumScore - left.momentumScore);

  const bestCandidate = candidates.find((candidate) => candidate.eligible) || null;
  return { wallet, zestReachable, candidates, bestCandidate, routeableSats };
}

async function runDoctor(): Promise<void> {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  let wallet: StoredWallet | null = null;

  try {
    wallet = loadActiveWallet();
    checks.wallet = { ok: true, detail: `${wallet.address} (${wallet.btcAddress || "no btcAddress"})` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.wallet = { ok: false, detail: message };
  }

  if (wallet) {
    try {
      const [stxUstx, sbtcSats] = await Promise.all([
        getStxBalance(wallet.address),
        getSbtcBalance(wallet.address),
      ]);
      checks.balances = { ok: true, detail: `stx=${stxUstx} uSTX, sbtc=${sbtcSats} sats` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.balances = { ok: false, detail: message };
    }
  }

  try {
    const pools = await fetchAppPools();
    const sbtcPools = pools.filter((pool) => isSbtcPool(pool)).length;
    checks.bitflow = { ok: sbtcPools > 0, detail: `${sbtcPools} sBTC pools discovered` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.bitflow = { ok: false, detail: message };
  }

  const zestReachable = await checkZestReachable();
  checks.zest = {
    ok: zestReachable,
    detail: zestReachable ? "Zest contract interface reachable" : "Zest contract interface unavailable",
  };

  const allOk = Object.values(checks).every((check) => check.ok);
  if (allOk) {
    printResult({
      status: "success",
      action: "Environment ready. Run status or run to route idle sBTC.",
      data: { checks },
      error: null,
    });
    return;
  }

  const blockers = Object.entries(checks)
    .filter(([, check]) => !check.ok)
    .map(([name, check]) => `${name}: ${check.detail}`);

  printResult({
    status: "blocked",
    action: "Resolve the reported blockers before routing idle sBTC.",
    data: { checks, blockers },
    error: {
      code: "DOCTOR_FAILED",
      message: blockers.join("; "),
      next: "Resolve the failed checks and re-run doctor",
    },
  });
}

async function runStatus(options: RunOptions): Promise<void> {
  const { wallet, zestReachable, candidates, bestCandidate, routeableSats } = await collectContext(options);

  printResult({
    status: "success",
    action: bestCandidate
      ? `Top HODLMM candidate is ${bestCandidate.poolId} with signal ${bestCandidate.momentumSignal}`
      : "No HODLMM candidate currently passes the configured timing gates",
    data: {
      wallet,
      reserve: {
        reserveSats: options.reserveSats,
        routeableSats,
        maxRouteSats: options.maxRouteSats,
      },
      zestReachable,
      topCandidate: bestCandidate,
      candidates: candidates.slice(0, 3),
    },
    error: null,
  });
}

async function runRouter(options: RunOptions): Promise<void> {
  const { wallet, zestReachable, candidates, bestCandidate, routeableSats } = await collectContext(options);
  const blockedReasons: string[] = [];

  if (wallet.stxUstx < MIN_GAS_USTX) {
    blockedReasons.push(`STX gas balance ${wallet.stxUstx} uSTX is below ${MIN_GAS_USTX} uSTX`);
  }
  if (routeableSats <= 0) {
    blockedReasons.push("Idle sBTC does not exceed the reserve floor");
  }

  const maxRouteSats = Math.min(routeableSats, options.maxRouteSats);
  if (maxRouteSats <= 0) {
    blockedReasons.push("No routeable sBTC remains after reserve and route caps");
  }

  if (blockedReasons.length > 0) {
    printResult({
      status: "blocked",
      action: "Hold idle sBTC until reserve, gas, or balance conditions improve",
      data: {
        route: "hold",
        wallet,
        reserve: {
          reserveSats: options.reserveSats,
          routeableSats,
          maxRouteSats,
        },
        blockedReasons,
        candidates: candidates.slice(0, 3),
      },
      error: {
        code: "NO_ROUTE",
        message: blockedReasons.join("; "),
        next: "Re-run later or lower the reserve with explicit operator approval",
      },
    });
    return;
  }

  if (bestCandidate) {
    printResult({
      status: "success",
      action: `Route ${maxRouteSats} sats to Bitflow HODLMM pool ${bestCandidate.poolId}`,
      data: {
        route: "deploy-to-hodlmm" as Route,
        wallet,
        reserve: {
          reserveSats: options.reserveSats,
          routeableSats,
          maxRouteSats,
        },
        candidate: bestCandidate,
        rationale: [
          `momentum signal ${bestCandidate.momentumSignal}`,
          `momentum score ${bestCandidate.momentumScore}`,
          `fee velocity ${bestCandidate.feeVelocity}x`,
          `24h volume $${bestCandidate.volumeUsd1d}`,
          `APR 24h ${bestCandidate.apr24h}%`,
        ],
      },
      error: null,
    });
    return;
  }

  if (zestReachable) {
    printResult({
      status: "success",
      action: `Route ${maxRouteSats} sats to Zest as the conservative fallback`,
      data: {
        route: "lend-to-zest" as Route,
        wallet,
        reserve: {
          reserveSats: options.reserveSats,
          routeableSats,
          maxRouteSats,
        },
        rationale: [
          "No HODLMM pool passed the configured timing gates",
          "Zest contract interface is reachable",
          "Excess sBTC remains after reserve protection",
        ],
        topCandidate: candidates[0] || null,
      },
      error: null,
    });
    return;
  }

  printResult({
    status: "blocked",
    action: "Hold idle sBTC until either HODLMM timing improves or Zest becomes reachable",
    data: {
      route: "hold",
      wallet,
      reserve: {
        reserveSats: options.reserveSats,
        routeableSats,
        maxRouteSats,
      },
      blockedReasons: [
        "No HODLMM candidate passed timing gates",
        "Zest fallback is unavailable",
      ],
      candidates: candidates.slice(0, 3),
    },
    error: {
      code: "NO_ROUTE",
      message: "No route passed the configured safety gates",
      next: "Re-run later or relax thresholds with explicit operator approval",
    },
  });
}

const program = new Command();

program
  .name("sbtc-yield-router")
  .description("Read-only router for idle sBTC across hold, Zest, and Bitflow HODLMM")
  .showHelpAfterError();

program
  .command("doctor")
  .description("Check wallet, Bitflow, and Zest readiness")
  .action(async () => {
    try {
      await runDoctor();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printFlatError(message);
    }
  });

program
  .command("status")
  .description("Return wallet reserve headroom and the best current HODLMM candidate")
  .option("--reserve-sats <sats>", "Operating reserve to protect", String(DEFAULT_RESERVE_SATS))
  .option("--max-route-sats <sats>", "Maximum route size per run", String(DEFAULT_MAX_ROUTE_SATS))
  .option("--min-hodlmm-score <score>", "Minimum HODLMM momentum score", String(DEFAULT_MIN_HODLMM_SCORE))
  .option("--min-hodlmm-volume-usd <usd>", "Minimum HODLMM 24h volume", String(DEFAULT_MIN_HODLMM_VOLUME_USD))
  .option("--min-hodlmm-tvl-usd <usd>", "Minimum HODLMM TVL", String(DEFAULT_MIN_HODLMM_TVL_USD))
  .action(async (rawOptions: Record<string, string | undefined>) => {
    try {
      const options: RunOptions = {
        reserveSats: toNumber(rawOptions.reserveSats),
        maxRouteSats: toNumber(rawOptions.maxRouteSats),
        minHodlmmScore: toNumber(rawOptions.minHodlmmScore),
        minHodlmmVolumeUsd: toNumber(rawOptions.minHodlmmVolumeUsd),
        minHodlmmTvlUsd: toNumber(rawOptions.minHodlmmTvlUsd),
      };
      await runStatus(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printFlatError(message);
    }
  });

program
  .command("run")
  .description("Route idle sBTC to hold, Zest, or Bitflow HODLMM")
  .option("--reserve-sats <sats>", "Operating reserve to protect", String(DEFAULT_RESERVE_SATS))
  .option("--max-route-sats <sats>", "Maximum route size per run", String(DEFAULT_MAX_ROUTE_SATS))
  .option("--min-hodlmm-score <score>", "Minimum HODLMM momentum score", String(DEFAULT_MIN_HODLMM_SCORE))
  .option("--min-hodlmm-volume-usd <usd>", "Minimum HODLMM 24h volume", String(DEFAULT_MIN_HODLMM_VOLUME_USD))
  .option("--min-hodlmm-tvl-usd <usd>", "Minimum HODLMM TVL", String(DEFAULT_MIN_HODLMM_TVL_USD))
  .action(async (rawOptions: Record<string, string | undefined>) => {
    try {
      const options: RunOptions = {
        reserveSats: toNumber(rawOptions.reserveSats),
        maxRouteSats: toNumber(rawOptions.maxRouteSats),
        minHodlmmScore: toNumber(rawOptions.minHodlmmScore),
        minHodlmmVolumeUsd: toNumber(rawOptions.minHodlmmVolumeUsd),
        minHodlmmTvlUsd: toNumber(rawOptions.minHodlmmTvlUsd),
      };

      if (options.reserveSats < 0 || options.maxRouteSats < 0) {
        printFlatError("reserve-sats and max-route-sats must be non-negative");
      }
      if (options.minHodlmmScore < 0 || options.minHodlmmVolumeUsd < 0 || options.minHodlmmTvlUsd < 0) {
        printFlatError("HODLMM thresholds must be non-negative");
      }

      await runRouter(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printFlatError(message);
    }
  });

program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printFlatError(message);
});
