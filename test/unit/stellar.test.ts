// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { accountKey, addressKey, isStellarAddress, isStellarNetworkId, screeningAddresses, stellarBaseAccount } from "../../src/address.js";
import { describeConfig, loadConfig, parseApiKeys, parseStellarKeys, parseStellarNetworks, parseXlmBudget } from "../../src/config.js";
import { parseDenylist, StaticDenylist } from "../../src/policy/denylist.js";
import { AccruingFeePolicy } from "../../src/policy/fee.js";
import { parseFacilitatorRequest } from "../../src/schema.js";
import { decodeStellarPayment, stellarAuthorizationKey } from "../../src/stellar/payload.js";
import { SignerPool, selectLeasedSigner, stellarSignerContext } from "../../src/stellar/pool.js";
import { buildStellarPayment, stellarRequirements, XLM_SAC_TESTNET } from "../helpers/stellar.js";

const EVM_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const feePayer = Keypair.random();
const payer = Keypair.random();
const merchant = Keypair.random();
const muxedMerchant = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(merchant.publicKey()), Buffer.alloc(8, 7)]));

describe("Stellar configuration", () => {
  it("is off unless STELLAR_FACILITATOR_KEY is set, and Whitechain defaults are untouched", () => {
    const c = loadConfig({ FACILITATOR_PRIVATE_KEY: EVM_KEY });
    expect(c.stellar).toBeUndefined();
    expect(c.networks.map((n) => n.id)).toEqual(["eip155:1874"]);
    expect(describeConfig(c)).not.toHaveProperty("stellar");
  });

  it("defaults to stellar:testnet with the public Soroban RPC and per-network budgets in stroops", () => {
    const c = loadConfig({ FACILITATOR_PRIVATE_KEY: EVM_KEY, STELLAR_FACILITATOR_KEY: feePayer.secret() });
    expect(c.stellar?.networks).toHaveLength(1);
    expect(c.stellar?.networks[0]).toMatchObject({
      id: "stellar:testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      explorerUrl: "https://stellar.expert/explorer/testnet",
      networkPassphrase: Networks.TESTNET,
      nativeSymbol: "XLM",
      maxFeeStroops: 50_000,
      inclusionFeeStroops: 100,
      maxTimeoutSeconds: 300,
    });
    expect(c.stellar?.feeBudget).toEqual({ globalDailyStroops: 500_000_000n, perPayToDailyStroops: 50_000_000n });
    expect(c.stellar?.globalPerWindow).toBe(300);
  });

  it("never exposes the Stellar secret through enumeration, JSON or describeConfig", () => {
    const c = loadConfig({ FACILITATOR_PRIVATE_KEY: EVM_KEY, STELLAR_FACILITATOR_KEY: feePayer.secret() });
    expect(Object.keys(c.stellar!)).not.toContain("secretKeys");
    const json = JSON.stringify(c, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(json).not.toContain(feePayer.secret());
    expect(JSON.stringify(describeConfig(c))).not.toContain(feePayer.secret());
    expect(describeConfig(c)).toMatchObject({ stellar: { feePayerAccounts: 1 } });
    expect(c.stellar?.secretKeys).toEqual([feePayer.secret()]);
  });

  it("accepts several fee-payer keys and refuses bad ones without echoing them", () => {
    const second = Keypair.random();
    expect(parseStellarKeys(`${feePayer.secret()}, ${second.secret()}`)).toEqual([feePayer.secret(), second.secret()]);
    const bad = `S${"A".repeat(55)}`;
    expect(() => parseStellarKeys(bad)).toThrow(/entry 1 is not a Stellar secret seed/);
    try {
      parseStellarKeys(`${feePayer.secret()},${bad}`);
    } catch (error) {
      expect(String(error)).not.toContain(bad);
      expect(String(error)).not.toContain(feePayer.secret());
    }
    expect(() => parseStellarKeys(feePayer.publicKey())).toThrow(/secret seed/);
    expect(() => parseStellarKeys(`${feePayer.secret()},${feePayer.secret()}`)).toThrow(/duplicate/);
    expect(() => loadConfig({ FACILITATOR_PRIVATE_KEY: EVM_KEY, STELLAR_FACILITATOR_KEY: "nope" })).toThrow(/Stellar secret seed/);
  });

  it("is testnet only in this release and validates every field", () => {
    expect(() => parseStellarNetworks('[{"id":"stellar:pubnet","rpc":"https://rpc.example"}]')).toThrow(/stellar:testnet/);
    expect(() => parseStellarNetworks('[{"id":"stellar:testnet","rpc":"file:///etc/passwd"}]')).toThrow(/http/);
    expect(() => parseStellarNetworks(`[{"id":"stellar:testnet","assets":["${payer.publicKey()}"]}]`)).toThrow(/contract/);
    expect(() => parseStellarNetworks('[{"id":"stellar:testnet"},{"id":"stellar:testnet"}]')).toThrow(/duplicate/);
    expect(() => parseStellarNetworks('[{"id":"stellar:testnet","maxTimeoutSeconds":0}]')).toThrow();
    const [n] = parseStellarNetworks(`{"id":"stellar:testnet","rpc":"http://127.0.0.1:8000","assets":["${XLM_SAC_TESTNET}"],"maxFeeStroops":20000}`);
    expect(n?.rpcUrl).toBe("http://127.0.0.1:8000");
    expect(n?.assets?.has(XLM_SAC_TESTNET)).toBe(true);
    expect(n?.maxFeeStroops).toBe(20_000);
    expect(() => loadConfig({ FACILITATOR_PRIVATE_KEY: EVM_KEY, STELLAR_NETWORKS: '[{"id":"stellar:testnet"}]' })).toThrow(/STELLAR_FACILITATOR_KEY/);
  });

  it("parses XLM budgets with 7 decimals and the same unlimited / kill-switch forms", () => {
    expect(parseXlmBudget("1")).toBe(10_000_000n);
    expect(parseXlmBudget("0.0000001")).toBe(1n);
    expect(parseXlmBudget("0")).toBe(0n);
    expect(parseXlmBudget("unlimited")).toBeNull();
    expect(() => parseXlmBudget("0.00000001")).toThrow();
    expect(() => parseXlmBudget("-1")).toThrow();
  });

  it("lets API keys restrict payTo to Stellar addresses (verbatim) and carry a Stellar fee budget", () => {
    const [k] = parseApiKeys(
      JSON.stringify([
        { name: "m", key: "merchant-key-0123456789abcdef", dailyStellarFeeBudget: "2.5", payTo: [merchant.publicKey(), "0x5FbDB2315678afecb367f032d93F642f64180aa3"] },
      ]),
    );
    expect(k?.payTo?.has(merchant.publicKey())).toBe(true);
    expect(k?.payTo?.has(merchant.publicKey().toLowerCase())).toBe(false);
    expect(k?.payTo?.has("0x5fbdb2315678afecb367f032d93f642f64180aa3")).toBe(true);
    expect(k?.dailyStellarFeeBudgetStroops).toBe(25_000_000n);
    expect(() => parseApiKeys(JSON.stringify([{ name: "m", key: "merchant-key-0123456789abcdef", payTo: [merchant.publicKey().toLowerCase()] }]))).toThrow();
  });
});

describe("addresses", () => {
  it("keeps Stellar strkeys verbatim and lower-cases only EVM hex", () => {
    expect(addressKey(merchant.publicKey())).toBe(merchant.publicKey());
    expect(addressKey("0xAbC0000000000000000000000000000000000001")).toBe("0xabc0000000000000000000000000000000000001");
    expect(isStellarAddress(merchant.publicKey())).toBe(true);
    expect(isStellarAddress(merchant.publicKey().toLowerCase())).toBe(false);
    expect(isStellarAddress(XLM_SAC_TESTNET)).toBe(true);
    expect(isStellarAddress(muxedMerchant)).toBe(true);
    expect(isStellarNetworkId("stellar:testnet")).toBe(true);
    expect(isStellarNetworkId("eip155:1874")).toBe(false);
  });

  it("screens a muxed M… address together with the G… account that owns it", () => {
    expect(stellarBaseAccount(muxedMerchant)).toBe(merchant.publicKey());
    expect(screeningAddresses(muxedMerchant)).toEqual([muxedMerchant, merchant.publicKey()]);
    expect(screeningAddresses(merchant.publicKey())).toEqual([merchant.publicKey()]);
  });

  it("counts every muxed id of an account as that account for limits and budgets", () => {
    const otherMux = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(merchant.publicKey()), Buffer.alloc(8, 9)]));
    expect(accountKey(muxedMerchant)).toBe(merchant.publicKey());
    expect(accountKey(otherMux)).toBe(merchant.publicKey());
    expect(accountKey(XLM_SAC_TESTNET)).toBe(XLM_SAC_TESTNET);
    expect(accountKey("0xAbC0000000000000000000000000000000000001")).toBe("0xabc0000000000000000000000000000000000001");
  });
});

describe("Stellar payload decoding mirrors @x402/stellar", () => {
  const reqs = stellarRequirements({ payTo: merchant.publicKey(), amount: "1234567" });

  it("extracts contract, payer, recipient, amount, nonce and expiry from a signed payload", async () => {
    const p = await buildStellarPayment(payer, reqs, { nonce: 42n, expirationLedger: 5_000 });
    const decoded = decodeStellarPayment(p.payload, Networks.TESTNET);
    expect(decoded).toEqual({
      contract: XLM_SAC_TESTNET,
      from: payer.publicKey(),
      to: merchant.publicKey(),
      amount: 1_234_567n,
      nonces: ["42"],
      expirationLedger: 5_000,
    });
    expect(stellarAuthorizationKey("stellar:testnet", decoded)).toBe(`stellar:testnet|${payer.publicKey()}|42`);
  });

  it("returns undefined for anything the SDK would refuse as malformed", async () => {
    expect(decodeStellarPayment(undefined, Networks.TESTNET)).toBeUndefined();
    expect(decodeStellarPayment({ transaction: "AAAA" }, Networks.TESTNET)).toBeUndefined();
    expect(decodeStellarPayment({ transaction: 42 }, Networks.TESTNET)).toBeUndefined();
    expect(decodeStellarPayment({ transaction: "A".repeat(20_000) }, Networks.TESTNET)).toBeUndefined();
    const approve = await buildStellarPayment(payer, reqs, { functionName: "approve" });
    expect(decodeStellarPayment(approve.payload, Networks.TESTNET)).toBeUndefined();
    expect(stellarAuthorizationKey("stellar:testnet", undefined)).toBeUndefined();
  });

  it("different nonces are different authorizations; the same nonce is the same one", async () => {
    const a = decodeStellarPayment((await buildStellarPayment(payer, reqs, { nonce: 1n })).payload, Networks.TESTNET);
    const b = decodeStellarPayment((await buildStellarPayment(payer, reqs, { nonce: 2n })).payload, Networks.TESTNET);
    const a2 = decodeStellarPayment((await buildStellarPayment(payer, reqs, { nonce: 1n, amount: 5n })).payload, Networks.TESTNET);
    expect(stellarAuthorizationKey("stellar:testnet", a)).not.toBe(stellarAuthorizationKey("stellar:testnet", b));
    expect(stellarAuthorizationKey("stellar:testnet", a)).toBe(stellarAuthorizationKey("stellar:testnet", a2));
  });
});

describe("Stellar wire schema", () => {
  const reqs = stellarRequirements({ payTo: merchant.publicKey() });
  const body = (payload: unknown, requirements: unknown = reqs, accepted: unknown = requirements) => ({
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted, payload },
    paymentRequirements: requirements,
  });

  it("accepts a Stellar payment and routes on the requirements' network", async () => {
    const p = await buildStellarPayment(payer, reqs);
    const parsed = parseFacilitatorRequest(body(p.payload));
    expect(parsed.ok).toBe(true);
    // The same body with an EVM network is checked against the EVM schema (and fails there).
    expect(parseFacilitatorRequest(body(p.payload, { ...reqs, network: "eip155:1874" })).ok).toBe(false);
  });

  it("refuses EVM-shaped fields, lower-cased strkeys and non-base64 transactions with a 400 message", async () => {
    const p = await buildStellarPayment(payer, reqs);
    const cases: [unknown, RegExp][] = [
      [body(p.payload, { ...reqs, asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3" }), /asset/],
      [body(p.payload, { ...reqs, asset: merchant.publicKey() }), /contract/],
      [body(p.payload, { ...reqs, payTo: merchant.publicKey().toLowerCase() }), /payTo/],
      [body({ transaction: "not base64!" }), /base64/],
      [body({ transaction: "A".repeat(20_000) }), /at most/],
      [body({ signature: "0x00" }), /transaction/],
      [body(p.payload, reqs, { ...reqs, asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3" }), /accepted\.asset/],
    ];
    for (const [b, expected] of cases) {
      const parsed = parseFacilitatorRequest(b);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toMatch(expected);
    }
  });
});

describe("denylist and fee accounting with Stellar addresses", () => {
  it("parses G…, C… and M… lines verbatim next to EVM lines", () => {
    const set = parseDenylist(`# sanctioned\n${payer.publicKey()}  # note\n${XLM_SAC_TESTNET}\n${muxedMerchant}\n0x7F367cC41522cE07553e823bf3be79A889DEbe1B\n${merchant.publicKey().toLowerCase()}\nGBADCHECKSUM\n`);
    expect(set.has(payer.publicKey())).toBe(true);
    expect(set.has(XLM_SAC_TESTNET)).toBe(true);
    expect(set.has(muxedMerchant)).toBe(true);
    expect(set.has("0x7f367cc41522ce07553e823bf3be79a889debe1b")).toBe(true);
    expect(set.size).toBe(4); // the lower-cased strkey is not a valid address and is ignored
  });

  it("matches Stellar addresses exactly (case-sensitive) and EVM addresses case-insensitively", () => {
    const list = new StaticDenylist([payer.publicKey(), "0x7F367cC41522cE07553e823bf3be79A889DEbe1B"]);
    expect(list.isDenied(payer.publicKey())).toBe(true);
    expect(list.isDenied(payer.publicKey().toLowerCase())).toBe(false);
    expect(list.isDenied("0x7f367cc41522ce07553e823bf3be79a889debe1b")).toBe(true);
  });

  it("accrues fees under the verbatim Stellar payTo and asset", () => {
    const policy = new AccruingFeePolicy({ bps: 100, flatAtomic: 0n });
    const ctx = { network: "stellar:testnet", asset: XLM_SAC_TESTNET, amount: 1_000_000n, payTo: merchant.publicKey(), payer: payer.publicKey(), apiKeyName: undefined };
    policy.onSettled(ctx, policy.quote(ctx));
    expect(Object.keys(policy.snapshot()["accrued"] as Record<string, unknown>)).toEqual([`payto:${merchant.publicKey()}|stellar:testnet|${XLM_SAC_TESTNET}`]);
  });
});

describe("SignerPool", () => {
  it("leases each fee-payer account to one settlement at a time, FIFO", async () => {
    const pool = new SignerPool(["A", "B"]);
    const a = await pool.acquire(1_000);
    const b = await pool.acquire(1_000);
    expect(new Set([a?.address, b?.address])).toEqual(new Set(["A", "B"]));
    expect(pool.idleCount).toBe(0);
    const order: string[] = [];
    const third = pool.acquire(1_000).then((l) => {
      order.push(`third:${l?.address}`);
      return l;
    });
    const fourth = pool.acquire(1_000).then((l) => {
      order.push(`fourth:${l?.address}`);
      return l;
    });
    expect(pool.waitingCount).toBe(2);
    a?.release();
    a?.release(); // idempotent
    const t = await third;
    b?.release();
    const f = await fourth;
    expect(order).toEqual([`third:${a?.address}`, `fourth:${b?.address}`]);
    t?.release();
    f?.release();
    expect(pool.idleCount).toBe(2);
    expect(pool.busyCount).toBe(0);
  });

  it("gives up after the timeout, at once with a zero timeout, and when the queue is full", async () => {
    const pool = new SignerPool(["A"], { maxWaiters: 1 });
    const a = await pool.acquire(0);
    expect(a?.address).toBe("A");
    expect(await pool.acquire(0)).toBeUndefined();
    const started = Date.now();
    const waiting = pool.acquire(50);
    expect(await pool.acquire(1_000)).toBeUndefined(); // queue full
    expect(await waiting).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(pool.waitingCount).toBe(0);
    a?.release();
    expect(pool.idleCount).toBe(1);
  });

  it("selectLeasedSigner returns the leased account and refuses to guess without one", () => {
    expect(() => selectLeasedSigner(["A", "B"])).toThrow(/leased/);
    expect(stellarSignerContext.run({ address: "B" }, () => selectLeasedSigner(["A", "B"]))).toBe("B");
    expect(() => stellarSignerContext.run({ address: "C" }, () => selectLeasedSigner(["A", "B"]))).toThrow(/leased/);
  });
});
