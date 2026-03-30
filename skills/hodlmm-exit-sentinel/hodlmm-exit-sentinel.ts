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
const DEFAULT_MIN_VOLUME_USD = 25_000;
const DEFAULT_MAX_PRICE_DIVERGENCE_PCT = 1.0;
const DEFAULT_MAX_VOLATILITY_SCORE = 60;
const DEFAULT_REDUCE_DRIFT_BINS = 4;
const DEFAULT_EXIT_DRIFT_BINS = 12;
const DEFAULT_TOP_COUNT = 5;
// Empirically consistent with live Bitflow sBTC-USDCx bin prices on 2026-03-30.
const PRICE_SCALE = 1e8;

type SkillStatus = "success" | "error" | "blocked";
type PositionPosture = "hold" | "reduce" | "exit";
type Regime = "calm" | "elevated" | "crisis";

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

interface QuotePool {
  pool_id: string;
  token_x: string;
  token_y: string;
  active_bin: number;
  bin_step: number;
  pool_name?: string;
}

interface QuotePoolsResponse {
  pools?: QuotePool[];
}

interface QuoteBin {
  bin_id: number;
  reserve_x?: string;
  reserve_y?: string;
  liquidity?: string;
  price?: string;
}

interface QuoteBinsResponse {
  active_bin_id?: number;
  bins?: QuoteBin[];
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
  apr24h: number;
  sbtcIncentives?: boolean;
  tokens: {
    tokenX: AppToken;
    tokenY: AppToken;
  };
}

interface AppPoolsResponse {
  data?: AppPool[];
}

interface PositionBin {
  bin_id: number;
  user_liquidity?: string | number;
  liquidity?: string | number;
}

interface PositionResponse {
  detail?: string;
  bins?: PositionBin[];
  position_bins?: PositionBin[];
  positions?: {
    bins?: PositionBin[];
  };
}

interface WalletSnapshot {
  walletName: string;
  stacksAddress: string;
  bitcoinAddress: string | null;
  taprootAddress: string | null;
  stxUstx: number;
}

interface RunOptions {
  address?: string;
  poolId?: string;
  minVolumeUsd: number;
  maxPriceDivergencePct: number;
  reduceDriftBins: number;
  exitDriftBins: number;
  maxVolatilityScore: number;
  top: number;
}

interface PositionAssessment {
  poolId: string;
  poolName: string;
  positionBinCount: number;
  activeBinId: number;
  userBinRange: { min: number; max: number; bins: number[] };
  inRange: boolean;
  nearestBinOffset: number;
  avgBinOffset: number;
  positionLiquidity: number;
  volume24hUsd: number;
  tvlUsd: number;
  apr24h: number;
  marketPriceUsd: number;
  activeBinPriceUsd: number;
  priceDivergencePct: number;
  activeLiquidityShare: number;
  reserveImbalanceRatio: number;
  volatilityScore: number;
  regime: Regime;
  posture: PositionPosture;
  maxExitPct: number;
  reasons: string[];
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

function classifyRegime(score: number): Regime {
  if (score <= 30) return "calm";
  if (score <= 60) return "elevated";
  return "crisis";
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
        "User-Agent": "bff-skills/hodlmm-exit-sentinel",
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

async function getWalletSnapshot(addressOverride?: string): Promise<WalletSnapshot> {
  const wallet = loadActiveWallet();
  const stacksAddress = addressOverride || wallet.address;
  const usingOverride = Boolean(addressOverride && addressOverride !== wallet.address);
  const stxUstx = await getStxBalance(stacksAddress);

  return {
    walletName: usingOverride ? "external-address" : wallet.name || "aibtc-wallet",
    stacksAddress,
    bitcoinAddress: usingOverride ? null : wallet.btcAddress || null,
    taprootAddress: usingOverride ? null : wallet.taprootAddress || null,
    stxUstx,
  };
}

async function fetchQuotePools(): Promise<QuotePool[]> {
  const response = await fetchJson<QuotePoolsResponse>(`${BITFLOW_API}/api/quotes/v1/pools`);
  return response.pools ?? [];
}

async function fetchAppPools(): Promise<AppPool[]> {
  const response = await fetchJson<AppPoolsResponse>(`${BITFLOW_API}/api/app/v1/pools`);
  return response.data ?? [];
}

async function fetchBins(poolId: string): Promise<QuoteBinsResponse> {
  return fetchJson<QuoteBinsResponse>(`${BITFLOW_API}/api/quotes/v1/bins/${poolId}`);
}

async function fetchPositionBins(address: string, poolId: string): Promise<PositionBin[] | null> {
  const url = `${BITFLOW_API}/api/app/v1/users/${address}/positions/${poolId}/bins`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "bff-skills/hodlmm-exit-sentinel",
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  const payload = await response.json() as PositionResponse;

  if (payload.detail && payload.detail.toLowerCase().includes("no pool bins")) {
    return null;
  }

  const bins =
    Array.isArray(payload.bins) ? payload.bins :
    Array.isArray(payload.position_bins) ? payload.position_bins :
    Array.isArray(payload.positions?.bins) ? payload.positions?.bins ?? [] :
    [];

  const activeBins = bins.filter((bin) => toNumber(bin.user_liquidity ?? bin.liquidity) > 0);
  return activeBins.length > 0 ? activeBins : bins.length > 0 ? bins : null;
}

function isSbtcPool(quotePool: QuotePool, appPool?: AppPool): boolean {
  const tokens = [
    quotePool.token_x.toLowerCase(),
    quotePool.token_y.toLowerCase(),
    appPool?.tokens.tokenX.contract.toLowerCase() || "",
    appPool?.tokens.tokenY.contract.toLowerCase() || "",
    appPool?.tokens.tokenX.symbol?.toLowerCase() || "",
    appPool?.tokens.tokenY.symbol?.toLowerCase() || "",
  ];

  return tokens.some((token) => token.includes("sbtc"));
}

function getSbtcMarketPrice(appPool: AppPool): number {
  const tokenXIsSbtc =
    appPool.tokens.tokenX.contract.toLowerCase().includes("sbtc") ||
    appPool.tokens.tokenX.symbol?.toLowerCase() === "sbtc";

  return tokenXIsSbtc ? toNumber(appPool.tokens.tokenX.priceUsd) : toNumber(appPool.tokens.tokenY.priceUsd);
}

function getActiveSbtcPriceUsd(appPool: AppPool, activeBinPriceRaw: number): number {
  if (activeBinPriceRaw <= 0) return 0;

  const tokenX = appPool.tokens.tokenX;
  const tokenY = appPool.tokens.tokenY;
  const normalizedPrice =
    (activeBinPriceRaw / PRICE_SCALE) * Math.pow(10, tokenX.decimals - tokenY.decimals);
  const tokenXIsSbtc =
    tokenX.contract.toLowerCase().includes("sbtc") ||
    tokenX.symbol?.toLowerCase() === "sbtc";

  if (tokenXIsSbtc) {
    return normalizedPrice;
  }

  const tokenXPriceUsd = toNumber(tokenX.priceUsd);
  if (tokenXPriceUsd <= 0 || normalizedPrice <= 0) return 0;
  return tokenXPriceUsd / normalizedPrice;
}

function computePriceDivergencePct(appPool: AppPool, activeBinPriceRaw: number): number {
  const marketPrice = getSbtcMarketPrice(appPool);
  if (marketPrice <= 0 || activeBinPriceRaw <= 0) return 0;
  const activeBinPriceUsd = getActiveSbtcPriceUsd(appPool, activeBinPriceRaw);
  return Number((Math.abs(activeBinPriceUsd - marketPrice) / marketPrice * 100).toFixed(4));
}

function computeVolatilityMetrics(
  bins: QuoteBin[],
  activeBinId: number,
  binStep: number,
): { reserveImbalanceRatio: number; activeLiquidityShare: number; volatilityScore: number } {
  const nonEmptyBins = bins.filter((bin) => toNumber(bin.reserve_x) > 0 || toNumber(bin.reserve_y) > 0);
  if (nonEmptyBins.length === 0) {
    return { reserveImbalanceRatio: 1, activeLiquidityShare: 0, volatilityScore: 100 };
  }

  const totalX = nonEmptyBins.reduce((sum, bin) => sum + toNumber(bin.reserve_x), 0);
  const totalY = nonEmptyBins.reduce((sum, bin) => sum + toNumber(bin.reserve_y), 0);
  const totalLiquidity = nonEmptyBins.reduce((sum, bin) => sum + toNumber(bin.liquidity), 0);
  const activeBin = nonEmptyBins.find((bin) => bin.bin_id === activeBinId);
  const activeLiquidity = activeBin ? toNumber(activeBin.liquidity) : 0;
  const totalReserves = totalX + totalY;
  const imbalance = totalReserves > 0 ? Math.abs(totalX - totalY) / totalReserves : 1;
  const activeShare = totalLiquidity > 0 ? activeLiquidity / totalLiquidity : 0;

  const binIds = nonEmptyBins.map((bin) => bin.bin_id);
  const minBinId = Math.min(...binIds);
  const maxBinId = Math.max(...binIds);
  const priceRangeBps = (maxBinId - minBinId) * Math.max(binStep, 0);
  const normalizedSpread = priceRangeBps / 10_000;
  const spreadScore = clamp(normalizedSpread * 400, 0, 35);
  const imbalanceScore = clamp(imbalance * 35, 0, 35);
  const concentrationScore = clamp((1 - activeShare) * 30, 0, 30);
  const volatilityScore = Math.round(clamp(spreadScore + imbalanceScore + concentrationScore, 0, 100));

  return {
    reserveImbalanceRatio: Number(imbalance.toFixed(4)),
    activeLiquidityShare: Number(activeShare.toFixed(4)),
    volatilityScore,
  };
}

function assessPosition(
  quotePool: QuotePool,
  appPool: AppPool,
  binsResponse: QuoteBinsResponse,
  positionBins: PositionBin[],
  options: RunOptions,
): PositionAssessment {
  const activeBinId = binsResponse.active_bin_id ?? quotePool.active_bin;
  const quoteBins = binsResponse.bins ?? [];
  const userBinIds = positionBins.map((bin) => bin.bin_id);
  const uniqueBinIds = [...new Set(userBinIds)].sort((a, b) => a - b);
  const nearestBinOffset = uniqueBinIds.reduce(
    (min, binId) => Math.min(min, Math.abs(binId - activeBinId)),
    Number.POSITIVE_INFINITY,
  );
  const avgBinOffset = uniqueBinIds.reduce((sum, binId) => sum + Math.abs(binId - activeBinId), 0) / uniqueBinIds.length;
  const inRange = uniqueBinIds.includes(activeBinId);
  const positionLiquidity = positionBins.reduce((sum, bin) => sum + toNumber(bin.user_liquidity ?? bin.liquidity), 0);
  const activeBin = quoteBins.find((bin) => bin.bin_id === activeBinId);
  const activeBinPriceRaw = toNumber(activeBin?.price);
  const priceDivergencePct = computePriceDivergencePct(appPool, activeBinPriceRaw);
  const metrics = computeVolatilityMetrics(quoteBins, activeBinId, quotePool.bin_step);
  const regime = classifyRegime(metrics.volatilityScore);

  const reasons: string[] = [];
  let posture: PositionPosture = "hold";
  let maxExitPct = 0;

  if (nearestBinOffset >= options.exitDriftBins) {
    reasons.push(`nearest bin offset ${nearestBinOffset} >= exit threshold ${options.exitDriftBins}`);
  }
  if (priceDivergencePct > options.maxPriceDivergencePct * 1.5) {
    reasons.push(
      `price divergence ${priceDivergencePct.toFixed(4)}% > hard exit threshold ${(options.maxPriceDivergencePct * 1.5).toFixed(4)}%`,
    );
  }
  if (appPool.volumeUsd1d < options.minVolumeUsd * 0.5) {
    reasons.push(`24h volume ${appPool.volumeUsd1d.toFixed(2)} < hard floor ${(options.minVolumeUsd * 0.5).toFixed(2)}`);
  }
  if (metrics.volatilityScore > options.maxVolatilityScore + 20) {
    reasons.push(`volatility score ${metrics.volatilityScore} > hard ceiling ${options.maxVolatilityScore + 20}`);
  }

  if (reasons.length > 0) {
    posture = "exit";
    maxExitPct = 1;
  } else {
    if (!inRange) {
      reasons.push("position is out of range");
    }
    if (nearestBinOffset >= options.reduceDriftBins) {
      reasons.push(`nearest bin offset ${nearestBinOffset} >= reduce threshold ${options.reduceDriftBins}`);
    }
    if (priceDivergencePct > options.maxPriceDivergencePct) {
      reasons.push(`price divergence ${priceDivergencePct.toFixed(4)}% > ${options.maxPriceDivergencePct}%`);
    }
    if (appPool.volumeUsd1d < options.minVolumeUsd) {
      reasons.push(`24h volume ${appPool.volumeUsd1d.toFixed(2)} < ${options.minVolumeUsd}`);
    }
    if (metrics.volatilityScore > options.maxVolatilityScore) {
      reasons.push(`volatility score ${metrics.volatilityScore} > ${options.maxVolatilityScore}`);
    }

    if (reasons.length > 0) {
      posture = "reduce";
      maxExitPct = 0.5;
    }
  }

  return {
    poolId: quotePool.pool_id,
    poolName: quotePool.pool_name || appPool.poolId,
    positionBinCount: uniqueBinIds.length,
    activeBinId,
    userBinRange: {
      min: uniqueBinIds[0],
      max: uniqueBinIds[uniqueBinIds.length - 1],
      bins: uniqueBinIds,
    },
    inRange,
    nearestBinOffset,
    avgBinOffset: Number(avgBinOffset.toFixed(2)),
    positionLiquidity,
    volume24hUsd: Number(appPool.volumeUsd1d.toFixed(2)),
    tvlUsd: Number(appPool.tvlUsd.toFixed(2)),
    apr24h: Number(appPool.apr24h.toFixed(2)),
    marketPriceUsd: Number(getSbtcMarketPrice(appPool).toFixed(2)),
    activeBinPriceUsd: Number(getActiveSbtcPriceUsd(appPool, activeBinPriceRaw).toFixed(2)),
    priceDivergencePct,
    activeLiquidityShare: metrics.activeLiquidityShare,
    reserveImbalanceRatio: metrics.reserveImbalanceRatio,
    volatilityScore: metrics.volatilityScore,
    regime,
    posture,
    maxExitPct,
    reasons: reasons.length > 0 ? reasons : ["position is healthy under the configured safety gates"],
  };
}

async function collectPositionAssessments(options: RunOptions): Promise<{
  wallet: WalletSnapshot;
  assessments: PositionAssessment[];
  poolsScanned: number;
}> {
  const wallet = await getWalletSnapshot(options.address);
  const [quotePools, appPools] = await Promise.all([fetchQuotePools(), fetchAppPools()]);
  const appPoolMap = new Map(appPools.map((pool) => [pool.poolId, pool]));

  const targetPools = quotePools.filter((quotePool) => {
    const appPool = appPoolMap.get(quotePool.pool_id);
    if (!appPool || !appPool.poolStatus) return false;
    if (options.poolId && options.poolId !== quotePool.pool_id) return false;
    return isSbtcPool(quotePool, appPool);
  });

  const assessments: PositionAssessment[] = [];

  await Promise.all(
    targetPools.map(async (quotePool) => {
      const appPool = appPoolMap.get(quotePool.pool_id);
      if (!appPool) return;

      const positionBins = await fetchPositionBins(wallet.stacksAddress, quotePool.pool_id);
      if (!positionBins || positionBins.length === 0) return;

      const binsResponse = await fetchBins(quotePool.pool_id);
      assessments.push(assessPosition(quotePool, appPool, binsResponse, positionBins, options));
    }),
  );

  const severityRank: Record<PositionPosture, number> = { exit: 3, reduce: 2, hold: 1 };
  assessments.sort((left, right) => {
    const severityDelta = severityRank[right.posture] - severityRank[left.posture];
    if (severityDelta !== 0) return severityDelta;
    return right.priceDivergencePct - left.priceDivergencePct;
  });

  return { wallet, assessments, poolsScanned: targetPools.length };
}

function summarizeAssessment(assessment: PositionAssessment): Record<string, unknown> {
  return {
    poolId: assessment.poolId,
    poolName: assessment.poolName,
    posture: assessment.posture,
    maxExitPct: assessment.maxExitPct,
    positionBinCount: assessment.positionBinCount,
    activeBinId: assessment.activeBinId,
    userBinRange: assessment.userBinRange,
    inRange: assessment.inRange,
    nearestBinOffset: assessment.nearestBinOffset,
    avgBinOffset: assessment.avgBinOffset,
    priceDivergencePct: assessment.priceDivergencePct,
    activeLiquidityShare: assessment.activeLiquidityShare,
    reserveImbalanceRatio: assessment.reserveImbalanceRatio,
    volume24hUsd: assessment.volume24hUsd,
    tvlUsd: assessment.tvlUsd,
    apr24h: assessment.apr24h,
    volatilityScore: assessment.volatilityScore,
    regime: assessment.regime,
    reasons: assessment.reasons,
  };
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
      const stxUstx = await getStxBalance(wallet.address);
      checks.stx_gas = { ok: stxUstx >= MIN_GAS_USTX, detail: `${stxUstx} uSTX available` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.stx_gas = { ok: false, detail: message };
    }
  }

  try {
    const pools = await fetchAppPools();
    const count = pools.filter((pool) => pool.tokens.tokenX.symbol?.toLowerCase() === "sbtc" || pool.tokens.tokenY.symbol?.toLowerCase() === "sbtc").length;
    checks.bitflow_pools = { ok: count > 0, detail: `${count} sBTC-involved pools discovered` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.bitflow_pools = { ok: false, detail: message };
  }

  const allOk = Object.values(checks).every((check) => check.ok);
  if (allOk) {
    printResult({
      status: "success",
      action: "Environment ready. Run status or run to inspect deployed sBTC HODLMM positions.",
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
    action: "Resolve the reported blockers before running the sentinel.",
    data: { checks, blockers },
    error: {
      code: "DOCTOR_FAILED",
      message: blockers.join("; "),
      next: "Resolve the failed checks and re-run doctor",
    },
  });
}

async function runStatus(): Promise<void> {
  const options: RunOptions = {
    minVolumeUsd: DEFAULT_MIN_VOLUME_USD,
    maxPriceDivergencePct: DEFAULT_MAX_PRICE_DIVERGENCE_PCT,
    reduceDriftBins: DEFAULT_REDUCE_DRIFT_BINS,
    exitDriftBins: DEFAULT_EXIT_DRIFT_BINS,
    maxVolatilityScore: DEFAULT_MAX_VOLATILITY_SCORE,
    top: DEFAULT_TOP_COUNT,
  };

  const { wallet, assessments, poolsScanned } = await collectPositionAssessments(options);
  const highestSeverity = assessments[0]?.posture || null;

  printResult({
    status: "success",
    action: assessments.length > 0
      ? `Found ${assessments.length} sBTC-involved HODLMM positions. Highest severity: ${highestSeverity}`
      : "No sBTC-involved HODLMM LP positions found for this address.",
    data: {
      wallet,
      poolsScanned,
      positionsFound: assessments.length,
      highestSeverity,
      positions: assessments.slice(0, DEFAULT_TOP_COUNT).map(summarizeAssessment),
    },
    error: null,
  });
}

async function runSentinel(options: RunOptions): Promise<void> {
  const { wallet, assessments, poolsScanned } = await collectPositionAssessments(options);

  if (assessments.length === 0) {
    printResult({
      status: "blocked",
      action: "No sBTC-involved HODLMM LP positions were found for the requested address.",
      data: {
        wallet,
        poolsScanned,
        positionsFound: 0,
      },
      error: {
        code: "NO_POSITIONS",
        message: "No sBTC-involved HODLMM LP positions were found",
        next: "Pass a different --address or deploy capital before using this sentinel",
      },
    });
    return;
  }

  const highestSeverity = assessments[0];
  const action =
    highestSeverity.posture === "exit"
      ? `Exit from ${highestSeverity.poolId}`
      : highestSeverity.posture === "reduce"
      ? `Reduce exposure in ${highestSeverity.poolId}`
      : `Hold current HODLMM positions`;

  printResult({
    status: "success",
    action,
    data: {
      wallet,
      summary: {
        poolsScanned,
        positionsFound: assessments.length,
        highestSeverity: highestSeverity.posture,
      },
      positions: assessments.slice(0, Math.max(1, options.top)).map(summarizeAssessment),
    },
    error: null,
  });
}

const program = new Command();

program
  .name("hodlmm-exit-sentinel")
  .description("Read-only safety sentinel for deployed sBTC-involved Bitflow HODLMM positions")
  .showHelpAfterError();

program
  .command("doctor")
  .description("Check wallet and Bitflow readiness")
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
  .description("Return a snapshot of sBTC-involved HODLMM positions for the current address")
  .action(async () => {
    try {
      await runStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printFlatError(message);
    }
  });

program
  .command("run")
  .description("Evaluate deployed positions and emit hold/reduce/exit posture")
  .option("--address <stxAddress>", "Override the active wallet Stacks address")
  .option("--pool-id <poolId>", "Restrict evaluation to a single pool")
  .option("--min-volume-usd <usd>", "Minimum healthy 24h volume in USD", String(DEFAULT_MIN_VOLUME_USD))
  .option(
    "--max-price-divergence-pct <pct>",
    "Maximum healthy active-bin price divergence percentage",
    String(DEFAULT_MAX_PRICE_DIVERGENCE_PCT),
  )
  .option("--reduce-drift-bins <count>", "Nearest-bin offset that triggers reduce posture", String(DEFAULT_REDUCE_DRIFT_BINS))
  .option("--exit-drift-bins <count>", "Nearest-bin offset that triggers exit posture", String(DEFAULT_EXIT_DRIFT_BINS))
  .option("--max-volatility-score <score>", "Maximum healthy volatility score", String(DEFAULT_MAX_VOLATILITY_SCORE))
  .option("--top <count>", "How many position assessments to include in output", String(DEFAULT_TOP_COUNT))
  .action(async (rawOptions: Record<string, string | undefined>) => {
    try {
      const options: RunOptions = {
        address: rawOptions.address,
        poolId: rawOptions.poolId,
        minVolumeUsd: toNumber(rawOptions.minVolumeUsd),
        maxPriceDivergencePct: toNumber(rawOptions.maxPriceDivergencePct),
        reduceDriftBins: Math.max(1, Math.floor(toNumber(rawOptions.reduceDriftBins))),
        exitDriftBins: Math.max(1, Math.floor(toNumber(rawOptions.exitDriftBins))),
        maxVolatilityScore: toNumber(rawOptions.maxVolatilityScore),
        top: Math.max(1, Math.floor(toNumber(rawOptions.top) || DEFAULT_TOP_COUNT)),
      };

      if (options.address && !/^SP[A-Z0-9]{30,}$/i.test(options.address)) {
        printFlatError("address must be a valid Stacks mainnet address");
      }
      if (options.poolId && !/^[A-Za-z0-9_-]+$/.test(options.poolId)) {
        printFlatError("pool-id must be alphanumeric");
      }
      if (options.maxPriceDivergencePct <= 0) {
        printFlatError("max-price-divergence-pct must be positive");
      }
      if (options.exitDriftBins < options.reduceDriftBins) {
        printFlatError("exit-drift-bins must be greater than or equal to reduce-drift-bins");
      }
      if (options.minVolumeUsd < 0 || options.maxVolatilityScore < 0) {
        printFlatError("numeric thresholds must be non-negative");
      }

      await runSentinel(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printFlatError(message);
    }
  });

program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printFlatError(message);
});
