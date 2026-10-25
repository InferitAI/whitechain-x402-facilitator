// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Settlement bookkeeping around @x402/stellar's settle(): what the facilitator does with a
 * broadcast whose outcome the SDK could not confirm. The SDK call and the chain reads are
 * stubbed (white-box) so each outcome can be forced; everything else (admission, replay
 * registry, fee budget, fee-payer lease) is the real service against the offline RPC stand-in.
 */
import { Keypair } from "@stellar/stellar-sdk";
import type { SettleResponse } from "@x402/core/types";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { StellarTxStatus } from "../../src/stellar/chain.js";
import { parseFacilitatorRequest } from "../../src/schema.js";
import { startFacilitator, type RunningFacilitator } from "../helpers/facilitator.js";
import { buildStellarPayment, startMockSorobanRpc, stellarRequirements, type MockSorobanRpc } from "../helpers/stellar.js";

const feePayer = Keypair.random();
const payer = Keypair.random();
const merchant = Keypair.random();
const TX = "ab".repeat(32);
const ctx = { ip: "127.0.0.1", apiKey: undefined };

let rpc: MockSorobanRpc;
let facilitator: RunningFacilitator;
let sdkSettles = 0;
let sdkResult: SettleResponse;
let chainStatuses: (StellarTxStatus | undefined)[] = [];

interface Internals {
  facilitator: { settle: (...args: unknown[]) => Promise<SettleResponse> };
  stellarNetworks: Map<string, { chain: { awaitFinal: (...args: unknown[]) => Promise<StellarTxStatus | undefined> } }>;
}

beforeAll(async () => {
  rpc = await startMockSorobanRpc();
  facilitator = await startFacilitator({ url: "http://127.0.0.1:9", chainId: 31337 }, generatePrivateKey(), {
    STELLAR_FACILITATOR_KEY: feePayer.secret(),
    STELLAR_NETWORKS: JSON.stringify([{ id: "stellar:testnet", rpc: rpc.url }]),
  });
  const internals = facilitator.service as unknown as Internals;
  internals.facilitator.settle = async () => {
    sdkSettles += 1;
    return sdkResult;
  };
  internals.stellarNetworks.get("stellar:testnet")!.chain.awaitFinal = async () => chainStatuses.shift();
});

afterAll(async () => {
  await facilitator?.stop();
  await rpc?.stop();
});

afterEach(() => {
  sdkSettles = 0;
  chainStatuses = [];
});

async function request() {
  const requirements = stellarRequirements({ payTo: merchant.publicKey() });
  const payment = await buildStellarPayment(payer, requirements, { expirationLedger: 1_010 });
  const parsed = parseFacilitatorRequest({ x402Version: 2, paymentPayload: payment, paymentRequirements: requirements });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

const spent = () => facilitator.service.stellarFeeBudget.spentToday("stellar:testnet|global");
const failedWithTx: SettleResponse = { success: false, transaction: TX, network: "stellar:testnet", errorReason: "settle_exact_stellar_transaction_failed" };

describe("Stellar settlement accounting", () => {
  it("a confirmed settlement charges the real fee and blocks a replay", async () => {
    const req = await request();
    const before = spent();
    sdkResult = { success: true, transaction: TX, network: "stellar:testnet", payer: payer.publicKey() };
    chainStatuses = [{ status: "SUCCESS", feeChargedStroops: 10_293n, ledger: 1_001, latestLedger: 1_001 }];
    const first = await facilitator.service.settle(req, ctx);
    expect(first.body).toMatchObject({ success: true, transaction: TX });
    expect(spent() - before).toBe(10_293n);
    const replay = await facilitator.service.settle(req, ctx);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ success: false, errorReason: "duplicate_settlement" });
    expect(sdkSettles).toBe(1);
  });

  it("a broadcast the SDK gave up on but that landed is reported as the success it is", async () => {
    const req = await request();
    sdkResult = failedWithTx;
    chainStatuses = [{ status: "SUCCESS", feeChargedStroops: 9_000n, ledger: 1_002, latestLedger: 1_003 }];
    const out = await facilitator.service.settle(req, ctx);
    expect(out.body).toMatchObject({ success: true, transaction: TX, payer: payer.publicKey() });
  });

  it("an undecided broadcast answers settlement_pending, then the retry reconciles it without a second broadcast", async () => {
    const req = await request();
    const before = spent();
    sdkResult = failedWithTx;
    chainStatuses = [undefined];
    const pending = await facilitator.service.settle(req, ctx);
    expect(pending.body).toMatchObject({ success: false, transaction: TX, errorReason: "settlement_pending" });
    expect(pending.retryAfterSeconds).toBe(5);
    expect(spent() - before).toBe(50_000n); // worst case charged until the outcome is known

    chainStatuses = [undefined];
    const stillPending = await facilitator.service.settle(req, ctx);
    expect(stillPending.body).toMatchObject({ success: false, errorReason: "settlement_pending", transaction: TX });

    chainStatuses = [{ status: "SUCCESS", feeChargedStroops: 11_000n, ledger: 1_004, latestLedger: 1_005 }];
    const reconciled = await facilitator.service.settle(req, ctx);
    expect(reconciled.body).toMatchObject({ success: true, transaction: TX });
    expect(spent() - before).toBe(11_000n); // corrected to the real fee
    expect(sdkSettles).toBe(1);
    expect((await facilitator.service.settle(req, ctx)).status).toBe(409);
  });

  it("a pending broadcast that expired unseen costs nothing and lets the payment be settled afresh", async () => {
    const req = await request();
    const before = spent();
    sdkResult = failedWithTx;
    chainStatuses = [undefined];
    await facilitator.service.settle(req, ctx);
    // Expired: the ledger passed the authorization's expiration (1_010) without the tx landing.
    chainStatuses = [{ status: "NOT_FOUND", latestLedger: 1_011 }, { status: "SUCCESS", feeChargedStroops: 8_000n, ledger: 1_012, latestLedger: 1_012 }];
    sdkResult = { success: true, transaction: "cd".repeat(32), network: "stellar:testnet", payer: payer.publicKey() };
    const fresh = await facilitator.service.settle(req, ctx);
    expect(fresh.body).toMatchObject({ success: true, transaction: "cd".repeat(32) });
    expect(sdkSettles).toBe(2);
    expect(spent() - before).toBe(8_000n);
  });

  it("a broadcast that failed on-chain charges its fee and leaves the authorization usable", async () => {
    const req = await request();
    const before = spent();
    sdkResult = failedWithTx;
    chainStatuses = [{ status: "FAILED", feeChargedStroops: 7_000n, ledger: 1_006, latestLedger: 1_006 }];
    const failed = await facilitator.service.settle(req, ctx);
    expect(failed.body).toMatchObject({ success: false, transaction: TX, errorReason: "settle_exact_stellar_transaction_failed" });
    expect(spent() - before).toBe(7_000n);
    sdkResult = { success: false, transaction: "", network: "stellar:testnet", errorReason: "invalid_exact_stellar_payload_simulation_failed" };
    const again = await facilitator.service.settle(req, ctx);
    expect(again.status).toBe(200); // not a 409: nothing was settled
    expect(spent() - before).toBe(7_000n); // no broadcast, nothing charged
  });
});
