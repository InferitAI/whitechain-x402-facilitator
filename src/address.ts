// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { StrKey } from "@stellar/stellar-sdk";

/**
 * Address helpers shared by the EVM and Stellar code paths.
 *
 * EVM addresses are case-insensitive hex (the mixed case is only a checksum), so they are
 * compared lower-cased. Stellar addresses are base32 "strkeys" (G… accounts, C… contracts,
 * M… muxed accounts) with a checksum over the exact characters: they are case-sensitive and
 * are always kept and compared verbatim, never lower-cased.
 */

/** True for a CAIP-2 network id in the `stellar` namespace (e.g. "stellar:testnet"). */
export function isStellarNetworkId(network: string): boolean {
  return network.startsWith("stellar:");
}

/** G… account (ed25519 public key). */
export function isStellarAccountId(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value);
}

/** C… contract address (a Stellar Asset Contract or any Soroban token). */
export function isStellarContractId(value: string): boolean {
  return StrKey.isValidContract(value);
}

/** M… muxed account (a G… account plus a 64-bit id). */
export function isStellarMuxedAccount(value: string): boolean {
  return StrKey.isValidMed25519PublicKey(value);
}

/** Any address a Stellar `exact` payment may name as payer or payTo: G…, C… or M…. */
export function isStellarAddress(value: string): boolean {
  return isStellarAccountId(value) || isStellarContractId(value) || isStellarMuxedAccount(value);
}

/** The G… account behind an M… muxed account (sanctions screening must look at the real owner). */
export function stellarBaseAccount(muxed: string): string {
  const raw = StrKey.decodeMed25519PublicKey(muxed);
  return StrKey.encodeEd25519PublicKey(raw.subarray(0, 32));
}

/**
 * Canonical form for map keys and set membership: EVM hex addresses lower-cased, everything
 * else (Stellar strkeys) unchanged.
 */
export function addressKey(address: string): string {
  return /^0x/i.test(address) ? address.toLowerCase() : address;
}

/**
 * Key for per-account limits and budgets: an M… muxed account counts as the G… account that owns
 * it, so a merchant cannot multiply its per-payTo rate limit or fee budget by varying the mux id.
 */
export function accountKey(address: string): string {
  return isStellarMuxedAccount(address) ? stellarBaseAccount(address) : addressKey(address);
}

/**
 * The addresses to screen for a given address: itself and, for an M… muxed account, the G…
 * account that actually holds the funds.
 */
export function screeningAddresses(address: string): string[] {
  if (isStellarMuxedAccount(address)) return [address, stellarBaseAccount(address)];
  return [address];
}
