#!/usr/bin/env bun

import { Command } from "commander";
import { getAlexDexService } from "@aibtc/mcp-server/dist/services/defi.service.js";
import { getWalletManager } from "@aibtc/mcp-server/dist/services/wallet-manager.js";
import { getExplorerTxUrl } from "@aibtc/mcp-server/dist/config/networks.js";

const HIRO_API = "https://api.mainnet.hiro.so";
const ABTC_FT_KEY = "SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK.token-abtc::bridged-btc";
const NETWORK = "mainnet";
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_TARGET_ABTC_SATS = 25;
const DEFAULT_SWAP_AMOUNT_USTX = 500_000;
const DEFAULT_MAX_SWAP_USTX = 500_000;
const DEFAULT_MIN_GAS_RESERVE_USTX = 100_000;
const DEFAULT_SLIPPAGE_BPS = 200;
const DEFAULT_MIN_RECEIVE_SATS = 1;
const CONFIRM_TOKEN = "REFILL";

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

interface QuoteResult {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  route: string[];
}

interface RunOptions {
  walletId?: string;
  targetAbtcSats: bigint;
  swapAmountUstx: bigint;
  maxSwapUstx: bigint;
  minGasReserveUstx: bigint;
  slippageBps: number;
  minReceiveSats: bigint;
  confirm?: string;
}

interface Context {
  wallet: WalletMetadata;
  stxUstx: bigint;
  abtcSats: bigint;
  deficitSats: bigint;
  swapAmountUstx: bigint;
  quote: QuoteResult;
  minAmountOut: bigint;
  canRefill: boolean;
  blockers: string[];
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

function parseBigIntOption(
  value: string | undefined,
  fallback: bigint,
  flag: string
): bigint {
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

function parseNumberOption(
  value: string | undefined,
  fallback: number,
  flag: string
): number {
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
        "User-Agent": "bff-skills/alex-abtc-buffer-refiller",
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
  const wallets = await manager.listWallets() as WalletMetadata[];
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

async function getAbtcBalance(address: string): Promise<bigint> {
  const data = await fetchJson<HiroBalancesResponse>(`${HIRO_API}/extended/v1/address/${address}/balances`);
  return toBigInt(data.fungible_tokens?.[ABTC_FT_KEY]?.balance);
}

function computeMinAmountOut(amountOut: string, slippageBps: number): bigint {
  const quoted = BigInt(amountOut);
  if (quoted <= 0n) return 0n;
  const numerator = BigInt(10_000 - slippageBps);
  const discounted = (quoted * numerator) / 10_000n;
  return discounted > 0n ? discounted : 1n;
}

async function collectContext(options: RunOptions): Promise<Context> {
  const wallet = await resolveWallet(options.walletId);
  const [stxUstx, abtcSats] = await Promise.all([
    getStxBalance(wallet.address),
    getAbtcBalance(wallet.address),
  ]);
  const deficitSats = options.targetAbtcSats > abtcSats ? options.targetAbtcSats - abtcSats : 0n;
  const swapAmountUstx = options.swapAmountUstx < options.maxSwapUstx ? options.swapAmountUstx : options.maxSwapUstx;
  const alex = getAlexDexService(NETWORK);
  const quote = await alex.getSwapQuote("STX", "aBTC", swapAmountUstx, wallet.address) as QuoteResult;
  const minAmountOut = computeMinAmountOut(quote.amountOut, options.slippageBps);

  const blockers: string[] = [];
  if (wallet.network !== NETWORK) {
    blockers.push(`Wallet network ${wallet.network || "unknown"} is not ${NETWORK}`);
  }
  if (abtcSats >= options.targetAbtcSats) {
    blockers.push(`aBTC buffer already meets target (${abtcSats} >= ${options.targetAbtcSats})`);
  }
  if (quote.amountOut === "0") {
    blockers.push(`Swap amount ${swapAmountUstx} uSTX quotes 0 aBTC output`);
  }
  if (minAmountOut < options.minReceiveSats) {
    blockers.push(`Minimum output ${minAmountOut.toString()} sats < required ${options.minReceiveSats.toString()} sats`);
  }
  if (stxUstx - swapAmountUstx < options.minGasReserveUstx) {
    blockers.push(
      `Post-swap STX reserve ${(stxUstx > swapAmountUstx ? stxUstx - swapAmountUstx : 0n).toString()} uSTX would fall below ${options.minGasReserveUstx.toString()} uSTX`
    );
  }

  return {
    wallet,
    stxUstx,
    abtcSats,
    deficitSats,
    swapAmountUstx,
    quote,
    minAmountOut,
    canRefill: blockers.length === 0,
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
      detail: `stx=${context.stxUstx.toString()} uSTX, abtc=${context.abtcSats.toString()} sats`,
    };
    checks.quote = {
      ok: context.quote.amountOut !== "0",
      detail: `${context.swapAmountUstx.toString()} uSTX -> ${context.quote.amountOut} sats aBTC`,
    };
    checks.gas_reserve = {
      ok: context.stxUstx - context.swapAmountUstx >= options.minGasReserveUstx,
      detail: `post-swap reserve ${(context.stxUstx > context.swapAmountUstx ? context.stxUstx - context.swapAmountUstx : 0n).toString()} uSTX`,
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
      action: "Environment ready. Run status to inspect the buffer or run with --confirm=REFILL to execute.",
      data: { checks },
      error: null,
    });
    return;
  }

  printResult({
    status: "blocked",
    action: "Resolve the reported blockers before executing a refill swap.",
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
    action: context.canRefill
      ? `Wallet is below target by ${context.deficitSats} sats. A refill swap is currently allowed.`
      : "Buffer refill is currently blocked by one or more safety gates.",
    data: {
      wallet: context.wallet,
      balances: {
        stxUstx: context.stxUstx.toString(),
        abtcSats: context.abtcSats.toString(),
      },
      target: {
        targetAbtcSats: options.targetAbtcSats.toString(),
        deficitSats: context.deficitSats.toString(),
      },
      swapPlan: {
        swapAmountUstx: context.swapAmountUstx.toString(),
        maxSwapUstx: options.maxSwapUstx.toString(),
        minGasReserveUstx: options.minGasReserveUstx.toString(),
        quotedAmountOutSats: context.quote.amountOut,
        minAmountOutSats: context.minAmountOut.toString(),
        route: context.quote.route,
      },
      canRefill: context.canRefill,
      blockers: context.blockers,
    },
    error: null,
  });
}

async function runRefill(options: RunOptions): Promise<void> {
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
      action: "Set AIBTC_WALLET_PASSWORD in the environment before executing the refill.",
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
  if (!context.canRefill) {
    printResult({
      status: "blocked",
      action: "Refill swap did not pass preflight safety gates.",
      data: {
        wallet: context.wallet,
        blockers: context.blockers,
      },
      error: {
        code: "PREFLIGHT_BLOCKED",
        message: context.blockers.join("; "),
        next: "Reduce swap size, lower target, or fund more STX before retrying",
      },
    });
    return;
  }

  const walletManager = getWalletManager();
  const alex = getAlexDexService(NETWORK);

  try {
    const account = await walletManager.unlock(context.wallet.id, password);
    const result = await alex.swap(
      account,
      "STX",
      "aBTC",
      context.swapAmountUstx,
      context.minAmountOut
    );

    printResult({
      status: "success",
      action: "Refilled aBTC buffer via ALEX",
      data: {
        operation: "refill-buffer",
        wallet: {
          id: context.wallet.id,
          address: context.wallet.address,
          name: context.wallet.name || "aibtc-wallet",
        },
        swap: {
          tokenIn: "STX",
          tokenOut: "aBTC",
          amountInUstx: context.swapAmountUstx.toString(),
          quotedAmountOutSats: context.quote.amountOut,
          minAmountOutSats: context.minAmountOut.toString(),
          route: context.quote.route,
        },
        txid: result.txid,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      },
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printResult({
      status: "error",
      action: "Check the error, verify wallet password and balances, then retry if safe.",
      data: {
        wallet: {
          id: context.wallet.id,
          address: context.wallet.address,
        },
        attemptedSwapAmountUstx: context.swapAmountUstx.toString(),
      },
      error: {
        code: "SWAP_FAILED",
        message,
        next: "Verify password, quote, and wallet balances before retrying",
      },
    });
  } finally {
    await walletManager.lock().catch(() => undefined);
  }
}

function parseOptions(rawOptions: Record<string, string | undefined>): RunOptions {
  const walletId = rawOptions.walletId || rawOptions["wallet-id"];
  const targetAbtcSats = rawOptions.targetAbtcSats || rawOptions["target-abtc-sats"];
  const swapAmountUstx = rawOptions.swapAmountUstx || rawOptions["swap-amount-ustx"];
  const maxSwapUstx = rawOptions.maxSwapUstx || rawOptions["max-swap-ustx"];
  const minGasReserveUstx = rawOptions.minGasReserveUstx || rawOptions["min-gas-reserve-ustx"];
  const slippageBps = rawOptions.slippageBps || rawOptions["slippage-bps"];
  const minReceiveSats = rawOptions.minReceiveSats || rawOptions["min-receive-sats"];
  const confirm = rawOptions.confirm;
  const parsed: RunOptions = {
    walletId,
    targetAbtcSats: parseBigIntOption(targetAbtcSats, BigInt(DEFAULT_TARGET_ABTC_SATS), "target-abtc-sats"),
    swapAmountUstx: parseBigIntOption(swapAmountUstx, BigInt(DEFAULT_SWAP_AMOUNT_USTX), "swap-amount-ustx"),
    maxSwapUstx: parseBigIntOption(maxSwapUstx, BigInt(DEFAULT_MAX_SWAP_USTX), "max-swap-ustx"),
    minGasReserveUstx: parseBigIntOption(
      minGasReserveUstx,
      BigInt(DEFAULT_MIN_GAS_RESERVE_USTX),
      "min-gas-reserve-ustx"
    ),
    slippageBps: parseNumberOption(slippageBps, DEFAULT_SLIPPAGE_BPS, "slippage-bps"),
    minReceiveSats: parseBigIntOption(minReceiveSats, BigInt(DEFAULT_MIN_RECEIVE_SATS), "min-receive-sats"),
    confirm,
  };

  if (
    parsed.targetAbtcSats < 0n ||
    parsed.swapAmountUstx < 0n ||
    parsed.maxSwapUstx < 0n ||
    parsed.minGasReserveUstx < 0n ||
    parsed.slippageBps < 0 ||
    parsed.minReceiveSats < 0n
  ) {
    printFlatError("All numeric options must be non-negative");
  }

  if (parsed.slippageBps > 10_000) {
    printFlatError("slippage-bps must be between 0 and 10000");
  }

  if (parsed.swapAmountUstx > parsed.maxSwapUstx) {
    printFlatError("swap-amount-ustx cannot exceed max-swap-ustx");
  }

  return parsed;
}

const program = new Command();

program
  .name("alex-abtc-buffer-refiller")
  .description("Write skill for refilling an aBTC buffer from STX via ALEX")
  .showHelpAfterError();

for (const command of ["doctor", "status", "run"]) {
  program
    .command(command)
    .option("--wallet-id <id>", "Specific AIBTC wallet id to use")
    .option("--target-abtc-sats <sats>", "Minimum aBTC buffer target", String(DEFAULT_TARGET_ABTC_SATS))
    .option("--swap-amount-ustx <ustx>", "STX amount to swap when refill executes", String(DEFAULT_SWAP_AMOUNT_USTX))
    .option("--max-swap-ustx <ustx>", "Maximum allowed swap size", String(DEFAULT_MAX_SWAP_USTX))
    .option("--min-gas-reserve-ustx <ustx>", "Minimum STX reserve to keep after swap", String(DEFAULT_MIN_GAS_RESERVE_USTX))
    .option("--slippage-bps <bps>", "Maximum tolerated slippage in basis points", String(DEFAULT_SLIPPAGE_BPS))
    .option("--min-receive-sats <sats>", "Minimum acceptable aBTC output", String(DEFAULT_MIN_RECEIVE_SATS))
    .option("--confirm <token>", "Required only for run: set to REFILL to allow broadcast")
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
      await runRefill(options);
    });
}

program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printFlatError(message);
});
