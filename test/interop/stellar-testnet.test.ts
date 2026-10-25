// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live interop on Stellar testnet. Opt-in (it needs the internet, friendbot and ~1 minute):
 *
 *   npm run test:stellar-live        # STELLAR_LIVE=1 vitest run test/interop/stellar-testnet.test.ts
 *
 * Unmodified official packages end to end: @x402/express and @x402/hono resource servers with
 * @x402/stellar's server scheme, pointed at this facilitator through HTTPFacilitatorClient, paid
 * by @x402/fetch with @x402/stellar's client scheme. The asset is a fresh classic test asset with
 * its Stellar Asset Contract (7 decimals), like an Inferit test credit; all accounts are
 * throwaway and friendbot-funded.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware as expressPaymentMiddleware } from "@x402/express";
import { paymentMiddleware as honoPaymentMiddleware } from "@x402/hono";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import type { RoutesConfig } from "@x402/core/http";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactStellarScheme as ExactStellarClientScheme, createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as ExactStellarServerScheme } from "@x402/stellar/exact/server";
import { Keypair, type Asset } from "@stellar/stellar-sdk";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TESTNET_RPC_URL, assetBalance, createTestAsset, friendbot, testnetServer, xlmBalance } from "../../scripts/lib/stellar-testnet.js";
import { startFacilitator, type RunningFacilitator } from "../helpers/facilitator.js";
import { postJson } from "../helpers/payments.js";
import { buildStellarPayment } from "../helpers/stellar.js";

const LIVE = process.env.STELLAR_LIVE === "1";
const network = "stellar:testnet" as Network;
const AMOUNT = "1000000"; // 0.1 of a 7-decimal asset

describe.skipIf(!LIVE)("Stellar testnet, official x402 packages end to end", () => {
  const server = testnetServer();
  const feePayer = Keypair.random();
  const payer = Keypair.random();
  const merchant = Keypair.random();
  const issuer = Keypair.random();
  let asset: Asset;
  let contractId: string;
  let facilitator: RunningFacilitator;
  const servers: Server[] = [];
  let expressUrl = "";
  let honoUrl = "";

  const routes = (): RoutesConfig => ({
    "GET /paid": {
      accepts: { scheme: "exact", network, payTo: merchant.publicKey(), price: { asset: contractId, amount: AMOUNT }, maxTimeoutSeconds: 60 },
      description: "A paid resource",
      mimeType: "application/json",
    },
  });
  const resourceServer = () =>
    new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitator.url, timeoutMs: 120_000 })).register(network, new ExactStellarServerScheme());

  const payingFetch = (capture?: (header: string) => void) => {
    const spy: typeof fetch = async (input, init) => {
      const headers = typeof input === "object" && input !== null && "headers" in input ? (input as Request).headers : new Headers(init?.headers);
      const h = headers.get("PAYMENT-SIGNATURE");
      if (h) capture?.(h);
      return fetch(input, init);
    };
    return wrapFetchWithPaymentFromConfig(spy, {
      schemes: [{ network, client: new ExactStellarClientScheme(createEd25519Signer(payer.secret(), network)) }],
      spendControls: { allowedAssets: [{ network, asset: contractId, maxAmountPerPayment: AMOUNT }] },
    });
  };

  beforeAll(async () => {
    await Promise.all([feePayer, payer, merchant, issuer].map((k) => friendbot(k.publicKey())));
    ({ asset, contractId } = await createTestAsset(server, issuer, [payer, merchant], { to: payer, units: "100" }));
    facilitator = await startFacilitator({ url: "http://127.0.0.1:9", chainId: 31337 }, generatePrivateKey(), {
      STELLAR_FACILITATOR_KEY: feePayer.secret(),
      STELLAR_NETWORKS: JSON.stringify([{ id: network, rpc: TESTNET_RPC_URL, assets: [contractId] }]),
      HEALTH_CACHE_SECONDS: "0",
    });

    const app = express();
    app.use(expressPaymentMiddleware(routes(), resourceServer()));
    app.get("/paid", (_req, res) => {
      res.json({ ok: true, served: "express" });
    });
    const expressServer = createServer(app);
    await new Promise<void>((resolve) => expressServer.listen(0, "127.0.0.1", () => resolve()));
    servers.push(expressServer);
    expressUrl = `http://127.0.0.1:${(expressServer.address() as { port: number }).port}`;

    const hono = new Hono();
    hono.use(honoPaymentMiddleware(routes(), resourceServer()));
    hono.get("/paid", (c) => c.json({ ok: true, served: "hono" }));
    const honoServer = serve({ fetch: hono.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    await new Promise<void>((resolve) => (honoServer.listening ? resolve() : honoServer.once("listening", () => resolve())));
    servers.push(honoServer);
    honoUrl = `http://127.0.0.1:${(honoServer.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
    await facilitator?.stop();
  });

  it("@x402/express + @x402/fetch: the payer pays the asset, the facilitator pays the fee, a replay is refused", async () => {
    const [payerBefore, merchantBefore, payerXlmBefore] = await Promise.all([
      assetBalance(server, payer.publicKey(), asset),
      assetBalance(server, merchant.publicKey(), asset),
      xlmBalance(server, payer.publicKey()),
    ]);
    let header: string | undefined;
    const res = await payingFetch((h) => (header = h))(`${expressUrl}/paid`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, served: "express" });
    const settlement = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settlement).toMatchObject({ success: true, network, payer: payer.publicKey() });
    expect(settlement.transaction).toMatch(/^[0-9a-f]{64}$/);
    console.log(`express payment: https://stellar.expert/explorer/testnet/tx/${settlement.transaction}`);
    expect((await server.getTransaction(settlement.transaction)).status).toBe("SUCCESS");

    expect(await assetBalance(server, payer.publicKey(), asset)).toBe(payerBefore - BigInt(AMOUNT));
    expect(await assetBalance(server, merchant.publicKey(), asset)).toBe(merchantBefore + BigInt(AMOUNT));
    expect(await xlmBalance(server, payer.publicKey())).toBe(payerXlmBefore);

    const replay = await fetch(`${expressUrl}/paid`, { headers: { "PAYMENT-SIGNATURE": header! } });
    expect(replay.status).toBe(402);
    const required = JSON.parse(Buffer.from(replay.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8")) as { error?: string };
    expect(required.error).toMatch(/duplicate_settlement/);

    const metrics = (await (await fetch(`${facilitator.url}/metrics`)).json()) as { stellar: { txCount: number; feesSpentStroops: Record<string, string> } };
    expect(metrics.stellar.txCount).toBe(1);
    const fee = BigInt(metrics.stellar.feesSpentStroops[network] ?? "0");
    expect(fee > 0n && fee <= 50_000n).toBe(true);
    expect(facilitator.service.stellarFeeBudget.spentToday(`${network}|global`)).toBe(fee);
  });

  it("@x402/hono works the same, and two payments at once share the single fee payer without a sequence clash", async () => {
    const merchantBefore = await assetBalance(server, merchant.publicKey(), asset);
    const pay = payingFetch();
    const [a, b] = await Promise.all([pay(`${honoUrl}/paid`), pay(`${honoUrl}/paid`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const txs = [a, b].map((r) => decodePaymentResponseHeader(r.headers.get("PAYMENT-RESPONSE")!).transaction);
    expect(new Set(txs).size).toBe(2);
    for (const tx of txs) console.log(`hono payment: https://stellar.expert/explorer/testnet/tx/${tx}`);
    expect(await assetBalance(server, merchant.publicKey(), asset)).toBe(merchantBefore + 2n * BigInt(AMOUNT));
  });

  it("a payment whose transfer does not match the requirements is refused by the SDK and never broadcast", async () => {
    const requirements = {
      scheme: "exact",
      network,
      asset: contractId,
      amount: AMOUNT,
      payTo: merchant.publicKey(),
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    } as const;
    const latest = (await server.getLatestLedger()).sequence;
    const underpaid = await buildStellarPayment(payer, requirements, { amount: 1n, expirationLedger: latest + 10 });
    const wire = { x402Version: 2, paymentPayload: underpaid, paymentRequirements: requirements };
    const verify = await postJson(`${facilitator.url}/verify`, wire);
    expect(verify.body).toMatchObject({ isValid: false, invalidReason: "invalid_exact_stellar_payload_wrong_amount" });
    const before = facilitator.service.stellarFeeBudget.spentToday(`${network}|global`);
    const settle = await postJson(`${facilitator.url}/settle`, wire);
    expect(settle.body).toMatchObject({ success: false, transaction: "", errorReason: "invalid_exact_stellar_payload_wrong_amount" });
    expect(facilitator.service.stellarFeeBudget.spentToday(`${network}|global`)).toBe(before);
  });

  it("GET /health shows the fee payer's real balance and runway", async () => {
    const health = (await (await fetch(`${facilitator.url}/health`)).json()) as { networks: Record<string, unknown>[] };
    const stellar = health.networks.find((n) => n["network"] === network);
    expect(stellar).toMatchObject({ rpcOk: true, facilitator: feePayer.publicKey(), lowBalance: false });
    expect(Number(stellar?.["settleRunway"])).toBeGreaterThan(100_000);
  });
});
