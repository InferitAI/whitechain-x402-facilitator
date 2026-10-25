// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Facilitator-level reason codes. They travel in `invalidReason` (verify) and `errorReason`
 * (settle) next to the scheme-level codes emitted by @x402/evm (e.g.
 * `invalid_exact_evm_payload_authorization_valid_before`, `invalid_exact_evm_nonce_already_used`).
 * Stable strings: merchants may branch on them.
 */
export const Reasons = {
  /** Body failed schema validation or x402Version is not supported. */
  invalidRequest: "invalid_request",
  /** No scheme registered for (x402Version, scheme, network). */
  unsupportedSchemeNetwork: "unsupported_scheme_network",
  /** Network is configured but asset is not on the network's allowlist. */
  unsupportedAsset: "unsupported_asset",
  /** Payer or payTo address is on the sanctions denylist. */
  addressDenylisted: "address_denylisted",
  /** Per-IP, per-API-key, per-payer or per-payTo rate limit exceeded (HTTP 429). */
  rateLimited: "rate_limit_exceeded",
  /** Daily gas budget (global or per payTo; on Stellar the network-fee budget) exhausted; resets at 00:00 UTC (HTTP 429). */
  gasBudgetExceeded: "gas_budget_exceeded",
  /** Estimated settlement gas is above MAX_SETTLE_GAS; the facilitator will not sponsor it. */
  settleGasCapExceeded: "settle_gas_cap_exceeded",
  /** Same authorization is being settled right now or was settled recently by this facilitator. */
  duplicateSettlement: "duplicate_settlement",
  /** X-API-Key header missing (when required) or unknown (HTTP 401). */
  invalidApiKey: "invalid_api_key",
  /** The facilitator signer has no gas (on Stellar: no spendable XLM for fees) left on this network (HTTP 503). */
  facilitatorOutOfGas: "facilitator_out_of_gas",
  /** The network's RPC did not answer, so nothing could be checked or broadcast (HTTP 503, Retry-After). */
  rpcUnavailable: "rpc_unavailable",
  /** Every Stellar fee-payer account is busy with another settlement (HTTP 503, Retry-After). */
  facilitatorBusy: "facilitator_busy",
  /** The fee policy refused to sponsor this payment. */
  feePolicyRejected: "fee_policy_rejected",
  /** Unexpected exception during verification. */
  unexpectedVerifyError: "unexpected_verify_error",
  /** Unexpected exception during settlement. */
  unexpectedSettleError: "unexpected_settle_error",
} as const;

export type ReasonCode = (typeof Reasons)[keyof typeof Reasons];

/**
 * A policy decision that stops a request before the scheme implementation runs. `status` is the
 * HTTP status the handler responds with; the body always keeps the x402 wire shape so the official
 * HTTPFacilitatorClient surfaces it as a typed VerifyError / SettleError.
 */
export class PolicyError extends Error {
  readonly reason: ReasonCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(reason: ReasonCode, message: string, status = 200, retryAfterSeconds?: number) {
    super(message);
    this.name = "PolicyError";
    this.reason = reason;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Thrown by the signer wrapper when a simulated settlement would exceed the per-tx gas cap. */
export class SettleGasCapError extends Error {
  readonly estimated: bigint;
  readonly cap: bigint;

  constructor(estimated: bigint, cap: bigint) {
    super(`${Reasons.settleGasCapExceeded}: settlement needs ${estimated} gas, facilitator cap is ${cap}`);
    this.name = "SettleGasCapError";
    this.estimated = estimated;
    this.cap = cap;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;
const DEFAULT_PUBLIC_MESSAGE_LENGTH = 240;

/**
 * Error text that may be sent to a caller or shown on /health. viem's errors embed the RPC URL
 * (which often carries a provider API key in its path) and multi-line request dumps, so URLs are
 * replaced with `[url]`, whitespace is collapsed and the result is bounded in length. Operator logs
 * keep the full `errorMessage()`.
 */
export function publicErrorMessage(error: unknown, maxLength = DEFAULT_PUBLIC_MESSAGE_LENGTH): string {
  const collapsed = errorMessage(error).replace(URL_PATTERN, "[url]").replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

/** Error text for the operator log: full detail, but URLs (RPC keys) still redacted. */
export function loggableErrorMessage(error: unknown): string {
  return publicErrorMessage(error, 4_000);
}
