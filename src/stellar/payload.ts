// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { Address, Transaction, scValToNative, xdr } from "@stellar/stellar-sdk";
import { isStellarAddress, isStellarContractId } from "../address.js";

/**
 * What a Stellar `exact` payload commits to, decoded the same way @x402/stellar's facilitator
 * reads it, so the policy layer (rate limits, sanctions screening, replay protection) looks at
 * the same payer the SDK will settle for.
 *
 * The payload is `{ transaction: <base64 TransactionEnvelope XDR> }`: one InvokeHostFunction
 * operation calling `transfer(from, to, amount)` on the asset contract, with the payer's signed
 * Soroban authorization entry. The facilitator rebuilds the transaction with its own account as
 * source and fee payer; the payer only signs the authorization entry.
 */
export interface StellarPayment {
  /** Asset contract (C…) the transfer is invoked on. */
  contract: string;
  /** `transfer` argument 0: the payer (G… or C…). Unverified until the SDK checks the signature. */
  from: string;
  /** `transfer` argument 1: the recipient. */
  to: string;
  /** `transfer` argument 2, in the token's atomic units (7 decimals for Stellar Asset Contracts). */
  amount: bigint;
  /** Nonces of the payer's address-credential auth entries (Soroban's replay protection). */
  nonces: string[];
  /**
   * Latest signatureExpirationLedger among the payer's auth entries: after this ledger the
   * authorization can no longer be used on-chain, so a broadcast that has not landed by then
   * never will.
   */
  expirationLedger: number | undefined;
}

/** Upper bound on the base64 envelope we will try to decode (a transfer with one auth entry is ~1.5 KB). */
export const MAX_STELLAR_TRANSACTION_LENGTH = 16_384;

function addressCredentials(credentials: xdr.SorobanCredentials): xdr.SorobanAddressCredentials | undefined {
  const type = credentials.switch();
  if (type === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return credentials.address();
  // CAP-71 V2 credentials (accepted from Protocol 28) wrap the same structure; same rule as the SDK.
  if (type === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()) return credentials.addressV2();
  return undefined;
}

/**
 * Decodes a Stellar `exact` payload. Returns undefined for anything that is not a single
 * `transfer` invocation with three arguments; the SDK rejects those payloads itself, before any
 * broadcast, so they need no screening.
 */
export function decodeStellarPayment(
  payload: Record<string, unknown> | undefined,
  networkPassphrase: string,
): StellarPayment | undefined {
  const encoded = payload?.["transaction"];
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_STELLAR_TRANSACTION_LENGTH) return undefined;
  try {
    const tx = new Transaction(encoded, networkPassphrase);
    if (tx.operations.length !== 1) return undefined;
    const op = tx.operations[0];
    if (!op || op.type !== "invokeHostFunction") return undefined;
    const func = op.func;
    if (!func || func.switch().name !== "hostFunctionTypeInvokeContract") return undefined;
    const invoke = func.invokeContract();
    const contract = Address.fromScAddress(invoke.contractAddress()).toString();
    if (invoke.functionName().toString() !== "transfer") return undefined;
    const args = invoke.args();
    if (args.length !== 3) return undefined;
    const from: unknown = scValToNative(args[0]!);
    const to: unknown = scValToNative(args[1]!);
    const amount: unknown = scValToNative(args[2]!);
    if (typeof from !== "string" || typeof to !== "string" || typeof amount !== "bigint") return undefined;
    if (!isStellarContractId(contract) || !isStellarAddress(from) || !isStellarAddress(to)) return undefined;

    const nonces: string[] = [];
    let expirationLedger: number | undefined;
    for (const entry of op.auth ?? []) {
      const creds = addressCredentials(entry.credentials());
      if (!creds) continue;
      if (Address.fromScAddress(creds.address()).toString() !== from) continue;
      nonces.push(creds.nonce().toString());
      const exp = creds.signatureExpirationLedger();
      expirationLedger = expirationLedger === undefined ? exp : Math.max(expirationLedger, exp);
    }
    return { contract, from, to, amount, nonces: nonces.sort(), expirationLedger };
  } catch {
    return undefined;
  }
}

/**
 * Dedupe key for a Stellar authorization. Soroban nonces are scoped to the authorizing address
 * (not to the token), so `network|from|nonce` identifies one on-chain authorization. Undefined
 * when the payer has no address-credential entry (the SDK refuses such payloads).
 */
export function stellarAuthorizationKey(network: string, payment: StellarPayment | undefined): string | undefined {
  if (!payment || payment.nonces.length === 0) return undefined;
  return `${network}|${payment.from}|${payment.nonces.join(",")}`;
}
