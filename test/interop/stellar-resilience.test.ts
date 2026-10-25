// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stellar under a misbehaving RPC or a misconfigured pool, offline: a Soroban RPC stand-in that
 * accepts requests and never answers, an unfunded key in a two-key pool, and a submission whose
 * answer is lost after the fee payer signed. Whitechain (a dead RPC here) must never wait on Stellar.
 */
import { Account, Keypair, Networks, Operation, TransactionBuilder, rpc as sorobanRpc } from "@stellar/stellar-sdk";
import type { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import type { SettleResponse } from "@x402/core/types";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boundPolling } from "../../src/facilitator.js";
import { parseFacilitatorRequest } from "../../src/schema.js";
import { boundStellarFetch, type StellarTxStatus } from "../../src/stellar/chain.js";
import { stellarSignerContext } from "../../src/stellar/pool.js";
import { startFacilitator, type RunningFacilitator } from "../helpers/facilitator.js";
import { buildStellarPayment, startMockSorobanRpc, stellarRequirements, type MockSorobanRpc } from "../helpers/stellar.js";

const DEAD_EVM = { url: "http://127.0.0.1:9", chainId: 31337 };
const ctx = { ip: "127.0.0.1", apiKey: undefined };

interface Internals {
  facilitator: { settle: (...args: unknown[]) => Promise<SettleResponse> };
  stellarNetworks: Map<
    string,
    {
      balanceCache: Map<string, unknown>;
      chain: { awaitFinal: (...args: unknown[]) => Promise<StellarTxStatus | undefined>; signers: { signTransaction(xdr: string, opts?: { networkPassphrase?: string }): Promise<unknown> }[] };
    }
  >;
}

async function startStellar(rpc: MockSorobanRpc, keys: Keypair[], timeouts = { rpcMs: 500, probeMs: 300 }) {
  return startFacilitator(
    DEAD_EVM,
    generatePrivateKey(),
    {
      STELLAR_FACILITATOR_KEY: keys.map((k) => k.secret()).join(","),
      STELLAR_NETWORKS: JSON.stringify([{ id: "stellar:testnet", rpc: rpc.url }]),
      HEALTH_CACHE_SECONDS: "0",
    },
    { stellarTimeouts: timeouts },
  );
}

async function settleRequest(payer: Keypair, payTo: string) {
  const requirements = stellarRequirements({ payTo });
  const payment = await buildStellarPayment(payer, requirements, { expirationLedger: 1_010 });
  const parsed = parseFacilitatorRequest({ x402Version: 2, paymentPayload: payment, paymentRequirements: requirements });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

describe("a stalled Stellar RPC", () => {
  let rpc: MockSorobanRpc;
  beforeAll(async () => {
    rpc = await startMockSorobanRpc();
  });
  afterAll(async () => {
    await rpc?.stop();
  });

  it("never holds the start (so the listen), and /health answers within its budget with rpcOk false", async () => {
    for (const m of ["getNetwork", "getHealth", "getLedgerEntries"]) rpc.stall.add(m);
    const t0 = Date.now();
    const f = await startStellar(rpc, [Keypair.random()]);
    try {
      // Before: start() awaited getNetwork and getHealth with no timeout, so the process never listened.
      expect(Date.now() - t0).toBeLessThan(3_000);
      const t1 = Date.now();
      const res = await fetch(`${f.url}/health`);
      expect(Date.now() - t1).toBeLessThan(3_000);
      const health = (await res.json()) as { status: string; networks: Record<string, unknown>[] };
      expect(health.status).toBe("degraded");
      expect(health.networks.find((n) => n["network"] === "stellar:testnet")).toMatchObject({ rpcOk: false });
      expect(health.networks.find((n) => n["network"] === "eip155:31337")).toBeDefined();
    } finally {
      rpc.stall.clear();
      await f.stop();
    }
  });

  it("times out every request to a bounded origin, including the clients @x402/stellar builds itself", async () => {
    rpc.stall.add("getHealth");
    try {
      boundStellarFetch([rpc.url], 400);
      // A client built like @x402/stellar's getRpcClient (no timeout of its own).
      const sdkClient = new sorobanRpc.Server(rpc.url, { allowHttp: true });
      const t0 = Date.now();
      await expect(sdkClient.getHealth()).rejects.toBeDefined();
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      rpc.stall.clear();
    }
    // An endpoint that answers is unaffected, and so is any other origin.
    const ok = await fetch(`${rpc.url}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) });
    expect(ok.status).toBe(200);
    const other = await startMockSorobanRpc();
    try {
      other.stall.add("getHealth");
      const slow = fetch(other.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) });
      const raced = await Promise.race([slow.then(() => "answered", () => "aborted"), new Promise((r) => setTimeout(() => r("still waiting"), 800))]);
      expect(raced).toBe("still waiting");
    } finally {
      await other.stop();
    }
  });

  it("caps the SDK's confirmation polling at its own budget plus one call, however slow each call is", async () => {
    // The SDK's own loop, here never answering (each call stalls).
    const scheme = { pollForTransaction: (..._a: unknown[]): Promise<{ success: boolean }> => new Promise(() => undefined) };
    boundPolling(scheme as unknown as ExactStellarScheme, 200);
    const t0 = Date.now();
    await expect(scheme.pollForTransaction({}, "ab".repeat(32), 1, 100)).resolves.toEqual({ success: false });
    expect(Date.now() - t0).toBeLessThan(1_500);
  });
});

describe("a fee-payer pool with an unfunded account", () => {
  const funded = Keypair.random();
  const unfunded = Keypair.random();
  const payer = Keypair.random();
  const merchant = Keypair.random();
  let rpc: MockSorobanRpc;
  let f: RunningFacilitator;
  const leasedBy: string[] = [];

  beforeAll(async () => {
    rpc = await startMockSorobanRpc();
    rpc.balances.set(unfunded.publicKey(), undefined); // never funded
    f = await startStellar(rpc, [funded, unfunded]);
    const internals = f.service as unknown as Internals;
    internals.facilitator.settle = async () => {
      leasedBy.push(stellarSignerContext.getStore()!.address);
      return { success: true, transaction: "ab".repeat(32), network: "stellar:testnet", payer: payer.publicKey() };
    };
    internals.stellarNetworks.get("stellar:testnet")!.chain.awaitFinal = async () => ({ status: "SUCCESS", feeChargedStroops: 1_000n, ledger: 1_001, latestLedger: 1_001 });
  });
  afterAll(async () => {
    await f?.stop();
    await rpc?.stop();
  });

  it("settles every payment on the funded account (before: every other settle was facilitator_out_of_gas)", async () => {
    for (let i = 0; i < 4; i++) {
      const out = await f.service.settle(await settleRequest(payer, merchant.publicKey()), ctx);
      expect(out.body, JSON.stringify(out.body)).toMatchObject({ success: true });
    }
    expect(leasedBy).toEqual(Array(4).fill(funded.publicKey()));
    expect(f.service.stellarSigners()["stellar:testnet"]).toHaveLength(2);
  });

  it("reports the unfunded account on /health instead of hiding it in the total runway", async () => {
    const health = (await (await fetch(`${f.url}/health`)).json()) as { status: string; networks: Record<string, unknown>[] };
    expect(health.status).toBe("degraded");
    expect(health.networks.find((n) => n["network"] === "stellar:testnet")).toMatchObject({ lowBalance: true, unfundedFeePayers: [unfunded.publicKey()] });
  });

  it("answers out_of_gas only when no idle account can pay", async () => {
    rpc.balances.set(funded.publicKey(), 0n);
    (f.service as unknown as Internals).stellarNetworks.get("stellar:testnet")!.balanceCache.clear();
    try {
      const out = await f.service.settle(await settleRequest(payer, merchant.publicKey()), ctx);
      expect(out.status).toBe(503);
      expect(out.body).toMatchObject({ success: false, errorReason: "facilitator_out_of_gas" });
      // Both leases went back to the pool.
      const health = (await (await fetch(`${f.url}/health`)).json()) as { networks: Record<string, unknown>[] };
      expect(health.networks.find((n) => n["network"] === "stellar:testnet")).toMatchObject({ settlementSlots: { total: 2, busy: 0, waiting: 0 } });
    } finally {
      rpc.balances.delete(funded.publicKey());
    }
  });
});

describe("a submission whose answer is lost after the fee payer signed", () => {
  const feePayer = Keypair.random();
  const payer = Keypair.random();
  const merchant = Keypair.random();
  let rpc: MockSorobanRpc;
  let f: RunningFacilitator;
  let signedHash = "";
  let statuses: (StellarTxStatus | undefined)[] = [];
  let sdkSettles = 0;

  beforeAll(async () => {
    rpc = await startMockSorobanRpc();
    f = await startStellar(rpc, [feePayer]);
    const internals = f.service as unknown as Internals;
    const chain = internals.stellarNetworks.get("stellar:testnet")!.chain;
    // Like the SDK: sign the rebuilt transaction with the leased signer, then sendTransaction throws (a 502 after the
    // RPC forwarded it), so the SDK answers unexpected_settle_error with no hash.
    internals.facilitator.settle = async () => {
      sdkSettles += 1;
      const tx = new TransactionBuilder(new Account(feePayer.publicKey(), String(sdkSettles)), { fee: "100", networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
        .setTimeout(60)
        .build();
      signedHash = tx.hash().toString("hex");
      await chain.signers[0]!.signTransaction(tx.toXDR(), { networkPassphrase: Networks.TESTNET });
      return { success: false, transaction: "", network: "stellar:testnet", errorReason: "unexpected_settle_error", payer: payer.publicKey() };
    };
    chain.awaitFinal = async () => statuses.shift();
  });
  afterAll(async () => {
    await f?.stop();
    await rpc?.stop();
  });

  it("checks the hash it signed: a transfer that landed is the success it is", async () => {
    statuses = [{ status: "SUCCESS", feeChargedStroops: 9_000n, ledger: 1_002, latestLedger: 1_003 }];
    const out = await f.service.settle(await settleRequest(payer, merchant.publicKey()), ctx);
    // Before: "nothing was broadcast": the reservation and the replay lock were released and the merchant was told it failed.
    expect(out.body).toMatchObject({ success: true, transaction: signedHash });
  });

  it("an undecided one is settlement_pending under that hash, and the retry reconciles it without signing again", async () => {
    const req = await settleRequest(payer, merchant.publicKey());
    statuses = [undefined];
    const pending = await f.service.settle(req, ctx);
    expect(pending.body).toMatchObject({ success: false, errorReason: "settlement_pending", transaction: signedHash });
    const first = signedHash;
    const before = sdkSettles;
    statuses = [{ status: "SUCCESS", feeChargedStroops: 9_000n, ledger: 1_004, latestLedger: 1_005 }];
    const again = await f.service.settle(req, ctx);
    expect(again.body).toMatchObject({ success: true, transaction: first });
    expect(sdkSettles).toBe(before);
  });
});
