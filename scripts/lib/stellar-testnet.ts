// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stellar testnet helpers for the live smoke script and the opt-in live interop test: friendbot
 * funding, a throwaway classic asset with its Stellar Asset Contract (SAC), and balance reads.
 * Testnet only.
 */
import {
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

export const TESTNET_RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const FRIENDBOT_URL = process.env.STELLAR_FRIENDBOT_URL ?? "https://friendbot.stellar.org";
export const TESTNET_EXPLORER = "https://stellar.expert/explorer/testnet";

export function testnetServer(url = TESTNET_RPC_URL): rpc.Server {
  return new rpc.Server(url, { allowHttp: url.startsWith("http://") });
}

/** Creates and funds a testnet account with friendbot (10,000 test XLM). Already-funded is fine. */
export async function friendbot(address: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`);
    if (res.ok) return;
    const body = await res.text();
    if (/already exist|createAccountAlreadyExist|op_already_exists/i.test(body)) return;
    if (attempt >= 3) throw new Error(`friendbot failed for ${address}: HTTP ${res.status} ${body.slice(0, 200)}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
  }
}

/** Submits a signed transaction and waits until it is final. Throws unless it succeeded. */
export async function submitAndWait(server: rpc.Server, tx: Transaction): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") {
    throw new Error(`submission ${sent.status}: ${sent.errorResult?.result().switch().name ?? "no result"}`);
  }
  const final = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`transaction ${sent.hash} ${final.status}`);
  return final as rpc.Api.GetSuccessfulTransactionResponse;
}

export interface TestAsset {
  asset: Asset;
  /** The asset's Stellar Asset Contract (C…): what x402 requirements name as `asset`. */
  contractId: string;
}

/**
 * Issues a fresh classic asset from `issuer`, opens trustlines for `holders`, mints `mint` to the
 * first holder and deploys the asset's SAC. 7 decimals, like every Stellar Asset Contract.
 */
export async function createTestAsset(
  server: rpc.Server,
  issuer: Keypair,
  holders: Keypair[],
  mint: { to: Keypair; units: string },
  code = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
): Promise<TestAsset> {
  const asset = new Asset(code, issuer.publicKey());
  const issuerAccount = await server.getAccount(issuer.publicKey());
  const builder = new TransactionBuilder(issuerAccount, { fee: String(Number(BASE_FEE) * (holders.length + 1)), networkPassphrase: Networks.TESTNET });
  for (const holder of holders) builder.addOperation(Operation.changeTrust({ asset, source: holder.publicKey() }));
  builder.addOperation(Operation.payment({ destination: mint.to.publicKey(), asset, amount: mint.units }));
  const classic = builder.setTimeout(60).build();
  classic.sign(issuer, ...holders);
  await submitAndWait(server, classic);

  const deploy = new TransactionBuilder(await server.getAccount(issuer.publicKey()), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(deploy);
  prepared.sign(issuer);
  await submitAndWait(server, prepared);
  return { asset, contractId: asset.contractId(Networks.TESTNET) };
}

/** Balance of a classic asset (trustline for G…, SAC balance for C…), in atomic units (7 decimals). */
export async function assetBalance(server: rpc.Server, address: string, asset: Asset): Promise<bigint> {
  if (asset.isNative() && address.startsWith("G")) return xlmBalance(server, address);
  const res = await server.getAssetBalance(address, asset, Networks.TESTNET);
  return res.balanceEntry ? BigInt(res.balanceEntry.amount) : 0n;
}

/** Native XLM balance of a G… account, in stroops. */
export async function xlmBalance(server: rpc.Server, address: string): Promise<bigint> {
  return BigInt((await server.getAccountEntry(address)).balance().toString());
}
