// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stellar policy suite, fully offline: the real facilitator HTTP server with @x402/stellar's
 * ExactStellarScheme registered, pointed at a call-counting Soroban RPC stand-in. Every guard
 * the EVM path has (denylist, rate limits per network, daily fee budgets, API-key scope, asset
 * allowlist, replay protection, fee-payer balance, RPC failure handling) is exercised, and each
 * refusal is checked to have happened before any simulation or submission.
 */
import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { StaticDenylist } from "../../src/policy/denylist.js";
import { startFacilitator, type RunningFacilitator } from "../helpers/facilitator.js";
import { postJson } from "../helpers/payments.js";
import { buildStellarPayment, startMockSorobanRpc, stellarRequirements, XLM_SAC_TESTNET, type MockSorobanRpc } from "../helpers/stellar.js";

/** No EVM node in this suite: Whitechain is configured against a closed port and is never used. */
const DEAD_EVM = { url: "http://127.0.0.1:9", chainId: 31337 };
const OTHER_SAC = StrKey.encodeContract(Buffer.alloc(32, 9));

const feePayer = Keypair.random();
const payer = Keypair.random();
const merchant = Keypair.random();
const sanctionedPayer = Keypair.random();
const sanctionedOwner = Keypair.random();
const sanctionedMuxed = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(sanctionedOwner.publicKey()), Buffer.alloc(8, 1)]));

type VerifyBody = { isValid: boolean; invalidReason?: string; invalidMessage?: string; payer?: string };
type SettleBody = { success: boolean; errorReason?: string; errorMessage?: string; transaction: string; network: string };

const wire = (paymentPayload: unknown, paymentRequirements: unknown) => ({ x402Version: 2, paymentPayload, paymentRequirements });

async function startStellarFacilitator(rpc: MockSorobanRpc | { url: string }, env: Record<string, string> = {}, networkExtra: Record<string, unknown> = {}) {
  return startFacilitator(
    DEAD_EVM,
    generatePrivateKey(),
    {
      STELLAR_FACILITATOR_KEY: feePayer.secret(),
      STELLAR_NETWORKS: JSON.stringify([{ id: "stellar:testnet", rpc: rpc.url, ...networkExtra }]),
      HEALTH_CACHE_SECONDS: "0",
      ...env,
    },
    { denylist: new StaticDenylist([sanctionedPayer.publicKey(), sanctionedOwner.publicKey()]) },
  );
}

let rpc: MockSorobanRpc;
let facilitator: RunningFacilitator;

beforeAll(async () => {
  rpc = await startMockSorobanRpc();
  facilitator = await startStellarFacilitator(rpc, {}, { assets: [XLM_SAC_TESTNET] });
});

afterAll(async () => {
  await facilitator?.stop();
  await rpc?.stop();
});

const reqs = (overrides: Record<string, unknown> = {}) => stellarRequirements({ payTo: merchant.publicKey(), ...overrides });
const noSubmission = () => {
  expect(rpc.count("sendTransaction")).toBe(0);
};

describe("discovery", () => {
  it("GET /supported lists stellar:testnet next to the EVM network, with the fee payer as signer", async () => {
    const res = await fetch(`${facilitator.url}/supported`);
    const body = (await res.json()) as { kinds: { network: string; scheme: string; extra?: Record<string, unknown> }[]; signers: Record<string, string[]> };
    expect(body.kinds).toContainEqual({ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } });
    expect(body.kinds.some((k) => k.network === "eip155:31337" && k.scheme === "exact")).toBe(true);
    expect(body.signers["stellar:*"]).toEqual([feePayer.publicKey()]);
    expect(body.signers["eip155:*"]).toEqual([facilitator.service.address]);
    expect(JSON.stringify(body)).not.toContain(feePayer.secret());
  });

  it("GET /health and /metrics report the Stellar network, fee balance and runway (no secrets)", async () => {
    const health = (await (await fetch(`${facilitator.url}/health`)).json()) as { networks: Record<string, unknown>[] };
    const stellar = health.networks.find((n) => n["network"] === "stellar:testnet");
    expect(stellar).toMatchObject({
      rpcOk: true,
      latestLedger: 1_000,
      facilitator: feePayer.publicKey(),
      feePayers: [feePayer.publicKey()],
      nativeSymbol: "XLM",
      settleRunway: 2_000_000, // 10,000 XLM spendable / 0.005 XLM worst-case fee
      lowBalance: false,
      settlementSlots: { total: 1, busy: 0, waiting: 0 },
    });
    expect((stellar?.["feeBalances"] as { spendable: string }[])[0]?.spendable).toBe("10000 XLM");
    const metrics = (await (await fetch(`${facilitator.url}/metrics`)).json()) as Record<string, unknown>;
    expect(metrics["stellar"]).toMatchObject({ txCount: 0, pendingBroadcasts: 0, budget: { globalDailyLimitStroops: "500000000" } });
    expect(JSON.stringify(health) + JSON.stringify(metrics)).not.toContain(feePayer.secret());
  });
});

describe("admission guards (refused before any simulation)", () => {
  it("a denylisted payer is refused at verify and settle", async () => {
    const requirements = reqs();
    const payment = await buildStellarPayment(sanctionedPayer, requirements);
    const simBefore = rpc.count("simulateTransaction");
    const verify = await postJson(`${facilitator.url}/verify`, wire(payment, requirements));
    expect(verify.status).toBe(403);
    expect(verify.body).toMatchObject({ isValid: false, invalidReason: "address_denylisted", payer: sanctionedPayer.publicKey() });
    const settle = await postJson(`${facilitator.url}/settle`, wire(payment, requirements));
    expect(settle.status).toBe(403);
    expect(settle.body).toMatchObject({ success: false, errorReason: "address_denylisted", transaction: "", network: "stellar:testnet" });
    expect(rpc.count("simulateTransaction")).toBe(simBefore);
    noSubmission();
  });

  it("a muxed payTo is screened through the G… account that owns it", async () => {
    const requirements = reqs({ payTo: sanctionedMuxed });
    const payment = await buildStellarPayment(payer, requirements);
    const verify = await postJson(`${facilitator.url}/verify`, wire(payment, requirements));
    expect(verify.status).toBe(403);
    expect((verify.body as VerifyBody).invalidMessage).toMatch(/payTo/);
  });

  it("assets outside the network's allowlist, oversized timeouts and zero amounts are 400s", async () => {
    for (const [overrides, reason, message] of [
      [{ asset: OTHER_SAC }, "unsupported_asset", /not accepted/],
      [{ maxTimeoutSeconds: 301 }, "invalid_request", /maxTimeoutSeconds/],
      [{ maxTimeoutSeconds: 0 }, "invalid_request", /maxTimeoutSeconds/],
      [{ amount: "0" }, "invalid_request", /positive/],
    ] as const) {
      const requirements = reqs(overrides);
      const payment = await buildStellarPayment(payer, requirements, overrides.amount === "0" ? { amount: 0n } : {});
      const verify = await postJson(`${facilitator.url}/verify`, wire(payment, requirements));
      expect(verify.status, JSON.stringify(overrides)).toBe(400);
      expect(verify.body).toMatchObject({ isValid: false, invalidReason: reason });
      expect((verify.body as VerifyBody).invalidMessage).toMatch(message);
    }
  });

  it("an unknown Stellar network and a malformed body are 400s with the protocol shape", async () => {
    const requirements = reqs({ network: "stellar:pubnet" });
    const payment = await buildStellarPayment(payer, requirements);
    const verify = await postJson(`${facilitator.url}/verify`, wire(payment, requirements));
    expect(verify.status).toBe(400);
    expect(verify.body).toMatchObject({ isValid: false, invalidReason: "unsupported_scheme_network" });
    const bad = await postJson(`${facilitator.url}/settle`, wire({ ...payment, payload: { transaction: "%%%" } }, reqs()));
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ success: false, errorReason: "invalid_request", network: "stellar:testnet" });
  });
});

describe("the SDK decides validity; failures cost nothing", () => {
  it("a well-formed payment reaches @x402/stellar, which refuses it when simulation fails", async () => {
    const requirements = reqs();
    const payment = await buildStellarPayment(payer, requirements);
    const simBefore = rpc.count("simulateTransaction");
    const verify = await postJson(`${facilitator.url}/verify`, wire(payment, requirements));
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ isValid: false, invalidReason: "invalid_exact_stellar_payload_simulation_failed", payer: payer.publicKey() });
    expect(rpc.count("simulateTransaction")).toBe(simBefore + 1);
  });

  it("a settle that fails before broadcast releases its fee reservation and its replay lock", async () => {
    const requirements = reqs();
    const payment = await buildStellarPayment(payer, requirements);
    for (let i = 0; i < 2; i++) {
      const settle = await postJson(`${facilitator.url}/settle`, wire(payment, requirements));
      expect(settle.status).toBe(200);
      expect(settle.body).toMatchObject({ success: false, transaction: "", errorReason: "invalid_exact_stellar_payload_simulation_failed" });
    }
    const budget = facilitator.service.stellarFeeBudget;
    expect(budget.reservedNow("stellar:testnet|global")).toBe(0n);
    expect(budget.spentToday("stellar:testnet|global")).toBe(0n);
    noSubmission();
  });
});

describe("replay protection and fee-payer exclusivity", () => {
  it("the same authorization cannot be settled twice concurrently; other settles wait for the single fee payer", async () => {
    const busyRpc = await startMockSorobanRpc();
    const busy = await startStellarFacilitator(busyRpc, { STELLAR_SETTLE_QUEUE_TIMEOUT_MS: "0" });
    try {
      let release!: () => void;
      busyRpc.holdSimulation = new Promise<void>((resolve) => (release = resolve));
      const requirements = reqs();
      const first = await buildStellarPayment(payer, requirements);
      const second = await buildStellarPayment(payer, requirements);
      const inFlight = postJson(`${busy.url}/settle`, wire(first, requirements));
      while (busyRpc.count("simulateTransaction") === 0) await new Promise((r) => setTimeout(r, 10));

      const dupSettle = await postJson(`${busy.url}/settle`, wire(first, requirements));
      expect(dupSettle.status).toBe(409);
      expect(dupSettle.body).toMatchObject({ success: false, errorReason: "duplicate_settlement" });
      const dupVerify = await postJson(`${busy.url}/verify`, wire(first, requirements));
      expect(dupVerify.status).toBe(409);
      expect((dupVerify.body as VerifyBody).invalidMessage).toMatch(/being settled/);

      const other = await postJson(`${busy.url}/settle`, wire(second, requirements));
      expect(other.status).toBe(503);
      expect(other.headers.get("retry-after")).toBe("5");
      expect(other.body).toMatchObject({ success: false, errorReason: "facilitator_busy" });

      release();
      busyRpc.holdSimulation = undefined;
      expect((await inFlight).body).toMatchObject({ success: false, transaction: "" });
      const retried = await postJson(`${busy.url}/settle`, wire(second, requirements));
      expect(retried.body).toMatchObject({ success: false, errorReason: "invalid_exact_stellar_payload_simulation_failed" });
      expect(busyRpc.count("sendTransaction")).toBe(0);
    } finally {
      await busy.stop();
      await busyRpc.stop();
    }
  });
});

describe("rate limits, budgets and API keys, per network", () => {
  it("caller buckets are per network: exhausting Stellar does not throttle the same IP on Whitechain", async () => {
    const limitedRpc = await startMockSorobanRpc();
    const limited = await startStellarFacilitator(limitedRpc, { RATE_LIMIT_IP_PER_WINDOW: "2", RATE_LIMIT_WINDOW_SECONDS: "3600" });
    try {
      const requirements = reqs();
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        const payment = await buildStellarPayment(payer, requirements);
        statuses.push((await postJson(`${limited.url}/verify`, wire(payment, requirements))).status);
      }
      expect(statuses).toEqual([200, 200, 429]);
      const evm = privateKeyToAccount(generatePrivateKey());
      const evmReqs = { scheme: "exact", network: "eip155:31337", asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3", amount: "1", payTo: evm.address, maxTimeoutSeconds: 60, extra: {} };
      const evmPayload = {
        x402Version: 2,
        accepted: evmReqs,
        payload: { signature: "0x00", authorization: { from: evm.address, to: evm.address, value: "1", validAfter: "0", validBefore: "9999999999", nonce: `0x${"11".repeat(32)}` } },
      };
      const evmVerify = await postJson(`${limited.url}/verify`, wire(evmPayload, evmReqs));
      expect(evmVerify.status).not.toBe(429); // its own bucket (the dead EVM RPC answers 503)
    } finally {
      await limited.stop();
      await limitedRpc.stop();
    }
  });

  it("the network-wide ceiling applies to Stellar calls", async () => {
    const ceilingRpc = await startMockSorobanRpc();
    const ceiling = await startStellarFacilitator(ceilingRpc, { STELLAR_RATE_LIMIT_GLOBAL_PER_WINDOW: "1", RATE_LIMIT_WINDOW_SECONDS: "3600" });
    try {
      const requirements = reqs();
      const a = await postJson(`${ceiling.url}/verify`, wire(await buildStellarPayment(payer, requirements), requirements));
      const b = await postJson(`${ceiling.url}/verify`, wire(await buildStellarPayment(payer, requirements), requirements));
      expect(a.status).toBe(200);
      expect(b.status).toBe(429);
      expect((b.body as VerifyBody).invalidMessage).toMatch(/stellar:testnet network-wide/);
    } finally {
      await ceiling.stop();
      await ceilingRpc.stop();
    }
  });

  it("a zero per-payTo fee budget is a kill switch, refused before any RPC call", async () => {
    const killRpc = await startMockSorobanRpc();
    const kill = await startStellarFacilitator(killRpc, { STELLAR_FEE_BUDGET_PER_PAYTO_DAILY: "0" });
    try {
      const requirements = reqs();
      const ledgerReadsBefore = killRpc.count("getLedgerEntries");
      const verify = await postJson(`${kill.url}/verify`, wire(await buildStellarPayment(payer, requirements), requirements));
      expect(verify.status).toBe(429);
      expect(verify.body).toMatchObject({ isValid: false, invalidReason: "gas_budget_exceeded" });
      expect((verify.body as VerifyBody).invalidMessage).toMatch(/network-fee budget on stellar:testnet .* XLM/);
      expect(Number(verify.headers.get("retry-after"))).toBeGreaterThan(0);
      const settle = await postJson(`${kill.url}/settle`, wire(await buildStellarPayment(payer, requirements), requirements));
      expect(settle.status).toBe(429);
      expect(killRpc.count("getLedgerEntries")).toBe(ledgerReadsBefore);
      expect(killRpc.count("simulateTransaction")).toBe(0);
    } finally {
      await kill.stop();
      await killRpc.stop();
    }
  });

  it("an API key restricted to one Stellar payTo cannot settle to another (its muxed addresses are fine)", async () => {
    const keyRpc = await startMockSorobanRpc();
    const apiKey = "stellar-merchant-key-0123456789";
    const keyed = await startStellarFacilitator(keyRpc, { API_KEYS: JSON.stringify([{ name: "m", key: apiKey, payTo: [merchant.publicKey()] }]) });
    try {
      const other = Keypair.random().publicKey();
      const requirements = reqs({ payTo: other });
      const verify = await postJson(`${keyed.url}/verify`, wire(await buildStellarPayment(payer, requirements), requirements), { "X-API-Key": apiKey });
      expect(verify.status).toBe(401);
      expect(verify.body).toMatchObject({ invalidReason: "invalid_api_key" });
      const own = reqs();
      const ok = await postJson(`${keyed.url}/verify`, wire(await buildStellarPayment(payer, own), own), { "X-API-Key": apiKey });
      expect(ok.status).toBe(200);
      const muxedOwn = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(merchant.publicKey()), Buffer.alloc(8, 3)]));
      const viaMux = reqs({ payTo: muxedOwn });
      const muxOk = await postJson(`${keyed.url}/verify`, wire(await buildStellarPayment(payer, viaMux), viaMux), { "X-API-Key": apiKey });
      expect(muxOk.status).toBe(200); // the merchant's own muxed address is the same account
    } finally {
      await keyed.stop();
      await keyRpc.stop();
    }
  });
});

describe("fee payer and RPC failures", () => {
  it("an unfunded or empty fee payer is facilitator_out_of_gas (503), before simulation", async () => {
    for (const balanceStroops of [undefined, 0n]) {
      const poorRpc = await startMockSorobanRpc({ balanceStroops });
      const poor = await startStellarFacilitator(poorRpc);
      try {
        const requirements = reqs();
        const verify = await postJson(`${poor.url}/verify`, wire(await buildStellarPayment(payer, requirements), requirements));
        expect(verify.status).toBe(503);
        expect(verify.body).toMatchObject({ invalidReason: "facilitator_out_of_gas" });
        expect((verify.body as VerifyBody).invalidMessage).toContain(feePayer.publicKey());
        expect(poorRpc.count("simulateTransaction")).toBe(0);
        const health = (await (await fetch(`${poor.url}/health`)).json()) as { status: string; networks: Record<string, unknown>[] };
        expect(health.status).toBe("degraded");
        expect(health.networks.find((n) => n["network"] === "stellar:testnet")).toMatchObject({ lowBalance: true, settleRunway: 0 });
      } finally {
        await poor.stop();
        await poorRpc.stop();
      }
    }
  });

  it("an RPC that serves another network disables Stellar with rpc_unavailable", async () => {
    const wrongRpc = await startMockSorobanRpc({ passphrase: Networks.PUBLIC });
    const wrong = await startStellarFacilitator(wrongRpc);
    try {
      const requirements = reqs();
      const verify = await postJson(`${wrong.url}/verify`, wire(await buildStellarPayment(payer, requirements), requirements));
      expect(verify.status).toBe(503);
      expect(verify.body).toMatchObject({ invalidReason: "rpc_unavailable" });
      expect((verify.body as VerifyBody).invalidMessage).toMatch(/different network/);
      expect(wrongRpc.count("simulateTransaction")).toBe(0);
    } finally {
      await wrong.stop();
      await wrongRpc.stop();
    }
  });

  it("an unreachable RPC is rpc_unavailable with Retry-After, and its URL never leaves the process", async () => {
    const secretUrl = "http://127.0.0.1:9/rpc/sk_live_STELLAR_SECRET";
    const down = await startStellarFacilitator({ url: secretUrl });
    try {
      const requirements = reqs();
      const verify = await postJson(`${down.url}/verify`, wire(await buildStellarPayment(payer, requirements), requirements));
      expect(verify.status).toBe(503);
      expect(verify.headers.get("retry-after")).toBe("15");
      expect(verify.body).toMatchObject({ invalidReason: "rpc_unavailable" });
      const health = await (await fetch(`${down.url}/health`)).text();
      expect(JSON.parse(health)).toMatchObject({ status: "degraded" });
      for (const text of [JSON.stringify(verify.body), health, await (await fetch(`${down.url}/metrics`)).text()]) {
        expect(text).not.toContain("sk_live_STELLAR_SECRET");
      }
    } finally {
      await down.stop();
    }
  });
});
