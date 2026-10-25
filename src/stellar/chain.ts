// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { Keypair, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { DEFAULT_TESTNET_HORIZON_URL, createEd25519Signer, type FacilitatorStellarSigner } from "@x402/stellar";
import type { StellarNetworkConfig } from "../config.js";
import { SignerPool, stellarSignerContext } from "./pool.js";

/** Base reserve on Stellar (testnet and mainnet): 0.5 XLM per base unit. */
const BASE_RESERVE_STROOPS = 5_000_000n;
const POLL_INTERVAL_MS = 1_000;
/** Timeout of every Soroban RPC and Horizon request made for Stellar (the SDK sets none of its own). */
export const STELLAR_RPC_TIMEOUT_MS = 20_000;

const boundedOrigins = new Map<string, number>();
const BOUNDED = Symbol.for("whitechain-x402-facilitator.stellar.boundedFetch");

/**
 * Bounds every request to these endpoints (by origin) to `ms`. @stellar/stellar-sdk sets no
 * timeout by default (a stalled RPC holds a call for undici's ~300 s), its `timeout` constructor
 * option is ignored by rpc.Server, and @x402/stellar builds a fresh rpc.Server and Horizon client
 * inside every verify and settle. All of them use the global fetch, so the wrapper adds a deadline
 * to requests for these origins and passes every other request through untouched.
 */
export function boundStellarFetch(urls: readonly string[], ms: number): void {
  for (const u of urls) {
    try {
      boundedOrigins.set(new URL(u).origin, ms);
    } catch {
      // not a URL: nothing to bound
    }
  }
  const current = globalThis.fetch as typeof fetch & { [BOUNDED]?: true };
  if (current[BOUNDED]) return;
  const inner = current;
  const bounded = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let limit: number | undefined;
    try {
      limit = boundedOrigins.get(new URL(url).origin);
    } catch {
      limit = undefined;
    }
    if (!limit) return inner(input, init);
    const timeout = AbortSignal.timeout(limit);
    const base = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = base ? AbortSignal.any([base, timeout]) : timeout;
    // Raced as well, so even a fetch that ignores its signal ends at the deadline.
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error("Stellar request timed out"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      inner(input, { ...init, signal })
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
  }) as typeof fetch & { [BOUNDED]?: true };
  bounded[BOUNDED] = true;
  globalThis.fetch = bounded;
}

/**
 * A fee-payer signer that records, in the settlement's signer context, the hash of the
 * transaction it signs. The hash of a Stellar transaction does not depend on its signatures, so it
 * is the one the network reports: when @x402/stellar's submission call fails after the RPC may
 * have taken the transaction, the facilitator still knows what to look for.
 */
function recordingSigner(base: FacilitatorStellarSigner, networkPassphrase: string): FacilitatorStellarSigner {
  return {
    ...base,
    async signTransaction(txXdr, opts) {
      const store = stellarSignerContext.getStore();
      if (store) store.signedHash = TransactionBuilder.fromXDR(txXdr, opts?.networkPassphrase ?? networkPassphrase).hash().toString("hex");
      return base.signTransaction(txXdr, opts);
    },
  };
}

export type StellarTxStatus =
  | { status: "SUCCESS" | "FAILED"; feeChargedStroops: bigint; ledger: number; latestLedger: number }
  | { status: "NOT_FOUND"; latestLedger: number };

/**
 * One Stellar network: the Soroban RPC client, the fee-payer signers handed to @x402/stellar,
 * and the reads the policy layer needs (network identity, fee-payer balances, settled fees).
 * Every read goes to the configured RPC, the same endpoint the SDK verifies and settles on.
 */
export class StellarChain {
  readonly network: StellarNetworkConfig;
  readonly server: rpc.Server;
  readonly signers: FacilitatorStellarSigner[];
  readonly addresses: string[];
  readonly pool: SignerPool;

  constructor(network: StellarNetworkConfig, secretKeys: string[], opts: { rpcTimeoutMs?: number } = {}) {
    this.network = network;
    const timeoutMs = opts.rpcTimeoutMs ?? STELLAR_RPC_TIMEOUT_MS;
    this.server = new rpc.Server(network.rpcUrl, { allowHttp: network.rpcUrl.startsWith("http://") });
    // rpc.Server ignores a `timeout` constructor option; its HTTP client's defaults are what count.
    this.server.httpClient.defaults.timeout = timeoutMs;
    // The SDK's own clients (built per call, without timeouts): the same RPC, and Horizon's public testnet.
    boundStellarFetch([network.rpcUrl, DEFAULT_TESTNET_HORIZON_URL], timeoutMs);
    this.signers = secretKeys.map((key) => recordingSigner(createEd25519Signer(key, network.id), network.networkPassphrase));
    this.addresses = this.signers.map((s) => s.address);
    this.pool = new SignerPool(this.addresses);
  }

  /** The network passphrase the RPC serves (must equal the configured network's). */
  async passphrase(): Promise<string> {
    return (await this.server.getNetwork()).passphrase;
  }

  /** Latest ledger from getHealth (getLatestLedger also ships the whole ledger header and close meta). */
  async latestLedger(): Promise<number> {
    return (await this.server.getHealth()).latestLedger;
  }

  /**
   * XLM the account can spend on fees: balance minus the minimum balance it must keep
   * ((2 + subentries) × base reserve). 0 for an account that does not exist yet (not funded).
   */
  async spendableStroops(address: string): Promise<bigint> {
    // getLedgerEntries directly: the SDK's getAccountEntry reports every failure, an unreachable
    // RPC included, as "Account not found", and an RPC outage must not read as an empty wallet.
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }));
    const { entries } = await this.server.getLedgerEntries(key);
    const found = entries[0];
    if (!found) return 0n;
    const entry = found.val.account();
    const balance = BigInt(entry.balance().toString());
    const minimum = (2n + BigInt(entry.numSubEntries())) * BASE_RESERVE_STROOPS;
    return balance > minimum ? balance - minimum : 0n;
  }

  async transactionStatus(hash: string): Promise<StellarTxStatus> {
    const tx = await this.server.getTransaction(hash);
    if (tx.status === rpc.Api.GetTransactionStatus.SUCCESS || tx.status === rpc.Api.GetTransactionStatus.FAILED) {
      return {
        status: tx.status === rpc.Api.GetTransactionStatus.SUCCESS ? "SUCCESS" : "FAILED",
        feeChargedStroops: BigInt(tx.resultXdr.feeCharged().toString()),
        ledger: tx.ledger,
        latestLedger: tx.latestLedger,
      };
    }
    return { status: "NOT_FOUND", latestLedger: tx.latestLedger };
  }

  /**
   * Waits until a broadcast transaction is final: SUCCESS / FAILED, or NOT_FOUND once the ledger
   * has passed `lastValidLedger` (the payer's authorization expired, so it can never land).
   * Returns undefined when that could not be decided within `timeoutMs` (RPC down or slow).
   */
  async awaitFinal(hash: string, lastValidLedger: number | undefined, timeoutMs: number): Promise<StellarTxStatus | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const status = await this.transactionStatus(hash);
        if (status.status !== "NOT_FOUND") return status;
        if (lastValidLedger !== undefined && status.latestLedger > lastValidLedger) return status;
      } catch {
        // transient RPC error: keep polling until the deadline
      }
      if (Date.now() + POLL_INTERVAL_MS > deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}
