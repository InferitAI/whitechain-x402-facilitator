// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getAddress, isAddress, parseEther, type Address, type Hex } from "viem";

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

// --------------------------------------------------------------------------- api keys

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
    /** Optional restriction: this key may only settle to these payTo addresses. */
    payTo: z.array(addressSchema).optional(),
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
      payTo: k.payTo ? new Set(k.payTo.map((a) => a.toLowerCase())) : undefined,
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
});

export type FeeMode = "off" | "accrue";

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
  };
}

export type { Address };
