// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { isStellarAddress, isStellarContractId, isStellarNetworkId } from "./address.js";
import { MAX_STELLAR_TRANSACTION_LENGTH } from "./stellar/payload.js";

/**
 * Wire schema for POST /verify and POST /settle, as sent by @x402/core's HTTPFacilitatorClient:
 * `{ x402Version, paymentPayload, paymentRequirements }`. `extra` stays open (scheme-specific).
 *
 * The scheme payload is checked just enough to (a) refuse shapes the @x402/evm scheme would
 * crash on (so a malformed body is a 400, never a 500) and (b) make the payload type
 * unambiguous: exactly one of `authorization` (EIP-3009) or `permit2Authorization` (Permit2),
 * because the SDK routes on the presence of `permit2Authorization` and the facilitator's
 * screening must look at the same payer the SDK will settle for.
 */
const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x-prefixed 20-byte address");
const digits = z.string().regex(/^\d+$/, "expected an integer string");
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte hex value");
const hexBytes = z.string().regex(/^0x[0-9a-fA-F]*$/, "expected 0x-prefixed hex");

export const PaymentRequirementsSchema = z.object({
  scheme: z.string().min(1).max(64),
  network: z.string().regex(/^[a-z0-9-]{3,8}:[a-zA-Z0-9-_]{1,64}$/, "expected a CAIP-2 network id"),
  asset: hexAddress,
  amount: z.string().regex(/^\d+$/, "amount must be an integer string in atomic units"),
  payTo: hexAddress,
  maxTimeoutSeconds: z.number().int().nonnegative(),
  extra: z.record(z.string(), z.unknown()).default({}),
});

/** EIP-3009 `TransferWithAuthorization` fields, as @x402/evm's ExactEvmPayload carries them. */
export const Eip3009AuthorizationSchema = z
  .object({
    from: hexAddress,
    to: hexAddress,
    value: digits,
    validAfter: digits,
    validBefore: digits,
    nonce: bytes32,
  })
  .passthrough();

/** Permit2 `PermitWitnessTransferFrom` fields shared by the `exact` and `upto` payloads. */
export const Permit2AuthorizationSchema = z
  .object({
    from: hexAddress,
    spender: hexAddress,
    nonce: z.string().regex(/^(\d+|0x[0-9a-fA-F]+)$/, "expected a uint256 nonce"),
    deadline: digits,
    permitted: z.object({ token: hexAddress, amount: digits }).passthrough(),
    witness: z.object({ to: hexAddress, validAfter: digits }).passthrough(),
  })
  .passthrough();

export const SchemePayloadSchema = z
  .object({ signature: hexBytes })
  .passthrough()
  .superRefine((payload, ctx) => {
    const hasAuthorization = "authorization" in payload;
    const hasPermit2 = "permit2Authorization" in payload;
    if (hasAuthorization === hasPermit2) {
      ctx.addIssue({
        code: "custom",
        message: hasAuthorization
          ? "payload must carry either authorization (EIP-3009) or permit2Authorization (Permit2), not both"
          : "payload must carry an authorization (EIP-3009) or a permit2Authorization (Permit2)",
      });
      return;
    }
    const field = hasAuthorization ? "authorization" : "permit2Authorization";
    const inner = (hasAuthorization ? Eip3009AuthorizationSchema : Permit2AuthorizationSchema).safeParse(payload[field]);
    if (!inner.success) {
      for (const issue of inner.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: [field, ...issue.path.map(String)] });
      }
    }
  });

export const PaymentPayloadSchema = z.object({
  x402Version: z.number().int(),
  resource: z
    .object({ url: z.string(), description: z.string().optional(), mimeType: z.string().optional() })
    .passthrough()
    .optional(),
  accepted: PaymentRequirementsSchema,
  payload: SchemePayloadSchema,
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export const FacilitatorRequestSchema = z.object({
  x402Version: z.number().int(),
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});

// --------------------------------------------------------------------------- Stellar

/**
 * Stellar (`stellar:*` networks): `asset` is the token contract (C…), `payTo` a G…/C…/M…
 * address, both case-sensitive strkeys. The scheme payload is `{ transaction }`, a base64
 * TransactionEnvelope whose single operation invokes `transfer` with the payer's signed auth
 * entry (see src/stellar/payload.ts).
 */
const stellarAsset = z.string().refine(isStellarContractId, "expected a Stellar contract address (C…)");
const stellarDestination = z.string().refine(isStellarAddress, "expected a Stellar address (G…, C… or M…)");

export const StellarPaymentRequirementsSchema = PaymentRequirementsSchema.extend({
  asset: stellarAsset,
  payTo: stellarDestination,
});

export const StellarSchemePayloadSchema = z
  .object({
    transaction: z
      .string()
      .min(1)
      .max(MAX_STELLAR_TRANSACTION_LENGTH, `transaction must be at most ${MAX_STELLAR_TRANSACTION_LENGTH} characters`)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, "transaction must be base64 XDR"),
  })
  .passthrough();

export const StellarPaymentPayloadSchema = PaymentPayloadSchema.extend({
  accepted: StellarPaymentRequirementsSchema,
  payload: StellarSchemePayloadSchema,
});

export const StellarFacilitatorRequestSchema = z.object({
  x402Version: z.number().int(),
  paymentPayload: StellarPaymentPayloadSchema,
  paymentRequirements: StellarPaymentRequirementsSchema,
});

/** The requirements' network decides which wire schema applies (EVM unless it is `stellar:*`). */
function isStellarRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const reqs = (body as Record<string, unknown>)["paymentRequirements"];
  if (!reqs || typeof reqs !== "object") return false;
  const network = (reqs as Record<string, unknown>)["network"];
  return typeof network === "string" && isStellarNetworkId(network);
}

export interface ParsedFacilitatorRequest {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export function parseFacilitatorRequest(body: unknown): { ok: true; value: ParsedFacilitatorRequest } | { ok: false; message: string } {
  const parsed = (isStellarRequest(body) ? StellarFacilitatorRequestSchema : FacilitatorRequestSchema).safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, message: issues };
  }
  const v = parsed.data;
  return {
    ok: true,
    value: {
      x402Version: v.x402Version,
      paymentPayload: v.paymentPayload as unknown as PaymentPayload,
      paymentRequirements: v.paymentRequirements as PaymentRequirements,
    },
  };
}
