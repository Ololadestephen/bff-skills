#!/usr/bin/env bun

import { Command } from "commander";
import { homedir } from "os";
import { join } from "path";
import { getBitflowService } from "@aibtc/mcp-server/dist/services/bitflow.service.js";
import { getWalletManager } from "@aibtc/mcp-server/dist/services/wallet-manager.js";
import { getExplorerTxUrl } from "@aibtc/mcp-server/dist/config/networks.js";

const NETWORK = "mainnet";
const HIRO_API = "https://api.mainnet.hiro.so";
const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1/pools";
const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1/pools";
const BITFLOW_BINS_API = "https://bff.bitflowapis.finance/api/quotes/v1/bins";
const BITFLOW_PUBLIC_HOST = "https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev";
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const USDCX_CONTRACT = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const BITFLOW_SBTC_ID = "token-sbtc";
const BITFLOW_USDCX_ID = "token-USDCx-auto";
const FETCH_TIMEOUT_MS = 30_000;
const PRICE_SCALE = 1e8;
const DEFAULT_MAX_REDUCE_SATS = 150n;
const DEFAULT_RESERVE_SATS = 100n;
const DEFAULT_TRIGGER_RISK_SCORE = 35;
const DEFAULT_MIN_VOLUME_USD = 100;
const DEFAULT_MIN_GAS_RESERVE_USTX = 100_000n;
const DEFAULT_SLIPPAGE_BPS = 300;
const DEFAULT_MIN_RECEIVE_BASE = 1n;
const DEFAULT_COOLDOWN_HOURS = 4;
const CONFIRM_TOKEN = "REDUCE";
const STATE_FILE = join(homedir(), ".hodlmm-position-reducer-state.json");

type SkillStatus = "success" | "error" | "blocked";

interface SkillOutput {
  status: SkillStatus;
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface WalletMetadata {
  id: string;
  name?: string;
  address: string;
  btcAddress?: string;
  taprootAddress?: string;
  network?: string;
}

interface HiroStxResponse {
  balance: string;
  locked: string;
}

interface HiroBalancesResponse {
  fungible_tokens?: Record<string, { balance: string }>;
}

interface QuotePool {
  pool_id: string;
  token_x: string;
  token_y: string;
  bin_step: number;
  active_bin: number;
  pool_name?: string;
  pool_symbol?: string;
}

interface BinRecord {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity?: string;
}

interface BinsResponse {
  success?: boolean;
  pool_id?: string;
  bins?: BinRecord[];
}

interface AppPoolToken {
  contract: string;
  displayName?: string;
  symbol?: string;
  decimals: number;
  priceUsd: number;
}

interface AppPool {
  poolId: string;
  tvlUsd: number;
  volumeUsd1d: number;
  feesUsd1d: number;
  feesUsd7d: number;
  apr24h: number;
  binStep: number;
  poolComposition?: {
    tokenX?: { percentage?: number };
    tokenY?: { percentage?: number };
  };
  tokens: {
    tokenX: AppPoolToken;
    tokenY: AppPoolToken;
  };
}

interface AppPoolsResponse {
  data?: AppPool[];
}

interface QuoteResult {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedAmountOut: string;
  route: string[];
  priceImpact?: {
    combinedImpact: number;
    combinedImpactPct: string;
    severity: string;
  };
}

interface ReducerState {
  lastReductionAt?: string;
  lastTxid?: string;
  lastPoolId?: string;
}

interface CooldownResult {
  ok: boolean;
  remainingHours: number;
  lastReductionAt: string | null;
}

interface AssessedPool {
  poolId: string;
  pair: string;
  activeBin: number;
  riskScore: number;
  regime: "calm" | "elevated" | "crisis";
  volumeUsd1d: number;
  tvlUsd: number;
  apr24h: number;
  divergencePct: number;
  reserveImbalancePct: number;
  volatilityScore: number;
  liquidityConcentrationPct: number;
  triggers: string[];
}

interface RunOptions {
  walletId?: string;
  poolId?: string;
  maxReduceSats: bigint;
  reserveSats: bigint;
  triggerRiskScore: number;
  minVolumeUsd: number;
  minGasReserveUstx: bigint;
  slippageBps: number;
  minReceiveBase: bigint;
  cooldownHours: number;
  confirm?: string;
}

interface Context {
  wallet: WalletMetadata;
  stxUstx: bigint;
  sbtcSats: bigint;
  reduceSats: bigint;
  cooldown: CooldownResult;
  topPool: AssessedPool | null;
  highestRiskPool: AssessedPool | null;
  candidatePools: AssessedPool[];
  quote: QuoteResult | null;
  minAmountOutBase: bigint;
  canReduce: boolean;
  blockers: string[];
}

function printFlatError(message: string): never {
  console.log(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

function printResult(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function toBigInt(value: string | number | bigint | undefined | null): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function parseBigIntOption(value: string | undefined, fallback: bigint, flag: string): bigint {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    printFlatError(`${flag} must not be empty`);
  }
  try {
    return BigInt(trimmed);
  } catch {
    printFlatError(`${flag} must be an integer value`);
  }
}

function parseNumberOption(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    printFlatError(`${flag} must not be empty`);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    printFlatError(`${flag} must be a numeric value`);
  }
  return parsed;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "bff-skills/hodlmm-position-reducer",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveWallet(walletId?: string): Promise<WalletMetadata> {
  const manager = getWalletManager();
  const wallets = (await manager.listWallets()) as WalletMetadata[];
  if (wallets.length === 0) {
    throw new Error("No AIBTC wallets found");
  }

  if (walletId) {
    const selected = wallets.find((wallet) => wallet.id === walletId);
    if (!selected) {
      throw new Error(`Wallet ${walletId} not found`);
    }
    if (selected.network !== NETWORK) {
      throw new Error(`Wallet ${walletId} is not on ${NETWORK}`);
    }
    return selected;
  }

  const activeWalletId = await manager.getActiveWalletId();
  if (!activeWalletId) {
    throw new Error("No active AIBTC wallet set");
  }
  const active = wallets.find((wallet) => wallet.id === activeWalletId);
  if (!active) {
    throw new Error("Active AIBTC wallet could not be resolved");
  }
  if (active.network !== NETWORK) {
    throw new Error(`Active wallet is not on ${NETWORK}`);
  }
  return active;
}

async function getStxBalance(address: string): Promise<bigint> {
  const data = await fetchJson<HiroStxResponse>(`${HIRO_API}/extended/v1/address/${address}/stx`);
  const balance = toBigInt(data.balance);
  const locked = toBigInt(data.locked);
  return balance > locked ? balance - locked : 0n;
}

async function getSbtcBalance(address: string): Promise<bigint> {
  const data = await fetchJson<HiroBalancesResponse>(`${HIRO_API}/extended/v1/address/${address}/balances`);
  const key = Object.keys(data.fungible_tokens || {}).find((entry) => entry.startsWith(SBTC_CONTRACT));
  return toBigInt(key ? data.fungible_tokens?.[key]?.balance : "0");
}

async function fetchQuotePools(): Promise<QuotePool[]> {
  const data = await fetchJson<{ pools?: QuotePool[] }>(BITFLOW_QUOTES_API);
  return (data.pools || []).filter((pool) => pool.token_x === SBTC_CONTRACT || pool.token_y === SBTC_CONTRACT);
}

async function fetchAppPools(): Promise<AppPool[]> {
  const data = await fetchJson<AppPoolsResponse>(BITFLOW_APP_API);
  return (data.data || []).filter(
    (pool) => pool.tokens.tokenX.contract === SBTC_CONTRACT || pool.tokens.tokenY.contract === SBTC_CONTRACT
  );
}

async function fetchBins(poolId: string): Promise<BinRecord[]> {
  const data = await fetchJson<BinsResponse>(`${BITFLOW_BINS_API}/${poolId}`);
  return data.bins || [];
}

async function readState(): Promise<ReducerState> {
  try {
    const file = Bun.file(STATE_FILE);
    if (!(await file.exists())) {
      return {};
    }
    return JSON.parse(await file.text()) as ReducerState;
  } catch {
    return {};
  }
}

async function writeState(state: ReducerState): Promise<void> {
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

async function checkCooldown(cooldownHours: number): Promise<CooldownResult> {
  const state = await readState();
  if (!state.lastReductionAt) {
    return { ok: true, remainingHours: 0, lastReductionAt: null };
  }
  const elapsed = (Date.now() - new Date(state.lastReductionAt).getTime()) / 3_600_000;
  const remaining = Math.max(0, cooldownHours - elapsed);
  return {
    ok: remaining === 0,
    remainingHours: Number(remaining.toFixed(2)),
    lastReductionAt: state.lastReductionAt,
  };
}

function normalizeBinPrice(binPriceRaw: string, quotePool: QuotePool, appPool: AppPool): number {
  const raw = Number(binPriceRaw);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const normalized = (raw / PRICE_SCALE) * Math.pow(10, appPool.tokens.tokenX.decimals - appPool.tokens.tokenY.decimals);
  const tokenXIsSbtc = quotePool.token_x === SBTC_CONTRACT;
  if (tokenXIsSbtc) {
    return normalized * appPool.tokens.tokenY.priceUsd;
  }
  if (normalized === 0) return 0;
  return appPool.tokens.tokenX.priceUsd / normalized;
}

function classifyRisk(score: number): "calm" | "elevated" | "crisis" {
  if (score < 35) return "calm";
  if (score < 65) return "elevated";
  return "crisis";
}

function computePoolAssessment(quotePool: QuotePool, appPool: AppPool, bins: BinRecord[]): AssessedPool {
  const activeBin = bins.find((bin) => bin.bin_id === quotePool.active_bin) || null;
  const activeBinPriceUsd = activeBin ? normalizeBinPrice(activeBin.price, quotePool, appPool) : 0;
  const marketSbtcPriceUsd =
    appPool.tokens.tokenX.contract === SBTC_CONTRACT ? appPool.tokens.tokenX.priceUsd : appPool.tokens.tokenY.priceUsd;
  const divergencePct =
    marketSbtcPriceUsd > 0 && activeBinPriceUsd > 0
      ? (Math.abs(activeBinPriceUsd - marketSbtcPriceUsd) / marketSbtcPriceUsd) * 100
      : 0;

  const nonEmptyBins = bins.filter((bin) => toBigInt(bin.reserve_x) > 0n || toBigInt(bin.reserve_y) > 0n);
  const binIds = nonEmptyBins.map((bin) => bin.bin_id);
  const minBin = binIds.length > 0 ? Math.min(...binIds) : quotePool.active_bin;
  const maxBin = binIds.length > 0 ? Math.max(...binIds) : quotePool.active_bin;
  const volatilityScore = Math.min(((maxBin - minBin) * quotePool.bin_step) / 2, 100);

  let totalX = 0;
  let totalY = 0;
  for (const bin of nonEmptyBins) {
    totalX += Number(bin.reserve_x);
    totalY += Number(bin.reserve_y);
  }
  const totalReserves = totalX + totalY;
  const reserveImbalancePct = totalReserves > 0 ? (Math.abs(totalX - totalY) / totalReserves) * 100 : 0;
  const liquidityConcentrationPct = Math.max(
    appPool.poolComposition?.tokenX?.percentage || 0,
    appPool.poolComposition?.tokenY?.percentage || 0
  );
  const lowVolumePenalty = appPool.volumeUsd1d < 250 ? 20 : appPool.volumeUsd1d < 1_000 ? 10 : 0;
  const riskScore = Math.min(
    divergencePct * 1.5 +
      volatilityScore * 0.45 +
      reserveImbalancePct * 0.3 +
      Math.max(liquidityConcentrationPct - 50, 0) * 0.2 +
      lowVolumePenalty,
    100
  );

  const triggers: string[] = [];
  if (divergencePct >= 1) triggers.push(`price divergence ${divergencePct.toFixed(2)}%`);
  if (volatilityScore >= 25) triggers.push(`volatility ${volatilityScore.toFixed(2)}`);
  if (reserveImbalancePct >= 60) triggers.push(`reserve imbalance ${reserveImbalancePct.toFixed(2)}%`);
  if (appPool.volumeUsd1d < 250) triggers.push(`24h volume ${appPool.volumeUsd1d.toFixed(2)} < 250`);

  return {
    poolId: quotePool.pool_id,
    pair: appPool.tokens.tokenX.symbol === "sBTC"
      ? `sBTC-${appPool.tokens.tokenY.symbol}`
      : `${appPool.tokens.tokenX.symbol}-sBTC`,
    activeBin: quotePool.active_bin,
    riskScore: Number(riskScore.toFixed(2)),
    regime: classifyRisk(riskScore),
    volumeUsd1d: appPool.volumeUsd1d,
    tvlUsd: appPool.tvlUsd,
    apr24h: appPool.apr24h,
    divergencePct: Number(divergencePct.toFixed(4)),
    reserveImbalancePct: Number(reserveImbalancePct.toFixed(4)),
    volatilityScore: Number(volatilityScore.toFixed(4)),
    liquidityConcentrationPct: Number(liquidityConcentrationPct.toFixed(2)),
    triggers,
  };
}

async function assessPools(poolId?: string): Promise<AssessedPool[]> {
  const [quotePools, appPools] = await Promise.all([fetchQuotePools(), fetchAppPools()]);
  const appPoolMap = new Map(appPools.map((pool) => [pool.poolId, pool]));
  const candidates = poolId ? quotePools.filter((pool) => pool.pool_id === poolId) : quotePools;

  const assessed = await Promise.all(
    candidates.map(async (quotePool) => {
      const appPool = appPoolMap.get(quotePool.pool_id) || appPoolMap.get(quotePool.pool_id.replace("dlmm_2", "dlmm_1"));
      if (!appPool) return null;
      const bins = await fetchBins(quotePool.pool_id);
      return computePoolAssessment(quotePool, appPool, bins);
    })
  );

  return assessed
    .filter((pool): pool is AssessedPool => Boolean(pool))
    .sort((a, b) => b.riskScore - a.riskScore);
}

function satsToHumanSbtc(sats: bigint): number {
  return Number(sats) / 100_000_000;
}

function parseHumanToBaseUnits(amount: string, decimals: number): bigint {
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return 0n;
  }
  const [whole, fraction = ""] = normalized.split(".");
  const padded = `${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`;
  return BigInt(padded);
}

function computeMinAmountOutBase(expectedAmountOut: string, slippageBps: number): bigint {
  const quoted = parseHumanToBaseUnits(expectedAmountOut, 6);
  if (quoted <= 0n) return 0n;
  const numerator = BigInt(10_000 - slippageBps);
  const discounted = (quoted * numerator) / 10_000n;
  return discounted > 0n ? discounted : 1n;
}

async function collectContext(options: RunOptions): Promise<Context> {
  process.env.BITFLOW_API_HOST ||= BITFLOW_PUBLIC_HOST;
  const wallet = await resolveWallet(options.walletId);
  const [stxUstx, sbtcSats, candidatePools, cooldown] = await Promise.all([
    getStxBalance(wallet.address),
    getSbtcBalance(wallet.address),
    assessPools(options.poolId),
    checkCooldown(options.cooldownHours),
  ]);
  const highestRiskPool = candidatePools[0] || null;
  const topPool =
    candidatePools.find((pool) => pool.volumeUsd1d >= options.minVolumeUsd) ||
    highestRiskPool;
  const routeableSats = sbtcSats > options.reserveSats ? sbtcSats - options.reserveSats : 0n;
  const reduceSats = routeableSats > options.maxReduceSats ? options.maxReduceSats : routeableSats;

  let quote: QuoteResult | null = null;
  let minAmountOutBase = 0n;
  if (reduceSats > 0n) {
    const bitflow = getBitflowService(NETWORK);
    quote = await bitflow.getSwapQuote(BITFLOW_SBTC_ID, BITFLOW_USDCX_ID, satsToHumanSbtc(reduceSats)) as QuoteResult;
    minAmountOutBase = computeMinAmountOutBase(quote.expectedAmountOut, options.slippageBps);
  }

  const blockers: string[] = [];
  if (wallet.network !== NETWORK) {
    blockers.push(`Wallet network ${wallet.network || "unknown"} is not ${NETWORK}`);
  }
  if (!cooldown.ok) {
    blockers.push(`Cooldown active for another ${cooldown.remainingHours} hours`);
  }
  if (sbtcSats <= options.reserveSats) {
    blockers.push(`sBTC balance ${sbtcSats.toString()} sats does not exceed reserve ${options.reserveSats.toString()} sats`);
  }
  if (reduceSats <= 0n) {
    blockers.push("No sBTC remains available for reduction after reserve and max-reduce caps");
  }
  if (stxUstx < options.minGasReserveUstx) {
    blockers.push(`STX balance ${stxUstx.toString()} uSTX is below the gas reserve ${options.minGasReserveUstx.toString()} uSTX`);
  }
  if (!topPool) {
    blockers.push("No sBTC HODLMM pool assessment was available");
  } else {
    if (topPool.riskScore < options.triggerRiskScore) {
      blockers.push(`Top pool risk ${topPool.riskScore} is below trigger ${options.triggerRiskScore}`);
    }
    if (topPool.volumeUsd1d < options.minVolumeUsd) {
      blockers.push(`Top pool 24h volume ${topPool.volumeUsd1d.toFixed(2)} is below ${options.minVolumeUsd}`);
    }
  }
  if (quote && quote.expectedAmountOut === "0") {
    blockers.push(`Reduction amount ${reduceSats.toString()} sats quotes 0 USDCx output`);
  }
  if (quote && minAmountOutBase < options.minReceiveBase) {
    blockers.push(`Minimum output ${minAmountOutBase.toString()} base units < required ${options.minReceiveBase.toString()}`);
  }

  return {
    wallet,
    stxUstx,
    sbtcSats,
    reduceSats,
    cooldown,
    topPool,
    highestRiskPool,
    candidatePools,
    quote,
    minAmountOutBase,
    canReduce: blockers.length === 0,
    blockers,
  };
}

async function runDoctor(options: RunOptions): Promise<void> {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  try {
    const context = await collectContext(options);
    checks.wallet = {
      ok: true,
      detail: `${context.wallet.address} (${context.wallet.btcAddress || "no btc"})`,
    };
    checks.balances = {
      ok: true,
      detail: `stx=${context.stxUstx.toString()} uSTX, sbtc=${context.sbtcSats.toString()} sats`,
    };
    checks.cooldown = {
      ok: context.cooldown.ok,
      detail: context.cooldown.ok
        ? "No active reduction cooldown"
        : `Cooldown active for ${context.cooldown.remainingHours} more hours`,
    };
    checks.pool = {
      ok: Boolean(context.topPool),
      detail: context.topPool
        ? `${context.topPool.poolId} risk=${context.topPool.riskScore} regime=${context.topPool.regime}`
        : "No sBTC HODLMM pool available",
    };
    checks.quote = {
      ok: Boolean(context.quote && context.quote.expectedAmountOut !== "0"),
      detail: context.quote
        ? `${context.reduceSats.toString()} sats -> ${context.quote.expectedAmountOut} USDCx`
        : "No quote available",
    };
    checks.password_env = {
      ok: Boolean(process.env.AIBTC_WALLET_PASSWORD),
      detail: process.env.AIBTC_WALLET_PASSWORD
        ? "AIBTC_WALLET_PASSWORD is set"
        : "AIBTC_WALLET_PASSWORD not set (required only for run)",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.context = { ok: false, detail: message };
  }

  const allOk = Object.values(checks).every((check) => check.ok);
  const blockers = Object.entries(checks)
    .filter(([, check]) => !check.ok)
    .map(([name, check]) => `${name}: ${check.detail}`);

  if (allOk) {
    printResult({
      status: "success",
      action: "Environment ready. Run status to inspect the reduction plan or run with --confirm=REDUCE to execute.",
      data: { checks },
      error: null,
    });
    return;
  }

  printResult({
    status: "blocked",
    action: "Resolve the reported blockers before executing a HODLMM-linked reduction.",
    data: { checks, blockers },
    error: {
      code: "DOCTOR_FAILED",
      message: blockers.join("; "),
      next: "Resolve the failed checks and re-run doctor",
    },
  });
}

async function runStatus(options: RunOptions): Promise<void> {
  const context = await collectContext(options);
  printResult({
    status: "success",
    action: context.canReduce
      ? `Reduce ${context.reduceSats.toString()} sats from sBTC into USDCx because ${context.topPool?.poolId || "the monitored pool"} breached the configured risk trigger.`
      : "HODLMM-linked reduction is currently blocked by one or more safety gates.",
    data: {
      wallet: context.wallet,
      balances: {
        stxUstx: context.stxUstx.toString(),
        sbtcSats: context.sbtcSats.toString(),
      },
      reductionPlan: {
        reserveSats: options.reserveSats.toString(),
        maxReduceSats: options.maxReduceSats.toString(),
        reduceSats: context.reduceSats.toString(),
        minGasReserveUstx: options.minGasReserveUstx.toString(),
      },
      cooldown: context.cooldown,
      highestRiskPool: context.highestRiskPool,
      topPool: context.topPool,
      candidates: context.candidatePools,
      quote: context.quote
        ? {
            expectedAmountOut: context.quote.expectedAmountOut,
            route: context.quote.route,
            priceImpact: context.quote.priceImpact,
            minAmountOutBase: context.minAmountOutBase.toString(),
          }
        : null,
      canReduce: context.canReduce,
      blockers: context.blockers,
    },
    error: null,
  });
}

async function runReduce(options: RunOptions): Promise<void> {
  if (options.confirm !== CONFIRM_TOKEN) {
    printResult({
      status: "blocked",
      action: `Re-run with --confirm=${CONFIRM_TOKEN} after explicit operator approval.`,
      data: {},
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: "This write skill requires explicit confirmation before broadcast",
        next: `Re-run with --confirm=${CONFIRM_TOKEN}`,
      },
    });
    return;
  }

  const password = process.env.AIBTC_WALLET_PASSWORD;
  if (!password) {
    printResult({
      status: "blocked",
      action: "Set AIBTC_WALLET_PASSWORD in the environment before executing the reduction.",
      data: {},
      error: {
        code: "PASSWORD_REQUIRED",
        message: "AIBTC_WALLET_PASSWORD is required to unlock the wallet for writes",
        next: "Export AIBTC_WALLET_PASSWORD and retry",
      },
    });
    return;
  }

  const context = await collectContext(options);
  if (!context.canReduce || !context.topPool || !context.quote) {
    printResult({
      status: "blocked",
      action: "Reduction did not pass preflight safety gates.",
      data: {
        wallet: context.wallet,
        blockers: context.blockers,
      },
      error: {
        code: "PREFLIGHT_BLOCKED",
        message: context.blockers.join("; "),
        next: "Wait for higher risk, lower the trigger with explicit approval, or adjust balances before retrying",
      },
    });
    return;
  }

  const walletManager = getWalletManager();
  process.env.BITFLOW_API_HOST ||= BITFLOW_PUBLIC_HOST;
  const bitflow = getBitflowService(NETWORK);

  try {
    const account = await walletManager.unlock(context.wallet.id, password);
    const slippageTolerance = options.slippageBps / 10_000;
    const result = await bitflow.swap(
      account,
      BITFLOW_SBTC_ID,
      BITFLOW_USDCX_ID,
      satsToHumanSbtc(context.reduceSats),
      slippageTolerance
    );

    await writeState({
      lastReductionAt: new Date().toISOString(),
      lastTxid: result.txid,
      lastPoolId: context.topPool.poolId,
    });

    printResult({
      status: "success",
      action: "Reduced sBTC exposure via Bitflow",
      data: {
        operation: "reduce-exposure",
        wallet: {
          id: context.wallet.id,
          address: context.wallet.address,
          name: context.wallet.name || "aibtc-wallet",
        },
        triggerPool: context.topPool,
        reduction: {
          tokenIn: "sBTC",
          tokenOut: "USDCx",
          amountInSats: context.reduceSats.toString(),
          quotedAmountOut: context.quote.expectedAmountOut,
          minAmountOutBase: context.minAmountOutBase.toString(),
          route: context.quote.route,
        },
        txid: result.txid,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        stateFile: STATE_FILE,
      },
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printResult({
      status: "error",
      action: "Check the error, verify the wallet password and balances, then retry if safe.",
      data: {
        wallet: {
          id: context.wallet.id,
          address: context.wallet.address,
        },
        attemptedReduceSats: context.reduceSats.toString(),
      },
      error: {
        code: "REDUCTION_FAILED",
        message,
        next: "Verify password, quote route, and wallet balances before retrying",
      },
    });
  } finally {
    await walletManager.lock().catch(() => undefined);
  }
}

function parseOptions(rawOptions: Record<string, string | undefined>): RunOptions {
  const parsed: RunOptions = {
    walletId: rawOptions.walletId || rawOptions["wallet-id"],
    poolId: rawOptions.poolId || rawOptions["pool-id"],
    maxReduceSats: parseBigIntOption(rawOptions.maxReduceSats || rawOptions["max-reduce-sats"], DEFAULT_MAX_REDUCE_SATS, "max-reduce-sats"),
    reserveSats: parseBigIntOption(rawOptions.reserveSats || rawOptions["reserve-sats"], DEFAULT_RESERVE_SATS, "reserve-sats"),
    triggerRiskScore: parseNumberOption(rawOptions.triggerRiskScore || rawOptions["trigger-risk-score"], DEFAULT_TRIGGER_RISK_SCORE, "trigger-risk-score"),
    minVolumeUsd: parseNumberOption(rawOptions.minVolumeUsd || rawOptions["min-volume-usd"], DEFAULT_MIN_VOLUME_USD, "min-volume-usd"),
    minGasReserveUstx: parseBigIntOption(
      rawOptions.minGasReserveUstx || rawOptions["min-gas-reserve-ustx"],
      DEFAULT_MIN_GAS_RESERVE_USTX,
      "min-gas-reserve-ustx"
    ),
    slippageBps: parseNumberOption(rawOptions.slippageBps || rawOptions["slippage-bps"], DEFAULT_SLIPPAGE_BPS, "slippage-bps"),
    minReceiveBase: parseBigIntOption(rawOptions.minReceiveBase || rawOptions["min-receive-base"], DEFAULT_MIN_RECEIVE_BASE, "min-receive-base"),
    cooldownHours: parseNumberOption(rawOptions.cooldownHours || rawOptions["cooldown-hours"], DEFAULT_COOLDOWN_HOURS, "cooldown-hours"),
    confirm: rawOptions.confirm,
  };

  if (
    parsed.maxReduceSats < 0n ||
    parsed.reserveSats < 0n ||
    parsed.triggerRiskScore < 0 ||
    parsed.minVolumeUsd < 0 ||
    parsed.minGasReserveUstx < 0n ||
    parsed.slippageBps < 0 ||
    parsed.minReceiveBase < 0n ||
    parsed.cooldownHours < 0
  ) {
    printFlatError("All numeric options must be non-negative");
  }
  if (parsed.slippageBps > 10_000) {
    printFlatError("slippage-bps must be between 0 and 10000");
  }
  return parsed;
}

const program = new Command();

program
  .name("hodlmm-position-reducer")
  .description("Write skill for reducing sBTC exposure when sBTC HODLMM pools breach risk thresholds")
  .showHelpAfterError();

for (const command of ["doctor", "status", "run"]) {
  program
    .command(command)
    .option("--wallet-id <id>", "Specific AIBTC wallet id to use")
    .option("--pool-id <id>", "Specific sBTC HODLMM pool id to monitor")
    .option("--max-reduce-sats <sats>", "Maximum sBTC amount to reduce", DEFAULT_MAX_REDUCE_SATS.toString())
    .option("--reserve-sats <sats>", "Minimum sBTC to retain after reduction", DEFAULT_RESERVE_SATS.toString())
    .option("--trigger-risk-score <score>", "Minimum pool risk score required to reduce", String(DEFAULT_TRIGGER_RISK_SCORE))
    .option("--min-volume-usd <usd>", "Minimum pool 24h volume required for execution", String(DEFAULT_MIN_VOLUME_USD))
    .option("--min-gas-reserve-ustx <ustx>", "Minimum STX reserve to keep after the write path", DEFAULT_MIN_GAS_RESERVE_USTX.toString())
    .option("--slippage-bps <bps>", "Maximum tolerated slippage in basis points", String(DEFAULT_SLIPPAGE_BPS))
    .option("--min-receive-base <amount>", "Minimum acceptable USDCx output in base units", DEFAULT_MIN_RECEIVE_BASE.toString())
    .option("--cooldown-hours <hours>", "Cooldown window between reductions", String(DEFAULT_COOLDOWN_HOURS))
    .option("--confirm <token>", "Required only for run: set to REDUCE to allow broadcast")
    .action(async (rawOptions) => {
      const options = parseOptions(rawOptions as Record<string, string | undefined>);
      if (command === "doctor") {
        await runDoctor(options);
        return;
      }
      if (command === "status") {
        await runStatus(options);
        return;
      }
      await runReduce(options);
    });
}

program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printFlatError(message);
});
