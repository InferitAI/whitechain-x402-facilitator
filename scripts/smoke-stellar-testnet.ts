#!/usr/bin/env tsx
// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live smoke test on Stellar testnet (not part of `npm test`). Everything it creates is
 * throwaway: friendbot-funded accounts and a fresh test asset with its Stellar Asset Contract.
 *
 *   npm run smoke:stellar                                  # facilitator in-process, fresh fee payer
 *   FACILITATOR_URL=https://facilitator.example npm run smoke:stellar   # a running facilitator
 *
 * It starts a throwaway merchant (official @x402/express middleware + HTTPFacilitatorClient),
 * pays it with the official @x402/fetch client and @x402/stellar's client scheme, and checks
 * that the token moved, the payer paid no network fee, and a replay of the same payment is
 * refused.
 *
 * Optional: STELLAR_FACILITATOR_KEY (in-process mode: use this fee payer instead of a fresh one;
 * never printed), ASSET=xlm (pay in native XLM through its SAC instead of a fresh test asset),
 * AMOUNT (atomic units, 7 decimals; default 1000000 = 0.1), FACILITATOR_API_KEY,
 * STELLAR_RPC_URL (default https://soroban-testnet.stellar.org).
 */
import { createServer } from "node:http";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactStellarScheme as ExactStellarClientScheme, createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as ExactStellarServerScheme } from "@x402/stellar/exact/server";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import { generatePrivateKey } from "viem/accounts";
import { loadConfig } from "../src/config.js";
import { FacilitatorService } from "../src/facilitator.js";
import { createLogger } from "../src/logger.js";
import { buildServer } from "../src/server.js";
import {
  TESTNET_EXPLORER,
  TESTNET_RPC_URL,
  assetBalance,
  createTestAsset,
  friendbot,
  testnetServer,
  xlmBalance,
} from "./lib/stellar-testnet.js";

const network = "stellar:testnet" as Network;
const amount = process.env.AMOUNT ?? "1000000";
const apiKey = process.env.FACILITATOR_API_KEY;
const useXlm = (process.env.ASSET ?? "").toLowerCase() === "xlm";

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

const server = testnetServer();
const payer = Keypair.random();
const merchant = Keypair.random();
const issuer = Keypair.random();

// 1. facilitator: a running one, or one in this process with its own fee-payer account
let facilitatorUrl = process.env.FACILITATOR_URL?.replace(/\/+$/, "");
let stopFacilitator: (() => Promise<void>) | undefined;
if (!facilitatorUrl) {
  const feePayerKey = process.env.STELLAR_FACILITATOR_KEY?.trim() || Keypair.random().secret();
  const feePayer = Keypair.fromSecret(feePayerKey.split(",")[0]!.trim()).publicKey();
  await friendbot(feePayer);
  const config = loadConfig({
    ...process.env,
    FACILITATOR_PRIVATE_KEY: process.env.FACILITATOR_PRIVATE_KEY ?? generatePrivateKey(),
    STELLAR_FACILITATOR_KEY: feePayerKey,
    STELLAR_NETWORKS: JSON.stringify([{ id: network, rpc: TESTNET_RPC_URL }]),
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    PROXY_PROBE_MINUTES: "0",
  });
  const logger = createLogger(config.logLevel);
  const service = new FacilitatorService(config, logger);
  const { app } = buildServer(config, logger, service);
  await service.start();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  facilitatorUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  stopFacilitator = async () => {
    service.stop();
    await app.close();
  };
  console.log(`facilitator: in-process at ${facilitatorUrl}, fee payer ${feePayer}`);
} else {
  console.log(`facilitator: ${facilitatorUrl}`);
}

const facilitatorClient = new HTTPFacilitatorClient({
  url: facilitatorUrl,
  timeoutMs: 120_000,
  ...(apiKey
    ? {
        createAuthHeaders: async () => {
          const headers = { "X-API-Key": apiKey };
          return { verify: headers, settle: headers, supported: headers };
        },
      }
    : {}),
});

let httpServer: ReturnType<typeof createServer> | undefined;
try {
  const supported = await facilitatorClient.getSupported();
  const kind = supported.kinds.find((k) => k.scheme === "exact" && k.network === network && k.x402Version === 2);
  check(!!kind, "GET /supported advertises exact on stellar:testnet", JSON.stringify(kind ?? supported.kinds));
  check(kind?.extra?.["areFeesSponsored"] === true, "fees are sponsored (extra.areFeesSponsored)");
  console.log(`fee payer(s): ${(supported.signers["stellar:*"] ?? []).join(", ")}`);

  // 2. throwaway accounts and asset
  await Promise.all([friendbot(payer.publicKey()), friendbot(merchant.publicKey()), useXlm ? Promise.resolve() : friendbot(issuer.publicKey())]);
  let asset: Asset;
  let contractId: string;
  if (useXlm) {
    asset = Asset.native();
    contractId = asset.contractId(Networks.TESTNET);
  } else {
    ({ asset, contractId } = await createTestAsset(server, issuer, [payer, merchant], { to: payer, units: "100" }));
  }
  console.log(`payer:       ${payer.publicKey()}`);
  console.log(`payTo:       ${merchant.publicKey()}`);
  console.log(`asset:       ${useXlm ? "XLM" : `${asset.getCode()}:${asset.getIssuer()}`} (SAC ${contractId})`);

  const [payerTokenBefore, payToTokenBefore, payerXlmBefore] = await Promise.all([
    assetBalance(server, payer.publicKey(), asset),
    assetBalance(server, merchant.publicKey(), asset),
    xlmBalance(server, payer.publicKey()),
  ]);

  // 3. throwaway merchant with the official middleware
  const resourceServer = new x402ResourceServer(facilitatorClient).register(network, new ExactStellarServerScheme());
  const app = express();
  app.use(
    paymentMiddleware(
      {
        "GET /smoke": {
          accepts: { scheme: "exact", network, payTo: merchant.publicKey(), price: { asset: contractId, amount }, maxTimeoutSeconds: 60 },
          description: "Stellar x402 smoke test",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );
  app.get("/smoke", (_req, res) => {
    res.json({ ok: true, at: new Date().toISOString() });
  });
  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", () => resolve()));
  const address = httpServer.address();
  const merchantUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  // 4. pay with the official client, capturing the payment header for the replay check
  let paymentHeader: string | undefined;
  const spyFetch: typeof fetch = async (input, init) => {
    const headers = typeof input === "object" && input !== null && "headers" in input ? (input as Request).headers : new Headers(init?.headers);
    paymentHeader = headers.get("PAYMENT-SIGNATURE") ?? paymentHeader;
    return fetch(input, init);
  };
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(spyFetch, {
    schemes: [{ network, client: new ExactStellarClientScheme(createEd25519Signer(payer.secret(), network)) }],
    spendControls: { allowedAssets: [{ network, asset: contractId, maxAmountPerPayment: amount }] },
  });
  const started = Date.now();
  const res = await fetchWithPayment(`${merchantUrl}/smoke`);
  const elapsed = Date.now() - started;
  const body = await res.text();
  check(res.status === 200, "paid request returned 200", `${elapsed}ms body=${body.slice(0, 80)}`);
  const header = res.headers.get("PAYMENT-RESPONSE");
  check(!!header, "PAYMENT-RESPONSE header present");
  if (header) {
    const settlement = decodePaymentResponseHeader(header);
    check(settlement.success === true, "settlement success", `reason=${settlement.errorReason ?? "-"}`);
    if (settlement.transaction) {
      console.log(`tx: ${TESTNET_EXPLORER}/tx/${settlement.transaction}`);
      const tx = await server.getTransaction(settlement.transaction);
      check(tx.status === "SUCCESS", "settlement transaction is final and successful", `status=${tx.status}`);
    }
  }
  const [payerTokenAfter, payToTokenAfter, payerXlmAfter] = await Promise.all([
    assetBalance(server, payer.publicKey(), asset),
    assetBalance(server, merchant.publicKey(), asset),
    xlmBalance(server, payer.publicKey()),
  ]);
  check(payToTokenAfter === payToTokenBefore + BigInt(amount), "payTo balance increased by amount", `${payToTokenBefore} -> ${payToTokenAfter}`);
  if (useXlm) {
    check(payerXlmAfter === payerXlmBefore - BigInt(amount), "payer XLM decreased by exactly the amount (no fee paid)", `${payerXlmBefore} -> ${payerXlmAfter}`);
  } else {
    check(payerTokenAfter === payerTokenBefore - BigInt(amount), "payer token balance decreased by amount", `${payerTokenBefore} -> ${payerTokenAfter}`);
    check(payerXlmAfter === payerXlmBefore, "payer paid no network fee", `${payerXlmBefore} -> ${payerXlmAfter}`);
  }

  // 5. replay must be refused
  if (paymentHeader) {
    const replay = await fetch(`${merchantUrl}/smoke`, { headers: { "PAYMENT-SIGNATURE": paymentHeader } });
    const required = replay.headers.get("PAYMENT-REQUIRED");
    const reason = required ? (JSON.parse(Buffer.from(required, "base64").toString("utf8")) as { error?: string }).error : undefined;
    check(replay.status === 402, "replayed payment header refused with 402", `error=${reason}`);
  }

  const health = (await (await fetch(`${facilitatorUrl}/health`)).json()) as { networks: { network: string; rpcOk: boolean; settleRunway?: number }[] };
  const stellar = health.networks.find((n) => n.network === network);
  check(!!stellar?.rpcOk, "GET /health reports stellar:testnet reachable", `runway=${stellar?.settleRunway}`);
} finally {
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  await stopFacilitator?.();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
