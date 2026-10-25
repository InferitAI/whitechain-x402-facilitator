// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { getAddress, isAddress, parseEther, parseUnits, type Address, type Hex } from "viem";
import { addressKey, isStellarAddress, isStellarContractId } from "./address.js";

// --------------------------------------------------------------------------- networks

const addressSchema = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x-prefixed 20-byte address")
  .transform((v) => getAddress(v));

/**
 * RPC and explorer URLs must be http(s): the RPC is only ever spoken to over HTTP by viem, and the
 * explorer URL is rendered into links, so no other scheme (file:, javascript:, …) is meaningful.
 */
const httpUrl = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), "must be an http(s) URL");

/** Host-only form of a URL for logs and /health: provider API keys usually live in the path. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname && url.pathname !== "/" ? "/…" : "";
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return "[invalid url]";
  }
}

export const NetworkConfigSchema = z
  .object({
    /** CAIP-2 id, e.g. "eip155:1874". */
    id: z.string().regex(/^eip155:\d+$/, 'network id must look like "eip155:<chainId>"'),
    name: z.string().min(1).optional(),
    rpc: httpUrl.optional(),
    rpcUrl: httpUrl.optional(),
    explorer: httpUrl.optional(),
    explorerUrl: httpUrl.optional(),
    nativeSymbol: z.string().min(1).default("WBT"),
    nativeDecimals: z.number().int().min(0).max(36).default(18),
    testnet: z.boolean().optional(),
    /** Optional asset allowlist. When present only these token contracts are verified/settled. */
    assets: z.array(addressSchema).optional(),
    /** Receipt wait bound for this network; falls back to CONFIRMATION_TIMEOUT_MS. */
    confirmationTimeoutMs: z.number().int().positive().optional(),
  })
  .transform((n, ctx) => {
    const rpcUrl = n.rpcUrl ?? n.rpc;
    if (!rpcUrl) {
      ctx.addIssue({ code: "custom", message: `network ${n.id}: "rpc" is required` });
      return z.NEVER;
    }
    const chainId = Number(n.id.slice("eip155:".length));
    return {
      id: n.id as `${string}:${string}`,
      chainId,
      name: n.name ?? `eip155:${chainId}`,
      rpcUrl,
      explorerUrl: (n.explorerUrl ?? n.explorer)?.replace(/\/+$/, ""),
      nativeSymbol: n.nativeSymbol,
      nativeDecimals: n.nativeDecimals,
      testnet: n.testnet ?? true,
      assets: n.assets ? new Set(n.assets.map((a) => a.toLowerCase())) : undefined,
      confirmationTimeoutMs: n.confirmationTimeoutMs,
    };
  });

export type NetworkConfig = z.output<typeof NetworkConfigSchema>;

/** Whitechain Sepolia: the public testnet of WhiteBIT's EVM L2. Gas token: WBT. */
export const WHITECHAIN_SEPOLIA: z.input<typeof NetworkConfigSchema> = {
  id: "eip155:1874",
  name: "Whitechain Sepolia",
  rpc: "https://rpc.testnet.whitechain.io",
  explorer: "https://explorer.testnet.whitechain.io",
  nativeSymbol: "WBT",
  testnet: true,
};

/**
 * Parses the NETWORKS setting. Accepts inline JSON (an array of network objects, or one object)
 * or a path to a JSON file with the same content. Unset: Whitechain Sepolia only.
 */
export function parseNetworks(raw: string | undefined): NetworkConfig[] {
  let value: unknown;
  if (!raw || raw.trim() === "") {
    value = [WHITECHAIN_SEPOLIA];
  } else {
    const trimmed = raw.trim();
    const text = trimmed.startsWith("[") || trimmed.startsWith("{") ? trimmed : readFileSync(trimmed, "utf8");
    value = JSON.parse(text);
  }
  const list = Array.isArray(value) ? value : [value];
  const networks = z.array(NetworkConfigSchema).min(1).parse(list);
  const seen = new Set<string>();
  for (const n of networks) {
    if (seen.has(n.id)) throw new Error(`NETWORKS: duplicate network ${n.id}`);
    seen.add(n.id);
  }
  return networks;
}

// --------------------------------------------------------------------------- stellar networks

/** Stellar's testnet: public Soroban RPC run by the Stellar Development Foundation, free friendbot funding. */
export const STELLAR_TESTNET_ID = "stellar:testnet";
export const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
/** Lumens have 7 decimals: 1 XLM = 10,000,000 stroops. */
export const XLM_DECIMALS = 7;

const stellarContractSchema = z.string().refine(isStellarContractId, "must be a Stellar contract address (C…)");

/**
 * One Stellar network the facilitator settles on. This release enables `stellar:testnet` only;
 * mainnet (`stellar:pubnet`) also needs a dedicated RPC endpoint, a higher inclusion fee and
 * vaulted fee-payer keys, see docs/MAINNET.md.
 */
export const StellarNetworkConfigSchema = z
  .object({
    id: z.string().refine((v) => v === STELLAR_TESTNET_ID, 'only "stellar:testnet" is supported in this release (see docs/MAINNET.md)'),
    name: z.string().min(1).optional(),
    /** Soroban RPC. Use one endpoint for verify and settle: mixed RPC nodes can disagree on ledger state. */
    rpc: httpUrl.optional(),
    rpcUrl: httpUrl.optional(),
    explorer: httpUrl.optional(),
    explorerUrl: httpUrl.optional(),
    /** Optional allowlist of asset contracts (C…, case-sensitive). */
    assets: z.array(stellarContractSchema).optional(),
    /** Refuse payments whose settlement fee (resource fee + inclusion fee) would exceed this. */
    maxFeeStroops: z.number().int().positive().max(100_000_000).default(50_000),
    /** Inclusion fee bid on top of the resource fee. Testnet accepts the 100-stroop minimum. */
    inclusionFeeStroops: z.number().int().min(100).max(10_000_000).default(100),
    /**
     * Largest `maxTimeoutSeconds` accepted from a resource server. The SDK polls for confirmation
     * that many times and lets the payer's authorization live that long, so it bounds how long
     * one settlement can hold a fee-payer account.
     */
    maxTimeoutSeconds: z.number().int().min(1).max(3_600).default(300),
  })
  .transform((n) => ({
    id: n.id as `${string}:${string}`,
    name: n.name ?? "Stellar Testnet",
    rpcUrl: n.rpcUrl ?? n.rpc ?? "https://soroban-testnet.stellar.org",
    explorerUrl: (n.explorerUrl ?? n.explorer ?? "https://stellar.expert/explorer/testnet").replace(/\/+$/, ""),
    networkPassphrase: STELLAR_TESTNET_PASSPHRASE,
    nativeSymbol: "XLM",
    nativeDecimals: XLM_DECIMALS,
    testnet: true,
    assets: n.assets ? new Set(n.assets) : undefined,
    maxFeeStroops: n.maxFeeStroops,
    inclusionFeeStroops: n.inclusionFeeStroops,
    maxTimeoutSeconds: n.maxTimeoutSeconds,
  }));

export type StellarNetworkConfig = z.output<typeof StellarNetworkConfigSchema>;

/** Parses STELLAR_NETWORKS (inline JSON or a path to a JSON file). Unset: Stellar testnet with defaults. */
export function parseStellarNetworks(raw: string | undefined): StellarNetworkConfig[] {
  let value: unknown;
  if (!raw || raw.trim() === "") {
    value = [{ id: STELLAR_TESTNET_ID }];
  } else {
    const trimmed = raw.trim();
    const text = trimmed.startsWith("[") || trimmed.startsWith("{") ? trimmed : readFileSync(trimmed, "utf8");
    value = JSON.parse(text);
  }
  const list = Array.isArray(value) ? value : [value];
  const networks = z.array(StellarNetworkConfigSchema).min(1).parse(list);
  const seen = new Set<string>();
  for (const n of networks) {
    if (seen.has(n.id)) throw new Error(`STELLAR_NETWORKS: duplicate network ${n.id}`);
    seen.add(n.id);
  }
  return networks;
}

/**
 * STELLAR_FACILITATOR_KEY: one Stellar secret seed (S…), or several separated by commas. Each
 * key is a fee-payer account that signs and pays for settlements; more keys = more settlements
 * in flight at once (one per key, see src/stellar/pool.ts).
 */
export function parseStellarKeys(raw: string): string[] {
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (keys.length === 0) throw new Error("STELLAR_FACILITATOR_KEY is empty");
  keys.forEach((k, i) => {
    // Never echo the value: only its position.
    if (!StrKey.isValidEd25519SecretSeed(k)) throw new Error(`STELLAR_FACILITATOR_KEY: entry ${i + 1} is not a Stellar secret seed (S…)`);
  });
  if (new Set(keys).size !== keys.length) throw new Error("STELLAR_FACILITATOR_KEY: duplicate key");
  return keys;
}

/** Daily fee budgets for Stellar are written in XLM ("2.5"); same unlimited / kill-switch forms as gas budgets. */
export function parseXlmBudget(raw: string): bigint | null {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "unlimited" || v === "off" || v === "none") return null;
  if (!/^\d+(\.\d{1,7})?$/.test(v)) throw new Error(`invalid XLM amount "${raw}" (expected e.g. "2.5", at most 7 decimals)`);
  return parseUnits(v, XLM_DECIMALS);
}

// --------------------------------------------------------------------------- api keys

/** API-key payTo restrictions may name EVM addresses (checksummed or not) or Stellar G…/C…/M… addresses. */
const anyAddressSchema = z
  .string()
  .refine((v) => isAddress(v, { strict: false }) || isStellarAddress(v), "must be a 0x-prefixed 20-byte address or a Stellar G…/C…/M… address")
  .transform((v) => (isStellarAddress(v) ? v : getAddress(v)));

export const ApiKeyConfigSchema = z
  .object({
    name: z.string().min(1),
    /** Plain key (compared by SHA-256 digest at runtime). Prefer keySha256 in production envs. */
    key: z.string().min(16).optional(),
    /** Hex SHA-256 of the key so the raw secret never sits in the environment. */
    keySha256: z
      .string()
      .regex(/^(0x)?[0-9a-fA-F]{64}$/)
      .optional(),
    /** Multiplies the per-key, per-payer and per-payTo rate limits. Default 10x. */
    rateLimitMultiplier: z.number().positive().default(10),
    /** Optional daily gas budget (native units, decimal string) applied instead of the per-payTo budget. */
    dailyGasBudget: z.string().optional(),
    /** Optional daily Stellar fee budget in XLM, applied instead of the per-payTo Stellar budget. */
    dailyStellarFeeBudget: z.string().optional(),
    /** Optional restriction: this key may only settle to these payTo addresses (EVM or Stellar). */
    payTo: z.array(anyAddressSchema).optional(),
  })
  .transform((k, ctx) => {
    if (!k.key && !k.keySha256) {
      ctx.addIssue({ code: "custom", message: `api key ${k.name}: "key" or "keySha256" is required` });
      return z.NEVER;
    }
    const digest = k.keySha256 ? k.keySha256.replace(/^0x/, "").toLowerCase() : sha256Hex(k.key as string);
    return {
      name: k.name,
      digest,
      rateLimitMultiplier: k.rateLimitMultiplier,
      dailyGasBudgetWei: k.dailyGasBudget === undefined ? undefined : parseNativeBudget(k.dailyGasBudget),
      dailyStellarFeeBudgetStroops: k.dailyStellarFeeBudget === undefined ? undefined : parseXlmBudget(k.dailyStellarFeeBudget),
      // EVM entries lower-cased (as before); Stellar entries verbatim (strkeys are case-sensitive).
      payTo: k.payTo ? new Set(k.payTo.map(addressKey)) : undefined,
    };
  });

export type ApiKeyConfig = z.output<typeof ApiKeyConfigSchema>;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function parseApiKeys(raw: string | undefined): ApiKeyConfig[] {
  if (!raw || raw.trim() === "") return [];
  const trimmed = raw.trim();
  const text = trimmed.startsWith("[") ? trimmed : readFileSync(trimmed, "utf8");
  return z.array(ApiKeyConfigSchema).parse(JSON.parse(text));
}

// --------------------------------------------------------------------------- budgets

/**
 * Daily gas budgets are written in native units ("0.25" = 0.25 WBT). "unlimited"/"off" disables
 * the limit; "0" is a kill switch that refuses every settlement.
 */
export function parseNativeBudget(raw: string): bigint | null {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "unlimited" || v === "off" || v === "none") return null;
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`invalid native amount "${raw}" (expected e.g. "0.25")`);
  return parseEther(v);
}

// --------------------------------------------------------------------------- env

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())));

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const EnvSchema = z.object({
  NODE_ENV: z.string().default("production"),
  HOST: z.string().default("0.0.0.0"),
  PORT: int(8402, 0),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** "false" | "true" | number of trusted proxy hops (X-Forwarded-For) in front of the service. */
  TRUST_PROXY: z.string().default("false"),
  FACILITATOR_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "FACILITATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key"),
  NETWORKS: z.string().optional(),
  /** "exact" and/or "upto". `upto` is only advertised on networks where the x402 Upto Permit2 proxy exists. */
  SCHEMES: z.string().default("exact,upto"),
  /** Also run the on-chain simulation inside settle (recommended: avoids broadcasting doomed txs). */
  SIMULATE_IN_SETTLE: bool.default(true),
  CONFIRMATION_TIMEOUT_MS: int(60_000, 1_000),
  /** Hard cap on gas units the facilitator will sponsor for a single settlement tx. */
  MAX_SETTLE_GAS: int(300_000, 21_000),
  /** Gas used to reserve budget before a settlement's real cost is known. */
  SETTLE_GAS_ESTIMATE: int(120_000, 21_000),

  RATE_LIMIT_WINDOW_SECONDS: int(60, 1),
  RATE_LIMIT_IP_PER_WINDOW: int(120, 1),
  RATE_LIMIT_PAYER_PER_WINDOW: int(30, 1),
  RATE_LIMIT_PAYTO_PER_WINDOW: int(120, 1),
  /** Ceiling on verify+settle calls per window across all callers (bounds RPC fan-out); 0 disables. */
  RATE_LIMIT_GLOBAL_PER_WINDOW: int(1_200, 0),
  RATE_LIMIT_MAX_KEYS: int(50_000, 100),

  GAS_BUDGET_GLOBAL_DAILY: z.string().default("1"),
  GAS_BUDGET_PER_PAYTO_DAILY: z.string().default("0.1"),
  /** Warn (health: degraded) when the signer can afford fewer settles than this. */
  LOW_RUNWAY_SETTLES: int(50, 0),

  API_KEYS: z.string().optional(),
  REQUIRE_API_KEY: bool.default(false),

  DENYLIST_FILE: z.string().default("denylist.txt"),
  DENYLIST_RELOAD_SECONDS: int(300, 0),

  /** "off" (default) or "accrue": record a sponsorship fee per settlement without collecting it. */
  FEE_MODE: z.enum(["off", "accrue"]).default("off"),
  FEE_BPS: int(0, 0),
  FEE_FLAT_ATOMIC: z.string().regex(/^\d+$/).default("0"),

  LANDING_FILE: z.string().default("site/landing.html"),
  DOCS_URL: z.string().default("https://github.com/InferitAI/whitechain-x402-facilitator#readme"),
  REPO_URL: z.string().default("https://github.com/InferitAI/whitechain-x402-facilitator"),
  PUBLIC_URL: z.string().optional(),
  /** Seconds the /health probe is cached. */
  HEALTH_CACHE_SECONDS: int(10, 0),
  /** Minutes between re-probing networks for newly deployed Permit2 proxies. 0 disables re-probing. */
  PROXY_PROBE_MINUTES: int(10, 0),

  /** Stellar fee-payer secret seed(s). Unset = Stellar disabled (Whitechain only). */
  STELLAR_FACILITATOR_KEY: z.string().optional(),
  STELLAR_NETWORKS: z.string().optional(),
  /** XLM of network fees sponsored per day across all merchants, per Stellar network. */
  STELLAR_FEE_BUDGET_GLOBAL_DAILY: z.string().default("50"),
  /** XLM of network fees sponsored per day per merchant (payTo), per Stellar network. */
  STELLAR_FEE_BUDGET_PER_PAYTO_DAILY: z.string().default("5"),
  /** Ceiling on Stellar verify+settle calls per window per Stellar network (bounds Soroban RPC fan-out); 0 disables. */
  STELLAR_RATE_LIMIT_GLOBAL_PER_WINDOW: int(300, 0),
  /** How long a settlement waits for a free fee-payer account before answering facilitator_busy. */
  STELLAR_SETTLE_QUEUE_TIMEOUT_MS: int(30_000, 0),
});

export type FeeMode = "off" | "accrue";

/** Stellar settings; present only when STELLAR_FACILITATOR_KEY is set. */
export interface StellarConfig {
  /** Never log or serialize (non-enumerable, like `privateKey`). */
  secretKeys: string[];
  networks: StellarNetworkConfig[];
  feeBudget: {
    globalDailyStroops: bigint | null;
    perPayToDailyStroops: bigint | null;
  };
  /** 0 = no per-network ceiling. */
  globalPerWindow: number;
  settleQueueTimeoutMs: number;
}

export interface FacilitatorConfig {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: z.output<typeof EnvSchema>["LOG_LEVEL"];
  trustProxy: boolean | number;
  /** Never log or serialize. Kept on the config only to build the account at startup. */
  privateKey: Hex;
  networks: NetworkConfig[];
  schemes: Set<"exact" | "upto">;
  simulateInSettle: boolean;
  confirmationTimeoutMs: number;
  maxSettleGas: bigint;
  settleGasEstimate: bigint;
  rateLimit: {
    windowSeconds: number;
    ipPerWindow: number;
    payerPerWindow: number;
    payToPerWindow: number;
    /** 0 = no facilitator-wide ceiling. */
    globalPerWindow: number;
    maxKeys: number;
  };
  gasBudget: {
    globalDailyWei: bigint | null;
    perPayToDailyWei: bigint | null;
  };
  lowRunwaySettles: number;
  apiKeys: ApiKeyConfig[];
  requireApiKey: boolean;
  denylistFile: string;
  denylistReloadSeconds: number;
  fee: { mode: FeeMode; bps: number; flatAtomic: bigint };
  landingFile: string;
  docsUrl: string;
  repoUrl: string;
  publicUrl: string | undefined;
  healthCacheSeconds: number;
  proxyProbeMinutes: number;
  /** Undefined when Stellar is not enabled. */
  stellar: StellarConfig | undefined;
}

function loadStellarConfig(e: z.output<typeof EnvSchema>): StellarConfig | undefined {
  const rawKey = e.STELLAR_FACILITATOR_KEY?.trim();
  if (!rawKey) {
    if (e.STELLAR_NETWORKS && e.STELLAR_NETWORKS.trim() !== "") {
      throw new Error("STELLAR_NETWORKS is set but STELLAR_FACILITATOR_KEY is not; set the fee-payer key to enable Stellar");
    }
    return undefined;
  }
  const stellar: StellarConfig = {
    secretKeys: parseStellarKeys(rawKey),
    networks: parseStellarNetworks(e.STELLAR_NETWORKS),
    feeBudget: {
      globalDailyStroops: parseXlmBudget(e.STELLAR_FEE_BUDGET_GLOBAL_DAILY),
      perPayToDailyStroops: parseXlmBudget(e.STELLAR_FEE_BUDGET_PER_PAYTO_DAILY),
    },
    globalPerWindow: e.STELLAR_RATE_LIMIT_GLOBAL_PER_WINDOW,
    settleQueueTimeoutMs: e.STELLAR_SETTLE_QUEUE_TIMEOUT_MS,
  };
  Object.defineProperty(stellar, "secretKeys", { value: stellar.secretKeys, enumerable: false, writable: false });
  return stellar;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const schemes = new Set(
    e.SCHEMES.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  for (const s of schemes) {
    if (s !== "exact" && s !== "upto") throw new Error(`SCHEMES: unsupported scheme "${s}" (use exact,upto)`);
  }
  if (!schemes.has("exact")) throw new Error('SCHEMES must include "exact"');

  const trustProxy: boolean | number = /^\d+$/.test(e.TRUST_PROXY)
    ? Number(e.TRUST_PROXY)
    : ["1", "true", "yes", "on"].includes(e.TRUST_PROXY.trim().toLowerCase());

  const config: FacilitatorConfig = {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy,
    privateKey: e.FACILITATOR_PRIVATE_KEY as Hex,
    networks: parseNetworks(e.NETWORKS),
    schemes: schemes as Set<"exact" | "upto">,
    simulateInSettle: e.SIMULATE_IN_SETTLE,
    confirmationTimeoutMs: e.CONFIRMATION_TIMEOUT_MS,
    maxSettleGas: BigInt(e.MAX_SETTLE_GAS),
    settleGasEstimate: BigInt(e.SETTLE_GAS_ESTIMATE),
    rateLimit: {
      windowSeconds: e.RATE_LIMIT_WINDOW_SECONDS,
      ipPerWindow: e.RATE_LIMIT_IP_PER_WINDOW,
      payerPerWindow: e.RATE_LIMIT_PAYER_PER_WINDOW,
      payToPerWindow: e.RATE_LIMIT_PAYTO_PER_WINDOW,
      globalPerWindow: e.RATE_LIMIT_GLOBAL_PER_WINDOW,
      maxKeys: e.RATE_LIMIT_MAX_KEYS,
    },
    gasBudget: {
      globalDailyWei: parseNativeBudget(e.GAS_BUDGET_GLOBAL_DAILY),
      perPayToDailyWei: parseNativeBudget(e.GAS_BUDGET_PER_PAYTO_DAILY),
    },
    lowRunwaySettles: e.LOW_RUNWAY_SETTLES,
    apiKeys: parseApiKeys(e.API_KEYS),
    requireApiKey: e.REQUIRE_API_KEY,
    denylistFile: e.DENYLIST_FILE,
    denylistReloadSeconds: e.DENYLIST_RELOAD_SECONDS,
    fee: { mode: e.FEE_MODE, bps: e.FEE_BPS, flatAtomic: BigInt(e.FEE_FLAT_ATOMIC) },
    landingFile: e.LANDING_FILE,
    docsUrl: e.DOCS_URL,
    repoUrl: e.REPO_URL,
    publicUrl: e.PUBLIC_URL,
    healthCacheSeconds: e.HEALTH_CACHE_SECONDS,
    proxyProbeMinutes: e.PROXY_PROBE_MINUTES,
    stellar: loadStellarConfig(e),
  };

  // The key must never be visible through accidental serialization of the config object.
  Object.defineProperty(config, "privateKey", { value: config.privateKey, enumerable: false, writable: false });
  return config;
}

/** Public, log-safe view of the configuration. */
export function describeConfig(c: FacilitatorConfig): Record<string, unknown> {
  return {
    host: c.host,
    port: c.port,
    networks: c.networks.map((n) => ({
      id: n.id,
      name: n.name,
      // Host only: RPC URLs frequently carry a provider API key in their path.
      rpcUrl: redactUrl(n.rpcUrl),
      explorerUrl: n.explorerUrl,
      assets: n.assets ? [...n.assets] : "any",
    })),
    schemes: [...c.schemes],
    simulateInSettle: c.simulateInSettle,
    confirmationTimeoutMs: c.confirmationTimeoutMs,
    maxSettleGas: c.maxSettleGas.toString(),
    rateLimit: c.rateLimit,
    gasBudget: {
      globalDaily: c.gasBudget.globalDailyWei === null ? "unlimited" : c.gasBudget.globalDailyWei.toString(),
      perPayToDaily: c.gasBudget.perPayToDailyWei === null ? "unlimited" : c.gasBudget.perPayToDailyWei.toString(),
    },
    apiKeys: c.apiKeys.map((k) => k.name),
    requireApiKey: c.requireApiKey,
    denylistFile: c.denylistFile,
    fee: { mode: c.fee.mode, bps: c.fee.bps, flatAtomic: c.fee.flatAtomic.toString() },
    ...(c.stellar
      ? {
          stellar: {
            networks: c.stellar.networks.map((n) => ({
              id: n.id,
              name: n.name,
              rpcUrl: redactUrl(n.rpcUrl),
              explorerUrl: n.explorerUrl,
              assets: n.assets ? [...n.assets] : "any",
              maxFeeStroops: n.maxFeeStroops,
              inclusionFeeStroops: n.inclusionFeeStroops,
              maxTimeoutSeconds: n.maxTimeoutSeconds,
            })),
            feePayerAccounts: c.stellar.secretKeys.length,
            feeBudget: {
              globalDaily: c.stellar.feeBudget.globalDailyStroops === null ? "unlimited" : c.stellar.feeBudget.globalDailyStroops.toString(),
              perPayToDaily: c.stellar.feeBudget.perPayToDailyStroops === null ? "unlimited" : c.stellar.feeBudget.perPayToDailyStroops.toString(),
            },
            globalPerWindow: c.stellar.globalPerWindow,
          },
        }
      : {}),
  };
}

export type { Address };
