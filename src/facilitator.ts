// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { UptoEvmScheme } from "@x402/evm/upto/facilitator";
import { PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress } from "@x402/evm";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { privateKeyToAccount } from "viem/accounts";
import { formatUnits, type Address } from "viem";
import { accountKey, isStellarNetworkId, screeningAddresses } from "./address.js";
import { redactUrl, STELLAR_TESTNET_PASSPHRASE, type ApiKeyConfig, type FacilitatorConfig, type NetworkConfig, type StellarNetworkConfig } from "./config.js";
import { settlementContext, type SettlementContext } from "./chain/context.js";
import { NetworkSigner } from "./chain/signer.js";
import { Reasons, PolicyError, loggableErrorMessage, publicErrorMessage } from "./errors.js";
import type { Logger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { ApiKeyRegistry } from "./policy/apiKeys.js";
import { AuthorizationRegistry, authorizationKey, claimedPayer } from "./policy/dedupe.js";
import { FileDenylist, type AddressScreener } from "./policy/denylist.js";
import { createFeePolicy, type FeeContext, type FeePolicy } from "./policy/fee.js";
import { GasBudget, type BudgetScope, type Reservation } from "./policy/gasBudget.js";
import { TokenBucketRateLimiter, type RateLimiter } from "./policy/ratelimit.js";
import type { ParsedFacilitatorRequest } from "./schema.js";
import { STELLAR_RPC_TIMEOUT_MS, StellarChain, type StellarTxStatus } from "./stellar/chain.js";
import { decodeStellarPayment, stellarAuthorizationKey, type StellarPayment } from "./stellar/payload.js";
import { selectLeasedSigner, stellarSignerContext, type SignerLease } from "./stellar/pool.js";

export const X402_VERSION = 2;
/** Advertised so resource servers may offer gasless EIP-2612 permits for Permit2 flows; @x402/evm handles it natively. */
const EIP2612_GAS_SPONSORING_KEY = "eip2612GasSponsoring";
const SETTLEMENT_PENDING = "settlement_pending";
const BALANCE_CACHE_MS = 15_000;
/** How long a Stellar settle keeps polling a broadcast the SDK reported as failed before answering settlement_pending. */
const STELLAR_RECONCILE_MS = 30_000;
/** How long start() and /health wait for a Stellar network's probe (it keeps running; a stalled RPC never holds them). */
const STELLAR_PROBE_BUDGET_MS = 5_000;

const TIMED_OUT = Symbol("timed out");

/** `p`, or TIMED_OUT once `ms` pass (`p` keeps running). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * @x402/stellar polls getTransaction `maxTimeoutSeconds` times, about a second apart; with each
 * call bounded (STELLAR_RPC_TIMEOUT_MS) the wait is bounded too, but a slow RPC could still
 * stretch it to attempts × timeout. This caps the whole wait at the SDK's own budget (attempts ×
 * delay) plus one call; the outcome is then the facilitator's to check (awaitFinal).
 */
export function boundPolling(scheme: ExactStellarScheme, callTimeoutMs: number): void {
  const poller = scheme as unknown as { pollForTransaction(server: unknown, txHash: string, attempts?: number, delayMs?: number): Promise<{ success: boolean }> };
  const poll = poller.pollForTransaction.bind(scheme);
  poller.pollForTransaction = async (server, txHash, attempts = 15, delayMs = 1_000) => {
    const r = await withDeadline(poll(server, txHash, attempts, delayMs), attempts * delayMs + callTimeoutMs);
    return r === TIMED_OUT ? { success: false } : r;
  };
}

export interface RequestContext {
  ip: string;
  apiKey: ApiKeyConfig | undefined;
}

export interface Outcome<T> {
  status: number;
  body: T;
  retryAfterSeconds?: number;
}

interface NetworkRuntime {
  config: NetworkConfig;
  signer: NetworkSigner;
  schemes: Set<string>;
  permit2: { deployed: boolean; exactProxy: boolean; uptoProxy: boolean; probedAt: string | null };
  rpcOk: boolean;
  lastError: string | undefined;
  balanceCache: { at: number; wei: bigint } | undefined;
}

interface StellarRuntime {
  config: StellarNetworkConfig;
  chain: StellarChain;
  schemes: Set<string>;
  rpcOk: boolean;
  /** Set when the RPC serves a different network than configured: every request is refused. */
  misconfigured: string | undefined;
  lastError: string | undefined;
  balanceCache: Map<string, { at: number; stroops: bigint }>;
}

/** A Stellar broadcast whose outcome was not known when settle answered `settlement_pending`. */
interface StellarPendingBroadcast {
  network: string;
  transaction: string;
  lastValidLedger: number | undefined;
  scopes: BudgetScope[];
  chargedStroops: bigint;
  at: number;
}

export interface FacilitatorServiceDeps {
  denylist?: AddressScreener;
  rateLimiters?: { ip: RateLimiter; payer: RateLimiter; payTo: RateLimiter; global?: RateLimiter };
  gasBudget?: GasBudget;
  feePolicy?: FeePolicy;
  now?: () => number;
  /** Daily Stellar fee budgets (stroops), kept apart from the EVM gas budget (wei). */
  stellarFeeBudget?: GasBudget;
  /** Per-Stellar-network ceiling on verify+settle calls (keyed by network id). */
  stellarGlobalLimiter?: RateLimiter;
  /** Stellar RPC call timeout and probe budget (ms; tests shorten them). */
  stellarTimeouts?: { rpcMs?: number; probeMs?: number };
}

type HealthReport = { status: "ok" | "degraded"; body: Record<string, unknown> };

/**
 * Wraps @x402/core's `x402Facilitator` (with the official @x402/evm scheme implementations) in
 * the operating policy a public gas sponsor needs: rate limits, sanctions screening, daily gas
 * budgets, replay/duplicate protection, API keys and a fee hook.
 */
export class FacilitatorService {
  readonly config: FacilitatorConfig;
  readonly metrics = new Metrics();
  readonly address: Address;
  readonly gasBudget: GasBudget;
  readonly denylist: AddressScreener;
  readonly apiKeys: ApiKeyRegistry;
  readonly feePolicy: FeePolicy;
  private readonly log: Logger;
  private readonly facilitator = new x402Facilitator();
  private readonly networks = new Map<string, NetworkRuntime>();
  private readonly limiters: { ip: RateLimiter; payer: RateLimiter; payTo: RateLimiter; global?: RateLimiter };
  private readonly dedupe = new AuthorizationRegistry();
  private readonly pendingCharged = new Map<string, { scopes: BudgetScope[]; chargedWei: bigint }>();
  readonly stellarFeeBudget: GasBudget;
  private readonly stellarNetworks = new Map<string, StellarRuntime>();
  private readonly stellarGlobal: RateLimiter | undefined;
  private readonly stellarPending = new Map<string, StellarPendingBroadcast>();
  private readonly stellarProbeMs: number;
  private healthCache: { at: number; report: HealthReport } | undefined;
  private healthInFlight: Promise<HealthReport> | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(config: FacilitatorConfig, logger: Logger, deps: FacilitatorServiceDeps = {}) {
    this.config = config;
    this.log = logger.child({ component: "facilitator" });
    const account = privateKeyToAccount(config.privateKey);
    this.address = account.address;
    this.gasBudget = deps.gasBudget ?? new GasBudget({ now: deps.now });
    this.denylist =
      deps.denylist ??
      new FileDenylist(config.denylistFile, {
        reloadSeconds: config.denylistReloadSeconds,
        onReload: (count) => this.log.info({ file: config.denylistFile, count }, "denylist loaded"),
        onError: (error) => this.log.error({ file: config.denylistFile, err: loggableErrorMessage(error) }, "denylist reload failed"),
      });
    this.apiKeys = new ApiKeyRegistry(config.apiKeys);
    this.feePolicy = deps.feePolicy ?? createFeePolicy(config.fee);
    const windowMs = config.rateLimit.windowSeconds * 1000;
    this.limiters = deps.rateLimiters ?? {
      ip: new TokenBucketRateLimiter({ limit: config.rateLimit.ipPerWindow, windowMs, maxKeys: config.rateLimit.maxKeys }),
      payer: new TokenBucketRateLimiter({ limit: config.rateLimit.payerPerWindow, windowMs, maxKeys: config.rateLimit.maxKeys }),
      payTo: new TokenBucketRateLimiter({ limit: config.rateLimit.payToPerWindow, windowMs, maxKeys: config.rateLimit.maxKeys }),
      ...(config.rateLimit.globalPerWindow > 0
        ? { global: new TokenBucketRateLimiter({ limit: config.rateLimit.globalPerWindow, windowMs, maxKeys: 1 }) }
        : {}),
    };

    for (const network of config.networks) {
      const signer = new NetworkSigner(network, account, {
        maxSettleGas: config.maxSettleGas,
        confirmationTimeoutMs: config.confirmationTimeoutMs,
        logger: this.log,
      });
      this.networks.set(network.id, {
        config: network,
        signer,
        schemes: new Set(),
        permit2: { deployed: false, exactProxy: false, uptoProxy: false, probedAt: null },
        rpcOk: false,
        lastError: undefined,
        balanceCache: undefined,
      });
      // `exact` (EIP-3009 and, where the proxy exists, Permit2) on every configured network.
      this.facilitator.register(
        network.id,
        new ExactEvmScheme(signer.facilitatorSigner, { simulateInSettle: config.simulateInSettle }),
      );
      this.networks.get(network.id)!.schemes.add("exact");
    }
    this.facilitator.registerExtension({ key: EIP2612_GAS_SPONSORING_KEY });

    // Stellar (optional): one ExactStellarScheme per network, driven by @x402/stellar's own
    // verify/settle, with this service's policy around it (see verifyStellar / settleStellar).
    this.stellarFeeBudget = deps.stellarFeeBudget ?? new GasBudget({ now: deps.now });
    const stellar = config.stellar;
    this.stellarGlobal =
      deps.stellarGlobalLimiter ??
      (stellar && stellar.globalPerWindow > 0
        ? new TokenBucketRateLimiter({ limit: stellar.globalPerWindow, windowMs, maxKeys: stellar.networks.length + 1 })
        : undefined);
    const stellarRpcMs = deps.stellarTimeouts?.rpcMs ?? STELLAR_RPC_TIMEOUT_MS;
    this.stellarProbeMs = deps.stellarTimeouts?.probeMs ?? STELLAR_PROBE_BUDGET_MS;
    for (const network of stellar?.networks ?? []) {
      const chain = new StellarChain(network, stellar!.secretKeys, { rpcTimeoutMs: stellarRpcMs });
      this.stellarNetworks.set(network.id, {
        config: network,
        chain,
        schemes: new Set(["exact"]),
        rpcOk: false,
        misconfigured: undefined,
        lastError: undefined,
        balanceCache: new Map(),
      });
      const scheme = new ExactStellarScheme(chain.signers, {
        rpcConfig: { url: network.rpcUrl },
        maxTransactionFeeStroops: network.maxFeeStroops,
        inclusionFeeStroops: network.inclusionFeeStroops,
        selectSigner: selectLeasedSigner,
      });
      boundPolling(scheme, stellarRpcMs);
      this.facilitator.register(network.id, scheme);
    }
  }

  /** Stellar fee-payer accounts per network (fund these with XLM; friendbot on testnet). */
  stellarSigners(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [id, rt] of this.stellarNetworks) out[id] = [...rt.chain.addresses];
    return out;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Probes every network (chain id, Permit2 proxies). Never throws for an unreachable RPC. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.probeNetworks();
    if (this.config.proxyProbeMinutes > 0) {
      this.probeTimer = setInterval(() => void this.probeNetworks(), this.config.proxyProbeMinutes * 60_000);
      this.probeTimer.unref();
    }
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = undefined;
  }

  private async probeNetworks(): Promise<void> {
    await Promise.all([
      ...[...this.networks.values()].map((rt) => this.probeNetwork(rt)),
      // A stalled Stellar RPC never holds the start (and so the listen, and Whitechain with it):
      // the probe keeps running and sets rpcOk when it ends; until then the network is not ready.
      ...[...this.stellarNetworks.values()].map((rt) => withDeadline(this.probeStellarNetwork(rt), this.stellarProbeMs)),
    ]);
  }

  private async probeStellarNetwork(rt: StellarRuntime): Promise<void> {
    const { chain, config } = rt;
    try {
      const passphrase = await chain.passphrase();
      if (passphrase !== config.networkPassphrase) {
        rt.rpcOk = false;
        rt.misconfigured = `RPC ${redactUrl(config.rpcUrl)} serves "${passphrase}", ${config.id} is "${config.networkPassphrase}"`;
        rt.lastError = rt.misconfigured;
        this.log.error({ network: config.id, passphrase }, "Stellar network passphrase mismatch; network disabled");
        return;
      }
      rt.misconfigured = undefined;
      const ledger = await chain.latestLedger();
      rt.rpcOk = true;
      rt.lastError = undefined;
      this.log.info({ network: config.id, rpc: redactUrl(config.rpcUrl), ledger, signers: chain.addresses }, "network ready");
    } catch (error) {
      rt.rpcOk = false;
      rt.lastError = publicErrorMessage(error);
      this.log.warn({ network: config.id, rpc: redactUrl(config.rpcUrl), err: loggableErrorMessage(error) }, "network probe failed");
    }
  }

  private async probeNetwork(rt: NetworkRuntime): Promise<void> {
    const { signer, config } = rt;
    try {
      const chain = await signer.chainIdMatches();
      if (!chain.ok) {
        rt.rpcOk = false;
        rt.lastError = `RPC ${redactUrl(config.rpcUrl)} serves chain ${chain.actual}, config says ${config.chainId}`;
        this.log.error({ network: config.id, actual: chain.actual }, "chain id mismatch; network disabled");
        return;
      }
      const [permit2, exactProxy, uptoProxy] = await Promise.all([
        signer.hasCode(PERMIT2_ADDRESS as Address),
        signer.hasCode(x402ExactPermit2ProxyAddress as Address),
        signer.hasCode(x402UptoPermit2ProxyAddress as Address),
      ]);
      rt.permit2 = { deployed: permit2, exactProxy, uptoProxy, probedAt: new Date().toISOString() };
      rt.rpcOk = true;
      rt.lastError = undefined;
      if (this.config.schemes.has("upto") && uptoProxy && permit2 && !rt.schemes.has("upto")) {
        this.facilitator.register(config.id, new UptoEvmScheme(signer.facilitatorSigner));
        rt.schemes.add("upto");
        this.log.info({ network: config.id }, "x402 Upto Permit2 proxy found; `upto` scheme enabled");
      }
      this.log.info(
        { network: config.id, rpc: redactUrl(config.rpcUrl), permit2, exactProxy, uptoProxy, signer: signer.address },
        "network ready",
      );
    } catch (error) {
      rt.rpcOk = false;
      rt.lastError = publicErrorMessage(error);
      this.log.warn({ network: config.id, rpc: redactUrl(config.rpcUrl), err: loggableErrorMessage(error) }, "network probe failed");
    }
  }

  // ---------------------------------------------------------------- public API

  supported(): SupportedResponse {
    this.metrics.inc("http.supported");
    return this.facilitator.getSupported() as SupportedResponse;
  }

  network(id: string): NetworkRuntime | undefined {
    return this.networks.get(id);
  }

  async verify(req: ParsedFacilitatorRequest, ctx: RequestContext): Promise<Outcome<VerifyResponse>> {
    if (isStellarNetworkId(req.paymentRequirements.network)) return this.verifyStellar(req, ctx);
    this.metrics.inc("verify.total");
    const payer = claimedPayer(req.paymentPayload.payload);
    const { paymentRequirements: reqs } = req;
    try {
      const rt = this.admit(req, ctx, payer);
      const dupKey = authorizationKey(reqs.network, reqs.asset, req.paymentPayload.payload);
      if (dupKey) {
        const state = this.dedupe.lookup(dupKey);
        if (state) {
          this.metrics.inc("policy.duplicate");
          throw new PolicyError(
            Reasons.duplicateSettlement,
            state.kind === "in-flight"
              ? "this authorization is being settled right now"
              : `this authorization was already settled in ${state.transaction}`,
            409,
          );
        }
      }
      await this.assertGasAvailable(rt, reqs.payTo, ctx.apiKey);

      const sctx: SettlementContext = {};
      let result = await settlementContext.run(sctx, () => this.facilitator.verify(req.paymentPayload, reqs));
      result = sanitizeMessages(normalizeGasCapReason(result, sctx));
      if (result.isValid) {
        this.metrics.inc("verify.valid");
        this.consumeIdentityLimits(payer, reqs.payTo, ctx.apiKey);
      } else {
        this.metrics.inc("verify.invalid");
        this.metrics.reason("verify", result.invalidReason);
      }
      this.log.info(
        {
          op: "verify",
          network: reqs.network,
          scheme: reqs.scheme,
          asset: reqs.asset,
          amount: reqs.amount,
          payTo: reqs.payTo,
          payer: result.payer ?? payer,
          isValid: result.isValid,
          reason: result.invalidReason,
          apiKey: ctx.apiKey?.name,
        },
        "verify",
      );
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof PolicyError) {
        this.metrics.inc("verify.invalid");
        this.metrics.reason("verify", error.reason);
        this.log.info({ op: "verify", network: reqs.network, payTo: reqs.payTo, payer, reason: error.reason, status: error.status }, "verify refused");
        return {
          status: error.status,
          body: { isValid: false, invalidReason: error.reason, invalidMessage: error.message, payer },
          retryAfterSeconds: error.retryAfterSeconds,
        };
      }
      this.metrics.inc("verify.error");
      this.metrics.reason("verify", Reasons.unexpectedVerifyError);
      this.log.error({ op: "verify", network: reqs.network, err: loggableErrorMessage(error) }, "verify failed unexpectedly");
      return {
        status: 500,
        body: { isValid: false, invalidReason: Reasons.unexpectedVerifyError, invalidMessage: publicErrorMessage(error), payer },
      };
    }
  }

  async settle(req: ParsedFacilitatorRequest, ctx: RequestContext): Promise<Outcome<SettleResponse>> {
    if (isStellarNetworkId(req.paymentRequirements.network)) return this.settleStellar(req, ctx);
    this.metrics.inc("settle.total");
    const payer = claimedPayer(req.paymentPayload.payload);
    const { paymentRequirements: reqs } = req;
    const network = reqs.network;
    const failure = (reason: string, message: string, status: number, retryAfterSeconds?: number): Outcome<SettleResponse> => ({
      status,
      body: { success: false, errorReason: reason, errorMessage: message, transaction: "", network, payer },
      retryAfterSeconds,
    });

    let rt: NetworkRuntime;
    let dupKey: string | undefined;
    let reservation: Reservation | undefined;
    let scopes: BudgetScope[] = [];
    let estimateWei = 0n;
    let feeCtx: FeeContext | undefined;
    try {
      rt = this.admit(req, ctx, payer);

      feeCtx = {
        network,
        asset: reqs.asset,
        amount: BigInt(reqs.amount),
        payTo: reqs.payTo,
        payer,
        apiKeyName: ctx.apiKey?.name,
      };
      const quote = this.feePolicy.quote(feeCtx);
      if (!quote.sponsor) {
        this.metrics.reason("settle", Reasons.feePolicyRejected);
        throw new PolicyError(Reasons.feePolicyRejected, quote.message ?? "the facilitator does not sponsor this payment", 403);
      }

      dupKey = authorizationKey(network, reqs.asset, req.paymentPayload.payload);
      if (dupKey && !this.dedupe.begin(dupKey)) {
        const state = this.dedupe.lookup(dupKey);
        this.metrics.inc("policy.duplicate");
        dupKey = undefined; // not ours to release
        throw new PolicyError(
          Reasons.duplicateSettlement,
          state?.kind === "settled"
            ? `this authorization was already settled in ${state.transaction}`
            : "this authorization is being settled right now",
          409,
        );
      }

      estimateWei = await this.assertGasAvailable(rt, reqs.payTo, ctx.apiKey);
      scopes = this.budgetScopes(reqs.payTo, ctx.apiKey);
      const reserved = this.gasBudget.reserve(scopes, estimateWei);
      if (!reserved.ok || !reserved.reservation) {
        throw this.budgetError(rt, reserved.ok ? scopes[0]! : reserved.scope, reserved.ok ? 0n : reserved.remainingWei);
      }
      reservation = reserved.reservation;

      const sctx: SettlementContext = {};
      let result = await settlementContext.run(sctx, () => this.facilitator.settle(req.paymentPayload, reqs));
      result = sanitizeMessages(normalizeGasCapReason(result, sctx));
      await this.account(rt, result, reserved.reservation, scopes, estimateWei, dupKey, feeCtx, ctx);
      reservation = undefined;
      dupKey = undefined;

      if (result.success) {
        this.metrics.inc("settle.success");
        this.consumeIdentityLimits(payer, reqs.payTo, ctx.apiKey);
      } else if (result.errorReason === SETTLEMENT_PENDING) {
        this.metrics.inc("settle.pending");
        this.metrics.reason("settle", result.errorReason);
      } else {
        this.metrics.inc("settle.failed");
        this.metrics.reason("settle", result.errorReason);
      }
      this.log.info(
        {
          op: "settle",
          network,
          scheme: reqs.scheme,
          asset: reqs.asset,
          amount: result.amount ?? reqs.amount,
          payTo: reqs.payTo,
          payer: result.payer ?? payer,
          success: result.success,
          reason: result.errorReason,
          tx: result.transaction || undefined,
          explorer: result.transaction && rt.config.explorerUrl ? `${rt.config.explorerUrl}/tx/${result.transaction}` : undefined,
          apiKey: ctx.apiKey?.name,
        },
        "settle",
      );
      return { status: 200, body: result };
    } catch (error) {
      reservation?.release();
      if (dupKey) this.dedupe.end(dupKey);
      if (error instanceof PolicyError) {
        this.metrics.inc("settle.failed");
        this.metrics.reason("settle", error.reason);
        this.log.info({ op: "settle", network, payTo: reqs.payTo, payer, reason: error.reason, status: error.status }, "settle refused");
        return failure(error.reason, error.message, error.status, error.retryAfterSeconds);
      }
      this.metrics.inc("settle.error");
      this.metrics.reason("settle", Reasons.unexpectedSettleError);
      this.log.error({ op: "settle", network, err: loggableErrorMessage(error) }, "settle failed unexpectedly");
      return failure(Reasons.unexpectedSettleError, publicErrorMessage(error), 500);
    }
  }

  // ---------------------------------------------------------------- policy pipeline

  /** Shared admission checks: version, routing, API key scope, asset allowlist, rate limits, denylist. */
  private admit(req: ParsedFacilitatorRequest, ctx: RequestContext, payer: string | undefined): NetworkRuntime {
    const reqs = req.paymentRequirements;
    if (req.x402Version !== X402_VERSION || req.paymentPayload.x402Version !== X402_VERSION) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(Reasons.invalidRequest, `only x402Version ${X402_VERSION} is supported`, 400);
    }
    const rt = this.networks.get(reqs.network);
    if (!rt) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(
        Reasons.unsupportedSchemeNetwork,
        `network ${reqs.network} is not supported; see GET /supported`,
        400,
      );
    }
    if (!rt.schemes.has(reqs.scheme)) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(
        Reasons.unsupportedSchemeNetwork,
        `scheme ${reqs.scheme} is not supported on ${reqs.network}; see GET /supported`,
        400,
      );
    }
    if (req.paymentPayload.accepted.network !== reqs.network || req.paymentPayload.accepted.scheme !== reqs.scheme) {
      this.metrics.inc("policy.invalid_request");
      throw new PolicyError(Reasons.invalidRequest, "paymentPayload.accepted does not match paymentRequirements", 400);
    }
    if (rt.config.assets && !rt.config.assets.has(reqs.asset.toLowerCase())) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(Reasons.unsupportedAsset, `asset ${reqs.asset} is not accepted on ${reqs.network}`, 400);
    }
    if (ctx.apiKey?.payTo && !ctx.apiKey.payTo.has(reqs.payTo.toLowerCase())) {
      this.metrics.inc("policy.unauthorized");
      throw new PolicyError(Reasons.invalidApiKey, `API key ${ctx.apiKey.name} may not settle to ${reqs.payTo}`, 401);
    }

    // Per-caller limit (IP, or the API key when one is presented).
    const multiplier = ctx.apiKey?.rateLimitMultiplier ?? 1;
    const callerKey = ctx.apiKey ? `apikey:${ctx.apiKey.name}` : `ip:${ctx.ip}`;
    const caller = this.limiters.ip.consume(callerKey, 1, multiplier);
    if (!caller.allowed) throw this.rateLimitError(caller.retryAfterSeconds, "caller");
    // Facilitator-wide ceiling: every admitted verify/settle fans out into several RPC calls, so
    // many callers (or many spoofed source addresses) must not be able to exhaust the RPC quota.
    if (this.limiters.global) {
      const global = this.limiters.global.consume("global");
      if (!global.allowed) throw this.rateLimitError(global.retryAfterSeconds, "facilitator-wide");
    }
    // Payer / payTo buckets are only *consumed* for payments that verify, so forged payloads
    // cannot exhaust a victim's quota; here we just refuse when the bucket is already empty.
    if (payer) {
      const d = this.limiters.payer.peek(`payer:${payer.toLowerCase()}`, 1, multiplier);
      if (!d.allowed) throw this.rateLimitError(d.retryAfterSeconds, "payer");
    }
    const payToDecision = this.limiters.payTo.peek(`payto:${reqs.payTo.toLowerCase()}`, 1, multiplier);
    if (!payToDecision.allowed) throw this.rateLimitError(payToDecision.retryAfterSeconds, "payTo");

    if (payer && this.denylist.isDenied(payer)) {
      this.metrics.inc("policy.denylisted");
      throw new PolicyError(Reasons.addressDenylisted, "payer address is denylisted", 403);
    }
    if (this.denylist.isDenied(reqs.payTo)) {
      this.metrics.inc("policy.denylisted");
      throw new PolicyError(Reasons.addressDenylisted, "payTo address is denylisted", 403);
    }
    return rt;
  }

  private rateLimitError(retryAfterSeconds: number, what: string): PolicyError {
    this.metrics.inc("policy.rate_limited");
    return new PolicyError(
      Reasons.rateLimited,
      `${what} rate limit exceeded; retry in ${retryAfterSeconds}s or request an API key`,
      429,
      retryAfterSeconds,
    );
  }

  private consumeIdentityLimits(payer: string | undefined, payTo: string, apiKey: ApiKeyConfig | undefined): void {
    const multiplier = apiKey?.rateLimitMultiplier ?? 1;
    if (payer) this.limiters.payer.consume(`payer:${payer.toLowerCase()}`, 1, multiplier);
    this.limiters.payTo.consume(`payto:${payTo.toLowerCase()}`, 1, multiplier);
  }

  private budgetScopes(payTo: string, apiKey: ApiKeyConfig | undefined): BudgetScope[] {
    const scopes: BudgetScope[] = [{ key: "global", limitWei: this.config.gasBudget.globalDailyWei }];
    if (apiKey?.dailyGasBudgetWei !== undefined) {
      scopes.push({ key: `apikey:${apiKey.name}`, limitWei: apiKey.dailyGasBudgetWei });
    } else {
      scopes.push({ key: `payto:${payTo.toLowerCase()}`, limitWei: this.config.gasBudget.perPayToDailyWei });
    }
    return scopes;
  }

  private budgetError(rt: NetworkRuntime, scope: BudgetScope, remainingWei: bigint): PolicyError {
    this.metrics.inc("policy.gas_budget_exceeded");
    const who = scope.key === "global" ? "the facilitator's global" : `this ${scope.key.split(":")[0]}'s`;
    const reset = this.gasBudget.secondsUntilReset();
    return new PolicyError(
      Reasons.gasBudgetExceeded,
      `${who} daily gas budget is exhausted (remaining ${formatUnits(remainingWei, rt.config.nativeDecimals)} ${rt.config.nativeSymbol}); resets at 00:00 UTC in ${reset}s`,
      429,
      reset,
    );
  }

  /** Checks budgets and signer balance; returns the reservation estimate in wei. */
  private async assertGasAvailable(rt: NetworkRuntime, payTo: string, apiKey: ApiKeyConfig | undefined): Promise<bigint> {
    let estimateWei: bigint;
    try {
      estimateWei = await rt.signer.estimatedSettleCostWei(this.config.settleGasEstimate);
    } catch (error) {
      this.log.warn({ network: rt.config.id, err: loggableErrorMessage(error) }, "RPC unavailable");
      throw new PolicyError(Reasons.rpcUnavailable, `the RPC for ${rt.config.id} is unavailable: ${publicErrorMessage(error, 160)}`, 503, 15);
    }
    const check = this.gasBudget.check(this.budgetScopes(payTo, apiKey), estimateWei);
    if (!check.ok) throw this.budgetError(rt, check.scope, check.remainingWei);
    const balance = await this.cachedBalance(rt);
    if (balance < estimateWei) {
      this.log.error({ network: rt.config.id, balance: balance.toString(), need: estimateWei.toString() }, "facilitator wallet out of gas");
      throw new PolicyError(
        Reasons.facilitatorOutOfGas,
        `the facilitator wallet ${rt.signer.address} cannot pay for gas on ${rt.config.id} right now`,
        503,
        60,
      );
    }
    return estimateWei;
  }

  private async cachedBalance(rt: NetworkRuntime, force = false): Promise<bigint> {
    const now = Date.now();
    if (!force && rt.balanceCache && now - rt.balanceCache.at < BALANCE_CACHE_MS) return rt.balanceCache.wei;
    const wei = await rt.signer.balance();
    rt.balanceCache = { at: now, wei };
    return wei;
  }

  /** Converts a settle result into budget, dedupe, fee and metrics bookkeeping. */
  private async account(
    rt: NetworkRuntime,
    result: SettleResponse,
    reservation: Reservation,
    scopes: BudgetScope[],
    estimateWei: bigint,
    dupKey: string | undefined,
    feeCtx: FeeContext,
    ctx: RequestContext,
  ): Promise<void> {
    const tx = result.transaction || undefined;
    if (!tx) {
      // Nothing was broadcast: no gas spent, the authorization is still unused.
      reservation.release();
      if (dupKey) this.dedupe.end(dupKey);
      return;
    }
    rt.balanceCache = undefined;
    const previously = this.pendingCharged.get(tx);
    let cost = rt.signer.takeTxCost(tx);
    if (!cost && result.errorReason !== SETTLEMENT_PENDING) cost = await rt.signer.fetchTxCost(tx);

    if (cost) {
      this.metrics.inc("gas.tx");
      if (previously) {
        // A retry reconciled a pending tx we already charged at the estimate: apply the delta.
        this.pendingCharged.delete(tx);
        reservation.release();
        const delta = cost.costWei - previously.chargedWei;
        this.gasBudget.record(previously.scopes, delta);
        this.metrics.addGas(rt.config.id, delta > 0n ? delta : 0n);
      } else {
        reservation.settle(cost.costWei);
        this.metrics.addGas(rt.config.id, cost.costWei);
      }
    } else {
      // Broadcast but no receipt yet (settlement_pending): charge the estimate for now.
      reservation.settle(estimateWei);
      this.metrics.addGas(rt.config.id, estimateWei);
      if (!previously) {
        if (this.pendingCharged.size >= 10_000) {
          const oldest = this.pendingCharged.keys().next().value;
          if (oldest) this.pendingCharged.delete(oldest);
        }
        this.pendingCharged.set(tx, { scopes, chargedWei: estimateWei });
      }
    }

    if (result.success) {
      if (dupKey) this.dedupe.settled(dupKey, tx);
      this.metrics.addSettledAmount(rt.config.id, feeCtx.asset, BigInt(result.amount ?? feeCtx.amount));
      this.feePolicy.onSettled({ ...feeCtx, payer: result.payer ?? feeCtx.payer }, this.feePolicy.quote(feeCtx), tx);
    } else if (dupKey) {
      // Pending (retry will reconcile) or reverted (authorization unused): allow another attempt.
      this.dedupe.end(dupKey);
    }
    void ctx;
  }

  // ---------------------------------------------------------------- Stellar
  //
  // Same policy as the EVM path, applied per Stellar network: admission (version, routing,
  // scheme, asset allowlist, API-key scope, caller / network-wide / payer / payTo rate limits,
  // sanctions screening), replay protection on the Soroban auth nonce, daily fee budgets in
  // stroops and a fee-payer balance check. @x402/stellar's ExactStellarScheme does the actual
  // verification (transaction shape, simulation, transfer events, auth entries) and settlement.

  private stellarPassphrase(network: string): string {
    return this.stellarNetworks.get(network)?.config.networkPassphrase ?? STELLAR_TESTNET_PASSPHRASE;
  }

  private async verifyStellar(req: ParsedFacilitatorRequest, ctx: RequestContext): Promise<Outcome<VerifyResponse>> {
    this.metrics.inc("verify.total");
    const { paymentRequirements: reqs } = req;
    const payment = decodeStellarPayment(req.paymentPayload.payload, this.stellarPassphrase(reqs.network));
    const payer = payment?.from;
    try {
      const rt = this.admitStellar(req, ctx, payer);
      const dupKey = stellarAuthorizationKey(reqs.network, payment);
      if (dupKey) {
        const state = this.dedupe.lookup(dupKey);
        if (state) {
          this.metrics.inc("policy.duplicate");
          throw new PolicyError(
            Reasons.duplicateSettlement,
            state.kind === "in-flight"
              ? "this authorization is being settled right now"
              : `this authorization was already settled in ${state.transaction}`,
            409,
          );
        }
      }
      await this.assertStellarFeeAvailable(rt, reqs.payTo, ctx.apiKey);

      const result = sanitizeMessages(await this.facilitator.verify(req.paymentPayload, reqs));
      if (result.isValid) {
        this.metrics.inc("verify.valid");
        this.consumeStellarIdentityLimits(reqs.network, payer, reqs.payTo, ctx.apiKey);
      } else {
        this.metrics.inc("verify.invalid");
        this.metrics.reason("verify", result.invalidReason);
      }
      this.log.info(
        {
          op: "verify",
          network: reqs.network,
          scheme: reqs.scheme,
          asset: reqs.asset,
          amount: reqs.amount,
          payTo: reqs.payTo,
          payer: result.payer ?? payer,
          isValid: result.isValid,
          reason: result.invalidReason,
          apiKey: ctx.apiKey?.name,
        },
        "verify",
      );
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof PolicyError) {
        this.metrics.inc("verify.invalid");
        this.metrics.reason("verify", error.reason);
        this.log.info({ op: "verify", network: reqs.network, payTo: reqs.payTo, payer, reason: error.reason, status: error.status }, "verify refused");
        return {
          status: error.status,
          body: { isValid: false, invalidReason: error.reason, invalidMessage: error.message, payer },
          retryAfterSeconds: error.retryAfterSeconds,
        };
      }
      this.metrics.inc("verify.error");
      this.metrics.reason("verify", Reasons.unexpectedVerifyError);
      this.log.error({ op: "verify", network: reqs.network, err: loggableErrorMessage(error) }, "verify failed unexpectedly");
      return {
        status: 500,
        body: { isValid: false, invalidReason: Reasons.unexpectedVerifyError, invalidMessage: publicErrorMessage(error), payer },
      };
    }
  }

  private async settleStellar(req: ParsedFacilitatorRequest, ctx: RequestContext): Promise<Outcome<SettleResponse>> {
    this.metrics.inc("settle.total");
    const { paymentRequirements: reqs } = req;
    const network = reqs.network;
    const payment = decodeStellarPayment(req.paymentPayload.payload, this.stellarPassphrase(network));
    const payer = payment?.from;
    const failure = (reason: string, message: string, status: number, retryAfterSeconds?: number): Outcome<SettleResponse> => ({
      status,
      body: { success: false, errorReason: reason, errorMessage: message, transaction: "", network, payer },
      retryAfterSeconds,
    });

    let dupKey: string | undefined;
    let reservation: Reservation | undefined;
    let lease: { address: string; release(): void } | undefined;
    try {
      const rt = this.admitStellar(req, ctx, payer);
      const feeCtx: FeeContext = {
        network,
        asset: reqs.asset,
        amount: BigInt(reqs.amount),
        payTo: reqs.payTo,
        payer,
        apiKeyName: ctx.apiKey?.name,
      };
      const quote = this.feePolicy.quote(feeCtx);
      if (!quote.sponsor) {
        this.metrics.reason("settle", Reasons.feePolicyRejected);
        throw new PolicyError(Reasons.feePolicyRejected, quote.message ?? "the facilitator does not sponsor this payment", 403);
      }

      dupKey = stellarAuthorizationKey(network, payment);
      if (dupKey && !this.dedupe.begin(dupKey)) {
        const state = this.dedupe.lookup(dupKey);
        this.metrics.inc("policy.duplicate");
        dupKey = undefined; // not ours to release
        throw new PolicyError(
          Reasons.duplicateSettlement,
          state?.kind === "settled"
            ? `this authorization was already settled in ${state.transaction}`
            : "this authorization is being settled right now",
          409,
        );
      }

      // An earlier settle of this authorization answered settlement_pending: learn what happened
      // to that broadcast before signing anything new.
      if (dupKey) {
        const reconciled = await this.reconcileStellarPending(rt, dupKey, feeCtx, ctx);
        if (reconciled?.success) {
          dupKey = undefined; // recorded as settled by the reconciliation
          return { status: 200, body: reconciled };
        }
        if (reconciled) {
          this.dedupe.end(dupKey);
          dupKey = undefined;
          this.metrics.inc("settle.pending");
          this.metrics.reason("settle", SETTLEMENT_PENDING);
          return { status: 200, body: reconciled, retryAfterSeconds: 5 };
        }
      }

      const estimate = BigInt(rt.config.maxFeeStroops);
      const scopes = this.stellarBudgetScopes(network, reqs.payTo, ctx.apiKey);
      const reserved = this.stellarFeeBudget.reserve(scopes, estimate);
      if (!reserved.ok || !reserved.reservation) {
        throw this.stellarBudgetError(rt, reserved.ok ? scopes[0]! : reserved.scope, reserved.ok ? 0n : reserved.remainingWei);
      }
      reservation = reserved.reservation;

      const acquired = await rt.chain.pool.acquire(this.config.stellar?.settleQueueTimeoutMs ?? 0);
      if (!acquired) {
        throw new PolicyError(
          Reasons.facilitatorBusy,
          `all ${rt.chain.addresses.length} Stellar fee account(s) on ${network} are busy settling; retry shortly`,
          503,
          5,
        );
      }
      lease = await this.fundedStellarLease(rt, acquired, estimate);

      const leased = lease.address;
      const signerCtx: { address: string; signedHash?: string } = { address: leased };
      let result = sanitizeMessages(
        await stellarSignerContext.run(signerCtx, () => this.facilitator.settle(req.paymentPayload, reqs)),
      );
      // The SDK learns the hash only from sendTransaction's answer: when that call fails (a 502/504,
      // a reset) after the RPC may have taken the transaction, it reports no hash at all. The one the
      // fee payer signed is what to look for; it is then checked like any other broadcast.
      if (!result.transaction && result.errorReason === Reasons.unexpectedSettleError && signerCtx.signedHash) {
        this.log.warn({ op: "settle", network, tx: signerCtx.signedHash }, "Stellar submission answer lost after signing; checking the signed transaction");
        result = { ...result, transaction: signerCtx.signedHash };
      }
      let final: StellarTxStatus | undefined;
      if (result.transaction) {
        // The real fee, and for a reported failure whether the transfer landed after all (the
        // SDK gives up polling after maxTimeoutSeconds attempts and then reports a failure).
        final = await rt.chain.awaitFinal(result.transaction, payment?.expirationLedger, result.success ? 10_000 : STELLAR_RECONCILE_MS);
        if (!result.success && final?.status === "SUCCESS") {
          this.log.warn({ op: "settle", network, tx: result.transaction, sdkReason: result.errorReason }, "Stellar settlement confirmed after the SDK reported a failure");
          result = { success: true, transaction: result.transaction, network, payer: result.payer ?? payer };
        } else if (!result.success && final === undefined) {
          result = { ...result, errorReason: SETTLEMENT_PENDING, errorMessage: "broadcast, not yet final; retry settle with the same payload" };
        }
      }
      lease.release();
      lease = undefined;

      this.accountStellar(rt, result, reservation, scopes, estimate, dupKey, feeCtx, final, payment);
      reservation = undefined;
      dupKey = undefined;

      if (result.success) {
        this.metrics.inc("settle.success");
        this.consumeStellarIdentityLimits(network, payer, reqs.payTo, ctx.apiKey);
      } else if (result.errorReason === SETTLEMENT_PENDING) {
        this.metrics.inc("settle.pending");
        this.metrics.reason("settle", result.errorReason);
      } else {
        this.metrics.inc("settle.failed");
        this.metrics.reason("settle", result.errorReason);
      }
      this.log.info(
        {
          op: "settle",
          network,
          scheme: reqs.scheme,
          asset: reqs.asset,
          amount: reqs.amount,
          payTo: reqs.payTo,
          payer: result.payer ?? payer,
          success: result.success,
          reason: result.errorReason,
          tx: result.transaction || undefined,
          feeStroops: final && final.status !== "NOT_FOUND" ? final.feeChargedStroops.toString() : undefined,
          feePayer: leased,
          explorer: result.transaction ? `${rt.config.explorerUrl}/tx/${result.transaction}` : undefined,
          apiKey: ctx.apiKey?.name,
        },
        "settle",
      );
      return {
        status: 200,
        body: result,
        ...(result.errorReason === SETTLEMENT_PENDING ? { retryAfterSeconds: 5 } : {}),
      };
    } catch (error) {
      lease?.release();
      reservation?.release();
      if (dupKey) this.dedupe.end(dupKey);
      if (error instanceof PolicyError) {
        this.metrics.inc("settle.failed");
        this.metrics.reason("settle", error.reason);
        this.log.info({ op: "settle", network, payTo: reqs.payTo, payer, reason: error.reason, status: error.status }, "settle refused");
        return failure(error.reason, error.message, error.status, error.retryAfterSeconds);
      }
      this.metrics.inc("settle.error");
      this.metrics.reason("settle", Reasons.unexpectedSettleError);
      this.log.error({ op: "settle", network, err: loggableErrorMessage(error) }, "settle failed unexpectedly");
      return failure(Reasons.unexpectedSettleError, publicErrorMessage(error), 500);
    }
  }

  /** Admission for Stellar: the EVM checks, with every rate-limit key scoped to the network. */
  private admitStellar(req: ParsedFacilitatorRequest, ctx: RequestContext, payer: string | undefined): StellarRuntime {
    const reqs = req.paymentRequirements;
    if (req.x402Version !== X402_VERSION || req.paymentPayload.x402Version !== X402_VERSION) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(Reasons.invalidRequest, `only x402Version ${X402_VERSION} is supported`, 400);
    }
    const rt = this.stellarNetworks.get(reqs.network);
    if (!rt) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(Reasons.unsupportedSchemeNetwork, `network ${reqs.network} is not supported; see GET /supported`, 400);
    }
    if (rt.misconfigured) {
      throw new PolicyError(Reasons.rpcUnavailable, `the RPC for ${reqs.network} serves a different network; the operator must fix STELLAR_NETWORKS`, 503, 60);
    }
    if (!rt.schemes.has(reqs.scheme)) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(Reasons.unsupportedSchemeNetwork, `scheme ${reqs.scheme} is not supported on ${reqs.network}; see GET /supported`, 400);
    }
    if (req.paymentPayload.accepted.network !== reqs.network || req.paymentPayload.accepted.scheme !== reqs.scheme) {
      this.metrics.inc("policy.invalid_request");
      throw new PolicyError(Reasons.invalidRequest, "paymentPayload.accepted does not match paymentRequirements", 400);
    }
    if (reqs.maxTimeoutSeconds < 1 || reqs.maxTimeoutSeconds > rt.config.maxTimeoutSeconds) {
      // The SDK polls once per second for maxTimeoutSeconds and lets the authorization live that
      // long, so an unbounded value would pin a fee-payer account (and an HTTP request) for hours.
      this.metrics.inc("policy.invalid_request");
      throw new PolicyError(
        Reasons.invalidRequest,
        `maxTimeoutSeconds must be between 1 and ${rt.config.maxTimeoutSeconds} on ${reqs.network}`,
        400,
      );
    }
    if (BigInt(reqs.amount) <= 0n) {
      this.metrics.inc("policy.invalid_request");
      throw new PolicyError(Reasons.invalidRequest, "amount must be a positive integer (zero-value transfers are not sponsored)", 400);
    }
    if (rt.config.assets && !rt.config.assets.has(reqs.asset)) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(Reasons.unsupportedAsset, `asset ${reqs.asset} is not accepted on ${reqs.network}`, 400);
    }
    // A key restricted to a G… account may settle to that account's muxed M… addresses too.
    if (ctx.apiKey?.payTo && !screeningAddresses(reqs.payTo).some((a) => ctx.apiKey!.payTo!.has(a))) {
      this.metrics.inc("policy.unauthorized");
      throw new PolicyError(Reasons.invalidApiKey, `API key ${ctx.apiKey.name} may not settle to ${reqs.payTo}`, 401);
    }

    const prefix = `${reqs.network}|`;
    const multiplier = ctx.apiKey?.rateLimitMultiplier ?? 1;
    const callerKey = prefix + (ctx.apiKey ? `apikey:${ctx.apiKey.name}` : `ip:${ctx.ip}`);
    const caller = this.limiters.ip.consume(callerKey, 1, multiplier);
    if (!caller.allowed) throw this.rateLimitError(caller.retryAfterSeconds, "caller");
    // Network-wide ceiling: each verify fans out into a simulation plus ledger reads, each settle
    // into a verify, a submission and up to maxTimeoutSeconds confirmation polls.
    if (this.stellarGlobal) {
      const global = this.stellarGlobal.consume(reqs.network);
      if (!global.allowed) throw this.rateLimitError(global.retryAfterSeconds, `${reqs.network} network-wide`);
    }
    // As on EVM, payer / payTo buckets are only consumed by payments that verify.
    if (payer) {
      const d = this.limiters.payer.peek(`${prefix}payer:${accountKey(payer)}`, 1, multiplier);
      if (!d.allowed) throw this.rateLimitError(d.retryAfterSeconds, "payer");
    }
    const payToDecision = this.limiters.payTo.peek(`${prefix}payto:${accountKey(reqs.payTo)}`, 1, multiplier);
    if (!payToDecision.allowed) throw this.rateLimitError(payToDecision.retryAfterSeconds, "payTo");

    if (payer && screeningAddresses(payer).some((a) => this.denylist.isDenied(a))) {
      this.metrics.inc("policy.denylisted");
      throw new PolicyError(Reasons.addressDenylisted, "payer address is denylisted", 403);
    }
    if (screeningAddresses(reqs.payTo).some((a) => this.denylist.isDenied(a))) {
      this.metrics.inc("policy.denylisted");
      throw new PolicyError(Reasons.addressDenylisted, "payTo address is denylisted", 403);
    }
    return rt;
  }

  private consumeStellarIdentityLimits(network: string, payer: string | undefined, payTo: string, apiKey: ApiKeyConfig | undefined): void {
    const multiplier = apiKey?.rateLimitMultiplier ?? 1;
    if (payer) this.limiters.payer.consume(`${network}|payer:${accountKey(payer)}`, 1, multiplier);
    this.limiters.payTo.consume(`${network}|payto:${accountKey(payTo)}`, 1, multiplier);
  }

  private stellarBudgetScopes(network: string, payTo: string, apiKey: ApiKeyConfig | undefined): BudgetScope[] {
    const budget = this.config.stellar?.feeBudget;
    const scopes: BudgetScope[] = [{ key: `${network}|global`, limitWei: budget?.globalDailyStroops ?? null }];
    if (apiKey?.dailyStellarFeeBudgetStroops !== undefined) {
      scopes.push({ key: `${network}|apikey:${apiKey.name}`, limitWei: apiKey.dailyStellarFeeBudgetStroops });
    } else {
      scopes.push({ key: `${network}|payto:${accountKey(payTo)}`, limitWei: budget?.perPayToDailyStroops ?? null });
    }
    return scopes;
  }

  private stellarBudgetError(rt: StellarRuntime, scope: BudgetScope, remaining: bigint): PolicyError {
    this.metrics.inc("policy.gas_budget_exceeded");
    const kind = scope.key.split("|")[1]?.split(":")[0] ?? "global";
    const who = kind === "global" ? "the facilitator's global" : `this ${kind}'s`;
    const reset = this.stellarFeeBudget.secondsUntilReset();
    return new PolicyError(
      Reasons.gasBudgetExceeded,
      `${who} daily network-fee budget on ${rt.config.id} is exhausted (remaining ${formatUnits(remaining, rt.config.nativeDecimals)} ${rt.config.nativeSymbol}); resets at 00:00 UTC in ${reset}s`,
      429,
      reset,
    );
  }

  /** Budget check plus "can some fee-payer account pay the worst-case fee" (verify). */
  private async assertStellarFeeAvailable(rt: StellarRuntime, payTo: string, apiKey: ApiKeyConfig | undefined): Promise<void> {
    const estimate = BigInt(rt.config.maxFeeStroops);
    const check = this.stellarFeeBudget.check(this.stellarBudgetScopes(rt.config.id, payTo, apiKey), estimate);
    if (!check.ok) throw this.stellarBudgetError(rt, check.scope, check.remainingWei);
    let best = 0n;
    let bestAddress = rt.chain.addresses[0]!;
    try {
      for (const address of rt.chain.addresses) {
        const spendable = await this.cachedStellarBalance(rt, address);
        if (spendable > best) {
          best = spendable;
          bestAddress = address;
        }
        if (best >= estimate) return;
      }
    } catch (error) {
      throw this.stellarRpcError(rt, error);
    }
    this.stellarOutOfFunds(rt, bestAddress, best, estimate);
  }

  /**
   * A lease on an account that can pay the worst-case fee (settle): `first` when it can, else
   * another idle account that can, so an unfunded or drained key never fails a settle while a
   * funded one is free. The accounts that cannot pay are held while the others are tried (so the
   * pool does not hand them straight back), then released. Throws facilitator_out_of_gas when no
   * idle account can pay; every lease is released then.
   */
  private async fundedStellarLease(rt: StellarRuntime, first: SignerLease, estimate: bigint): Promise<SignerLease> {
    const unfunded: { lease: SignerLease; spendable: bigint }[] = [];
    let current: SignerLease | undefined = first;
    try {
      while (current) {
        let spendable: bigint;
        try {
          spendable = await this.cachedStellarBalance(rt, current.address);
        } catch (error) {
          throw this.stellarRpcError(rt, error);
        }
        if (spendable >= estimate) {
          const funded = current;
          current = undefined;
          return funded;
        }
        unfunded.push({ lease: current, spendable });
        current = await rt.chain.pool.acquire(0);
      }
      const worst = unfunded[0]!;
      return this.stellarOutOfFunds(rt, worst.lease.address, worst.spendable, estimate);
    } finally {
      current?.release();
      for (const u of unfunded) u.lease.release();
    }
  }

  private stellarRpcError(rt: StellarRuntime, error: unknown): PolicyError {
    this.log.warn({ network: rt.config.id, err: loggableErrorMessage(error) }, "RPC unavailable");
    return new PolicyError(Reasons.rpcUnavailable, `the RPC for ${rt.config.id} is unavailable: ${publicErrorMessage(error, 160)}`, 503, 15);
  }

  private stellarOutOfFunds(rt: StellarRuntime, address: string, spendable: bigint, need: bigint): never {
    this.log.error({ network: rt.config.id, feePayer: address, spendable: spendable.toString(), need: need.toString() }, "Stellar fee account out of XLM");
    throw new PolicyError(
      Reasons.facilitatorOutOfGas,
      `the facilitator fee account ${address} cannot pay network fees on ${rt.config.id} right now`,
      503,
      60,
    );
  }

  private async cachedStellarBalance(rt: StellarRuntime, address: string, force = false): Promise<bigint> {
    const now = Date.now();
    const cached = rt.balanceCache.get(address);
    if (!force && cached && now - cached.at < BALANCE_CACHE_MS) return cached.stroops;
    const stroops = await rt.chain.spendableStroops(address);
    rt.balanceCache.set(address, { at: now, stroops });
    return stroops;
  }

  /**
   * Settles an earlier `settlement_pending` broadcast of this authorization, if there is one.
   * Returns the response to send (success, or still pending), or undefined when the caller should
   * proceed with a fresh settlement (the earlier broadcast failed or can no longer land).
   */
  private async reconcileStellarPending(
    rt: StellarRuntime,
    dupKey: string,
    feeCtx: FeeContext,
    ctx: RequestContext,
  ): Promise<SettleResponse | undefined> {
    const pending = this.stellarPending.get(dupKey);
    if (!pending) return undefined;
    const status = await rt.chain.awaitFinal(pending.transaction, pending.lastValidLedger, 0);
    const network = rt.config.id;
    if (!status || (status.status === "NOT_FOUND" && (pending.lastValidLedger === undefined || status.latestLedger <= pending.lastValidLedger))) {
      return {
        success: false,
        errorReason: SETTLEMENT_PENDING,
        errorMessage: "broadcast, not yet final; retry settle with the same payload",
        transaction: pending.transaction,
        network,
        payer: feeCtx.payer,
      };
    }
    this.stellarPending.delete(dupKey);
    rt.balanceCache.clear();
    const fee = status.status === "NOT_FOUND" ? 0n : status.feeChargedStroops;
    const delta = fee - pending.chargedStroops;
    this.stellarFeeBudget.record(pending.scopes, delta);
    if (delta !== 0n) this.metrics.addNetworkFee(network, delta);
    if (status.status !== "SUCCESS") return undefined;
    this.dedupe.settled(dupKey, pending.transaction);
    this.metrics.addSettledAmount(network, feeCtx.asset, feeCtx.amount);
    this.feePolicy.onSettled(feeCtx, this.feePolicy.quote(feeCtx), pending.transaction);
    this.metrics.inc("settle.success");
    this.consumeStellarIdentityLimits(network, feeCtx.payer, feeCtx.payTo, ctx.apiKey);
    this.log.info({ op: "settle", network, tx: pending.transaction, payer: feeCtx.payer, reconciled: true }, "settle");
    return { success: true, transaction: pending.transaction, network, payer: feeCtx.payer };
  }

  /** Budget, dedupe, fee and metrics bookkeeping for one Stellar settle result. */
  private accountStellar(
    rt: StellarRuntime,
    result: SettleResponse,
    reservation: Reservation,
    scopes: BudgetScope[],
    estimate: bigint,
    dupKey: string | undefined,
    feeCtx: FeeContext,
    final: StellarTxStatus | undefined,
    payment: StellarPayment | undefined,
  ): void {
    const tx = result.transaction || undefined;
    if (!tx) {
      // Nothing was broadcast: no fee spent, the authorization is still unused.
      reservation.release();
      if (dupKey) this.dedupe.end(dupKey);
      return;
    }
    rt.balanceCache.clear();
    const network = rt.config.id;
    if (final && final.status !== "NOT_FOUND") {
      this.metrics.inc("stellar.tx");
      reservation.settle(final.feeChargedStroops);
      this.metrics.addNetworkFee(network, final.feeChargedStroops);
    } else if (final) {
      // Never landed (the authorization expired first): no fee was charged.
      reservation.release();
    } else {
      // Fee (or, for a reported failure, the outcome) unknown: charge the worst case now.
      reservation.settle(estimate);
      this.metrics.addNetworkFee(network, estimate);
      // Only an undecided broadcast is reconciled on the merchant's retry; a confirmed success is
      // final and stays in the replay registry.
      if (dupKey && !result.success) {
        if (this.stellarPending.size >= 10_000) {
          const oldest = this.stellarPending.keys().next().value;
          if (oldest) this.stellarPending.delete(oldest);
        }
        this.stellarPending.set(dupKey, {
          network,
          transaction: tx,
          lastValidLedger: payment?.expirationLedger,
          scopes,
          chargedStroops: estimate,
          at: Date.now(),
        });
      }
    }
    if (result.success) {
      if (dupKey) this.dedupe.settled(dupKey, tx);
      this.metrics.addSettledAmount(network, feeCtx.asset, feeCtx.amount);
      this.feePolicy.onSettled({ ...feeCtx, payer: result.payer ?? feeCtx.payer }, this.feePolicy.quote(feeCtx), tx);
    } else if (dupKey) {
      this.dedupe.end(dupKey);
    }
  }

  private async boundedStellarHealth(rt: StellarRuntime): Promise<{ degraded: boolean; body: Record<string, unknown> }> {
    const report = await withDeadline(this.probeStellarHealth(rt), this.stellarProbeMs);
    if (report !== TIMED_OUT) return report;
    rt.rpcOk = false;
    rt.lastError = "the Stellar RPC did not answer the health probe in time";
    return {
      degraded: true,
      body: { network: rt.config.id, name: rt.config.name, explorer: rt.config.explorerUrl, schemes: [...rt.schemes], feePayers: rt.chain.addresses, rpcOk: false, error: rt.lastError },
    };
  }

  private async probeStellarHealth(rt: StellarRuntime): Promise<{ degraded: boolean; body: Record<string, unknown> }> {
    const { chain, config } = rt;
    const budget = this.config.stellar?.feeBudget;
    const base = {
      network: config.id,
      name: config.name,
      explorer: config.explorerUrl,
      nativeSymbol: config.nativeSymbol,
      schemes: [...rt.schemes],
      facilitator: chain.addresses[0],
      feePayers: chain.addresses,
      maxFeeStroops: config.maxFeeStroops,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      settlementSlots: { total: chain.addresses.length, busy: chain.pool.busyCount, waiting: chain.pool.waitingCount },
      feeBudget: {
        globalDailyStroops: budget?.globalDailyStroops?.toString() ?? "unlimited",
        globalSpentTodayStroops: this.stellarFeeBudget.spentToday(`${config.id}|global`).toString(),
        perPayToDailyStroops: budget?.perPayToDailyStroops?.toString() ?? "unlimited",
        resetsInSeconds: this.stellarFeeBudget.secondsUntilReset(),
      },
    };
    try {
      if (rt.misconfigured) throw new Error(rt.misconfigured);
      const [latestLedger, balances] = await Promise.all([
        chain.latestLedger(),
        Promise.all(chain.addresses.map(async (address) => ({ address, stroops: await this.cachedStellarBalance(rt, address, true) }))),
      ]);
      const maxFee = BigInt(config.maxFeeStroops);
      const total = balances.reduce((sum, b) => sum + b.stroops, 0n);
      const runway = Number(total / maxFee);
      // A fee payer that cannot pay one settlement is reported on its own: the total runway hides it.
      const unfunded = balances.filter((b) => b.stroops < maxFee).map((b) => b.address);
      const low = runway < this.config.lowRunwaySettles || unfunded.length > 0;
      rt.rpcOk = true;
      return {
        degraded: low,
        body: {
          ...base,
          rpcOk: true,
          latestLedger,
          feeBalances: balances.map((b) => ({
            address: b.address,
            spendableStroops: b.stroops.toString(),
            spendable: `${formatUnits(b.stroops, config.nativeDecimals)} ${config.nativeSymbol}`,
          })),
          settleRunway: runway,
          lowBalance: low,
          ...(unfunded.length > 0 ? { unfundedFeePayers: unfunded } : {}),
        },
      };
    } catch (error) {
      rt.rpcOk = false;
      rt.lastError = publicErrorMessage(error);
      this.log.warn({ network: config.id, err: loggableErrorMessage(error) }, "health probe failed");
      return { degraded: true, body: { ...base, rpcOk: false, error: rt.lastError } };
    }
  }

  // ---------------------------------------------------------------- health & metrics

  /**
   * Status report. The RPC probe behind it is shared by concurrent callers and cached for
   * HEALTH_CACHE_SECONDS, so an unauthenticated monitor (or anyone) polling /health cannot turn
   * it into an RPC amplifier.
   */
  async health(): Promise<HealthReport> {
    const ttlMs = this.config.healthCacheSeconds * 1000;
    const now = Date.now();
    if (this.healthCache && ttlMs > 0 && now - this.healthCache.at < ttlMs) return withUptime(this.healthCache.report, this.metrics.startedAt);
    if (!this.healthInFlight) {
      this.healthInFlight = this.probeHealth()
        .then((report) => {
          this.healthCache = { at: Date.now(), report };
          return report;
        })
        .finally(() => {
          this.healthInFlight = undefined;
        });
    }
    return withUptime(await this.healthInFlight, this.metrics.startedAt);
  }

  private async probeHealth(): Promise<HealthReport> {
    let degraded = false;
    // Stellar networks are probed alongside the EVM ones, each within STELLAR_PROBE_BUDGET_MS: a
    // stalled Stellar RPC reports rpcOk: false instead of holding /health.
    const stellarReports = Promise.all([...this.stellarNetworks.values()].map((rt) => this.boundedStellarHealth(rt)));
    const networks = await Promise.all(
      [...this.networks.values()].map(async (rt) => {
        const base = {
          network: rt.config.id,
          name: rt.config.name,
          chainId: rt.config.chainId,
          explorer: rt.config.explorerUrl,
          nativeSymbol: rt.config.nativeSymbol,
          schemes: [...rt.schemes],
          permit2: rt.permit2,
          facilitator: rt.signer.address,
          gasBudget: {
            globalDaily: this.config.gasBudget.globalDailyWei?.toString() ?? "unlimited",
            globalSpentToday: this.gasBudget.spentToday("global").toString(),
            perPayToDaily: this.config.gasBudget.perPayToDailyWei?.toString() ?? "unlimited",
            resetsInSeconds: this.gasBudget.secondsUntilReset(),
          },
        };
        try {
          const [balance, blockNumber, maxFeePerGas] = await Promise.all([
            this.cachedBalance(rt, true),
            rt.signer.publicClient.getBlockNumber(),
            rt.signer.maxFeePerGas(),
          ]);
          const settleCost = maxFeePerGas * this.config.settleGasEstimate;
          const runway = settleCost > 0n ? Number(balance / settleCost) : Number.POSITIVE_INFINITY;
          const low = runway < this.config.lowRunwaySettles;
          if (low) degraded = true;
          rt.rpcOk = true;
          return {
            ...base,
            rpcOk: true,
            blockNumber: blockNumber.toString(),
            gasBalanceWei: balance.toString(),
            gasBalance: `${formatUnits(balance, rt.config.nativeDecimals)} ${rt.config.nativeSymbol}`,
            maxFeePerGasWei: maxFeePerGas.toString(),
            estimatedSettleCostWei: settleCost.toString(),
            settleRunway: Number.isFinite(runway) ? runway : null,
            lowBalance: low,
          };
        } catch (error) {
          degraded = true;
          rt.rpcOk = false;
          rt.lastError = publicErrorMessage(error);
          this.log.warn({ network: rt.config.id, err: loggableErrorMessage(error) }, "health probe failed");
          return { ...base, rpcOk: false, error: rt.lastError };
        }
      }),
    );
    for (const report of await stellarReports) {
      if (report.degraded) degraded = true;
      networks.push(report.body as (typeof networks)[number]);
    }
    return {
      status: degraded ? "degraded" : "ok",
      body: {
        status: degraded ? "degraded" : "ok",
        service: "whitechain-x402-facilitator",
        x402Version: X402_VERSION,
        uptimeSeconds: Math.floor((Date.now() - this.metrics.startedAt.getTime()) / 1000),
        facilitator: this.address,
        denylistSize: this.denylist.size(),
        networks,
      },
    };
  }

  metricsSnapshot(): Record<string, unknown> {
    return {
      ...this.metrics.snapshot(),
      budget: {
        day: this.gasBudget.currentDay(),
        globalSpentTodayWei: this.gasBudget.spentToday("global").toString(),
        globalDailyLimitWei: this.config.gasBudget.globalDailyWei?.toString() ?? "unlimited",
        perPayToDailyLimitWei: this.config.gasBudget.perPayToDailyWei?.toString() ?? "unlimited",
        totalSpentWei: this.gasBudget.totalSpent.toString(),
        resetsInSeconds: this.gasBudget.secondsUntilReset(),
      },
      fees: this.feePolicy.snapshot(),
      dedupe: { tracked: this.dedupe.size() },
      rateLimiters: {
        callers: this.limiters.ip.size(),
        payers: this.limiters.payer.size(),
        payTos: this.limiters.payTo.size(),
        globalPerWindow: this.config.rateLimit.globalPerWindow || "unlimited",
      },
      ...(this.stellarNetworks.size > 0 ? { stellar: this.stellarMetrics() } : {}),
    };
  }

  private stellarMetrics(): Record<string, unknown> {
    const budget = this.config.stellar?.feeBudget;
    const networks: Record<string, unknown> = {};
    for (const [id, rt] of this.stellarNetworks) {
      networks[id] = {
        globalSpentTodayStroops: this.stellarFeeBudget.spentToday(`${id}|global`).toString(),
        settlementSlots: { total: rt.chain.addresses.length, busy: rt.chain.pool.busyCount, waiting: rt.chain.pool.waitingCount },
      };
    }
    return {
      feesSpentStroops: this.metrics.networkFeesSnapshot(),
      txCount: this.metrics.get("stellar.tx"),
      pendingBroadcasts: this.stellarPending.size,
      budget: {
        day: this.stellarFeeBudget.currentDay(),
        globalDailyLimitStroops: budget?.globalDailyStroops?.toString() ?? "unlimited",
        perPayToDailyLimitStroops: budget?.perPayToDailyStroops?.toString() ?? "unlimited",
        totalSpentStroops: this.stellarFeeBudget.totalSpent.toString(),
        resetsInSeconds: this.stellarFeeBudget.secondsUntilReset(),
      },
      globalPerWindow: this.config.stellar?.globalPerWindow || "unlimited",
      networks,
    };
  }
}

function withUptime(report: HealthReport, startedAt: Date): HealthReport {
  return { status: report.status, body: { ...report.body, uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000) } };
}

/**
 * The SDK copies raw viem error text into `invalidMessage` / `errorMessage` (e.g. a failed
 * simulation's message, which names the RPC URL). Only the sanitized form leaves the process.
 */
function sanitizeMessages<T extends VerifyResponse | SettleResponse>(result: T): T {
  if ("invalidMessage" in result && typeof result.invalidMessage === "string") {
    return { ...result, invalidMessage: publicErrorMessage(result.invalidMessage) };
  }
  if ("errorMessage" in result && typeof result.errorMessage === "string") {
    return { ...result, errorMessage: publicErrorMessage(result.errorMessage) };
  }
  return result;
}

/**
 * The signer wrapper rejects over-cap settlements by throwing inside the SDK's simulation; the SDK
 * reports that as a generic simulation failure. Surface our reason code (and message) instead.
 */
function normalizeGasCapReason<T extends VerifyResponse | SettleResponse>(result: T, sctx: SettlementContext): T {
  const failed = "isValid" in result ? !result.isValid : !(result as SettleResponse).success;
  if (!failed || !sctx.gasCap) return result;
  if ("isValid" in result) {
    return { ...result, invalidReason: Reasons.settleGasCapExceeded, invalidMessage: sctx.gasCap.message };
  }
  return { ...result, errorReason: Reasons.settleGasCapExceeded, errorMessage: sctx.gasCap.message };
}

export type { PaymentPayload, PaymentRequirements };
