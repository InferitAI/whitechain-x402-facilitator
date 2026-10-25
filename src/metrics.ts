// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { addressKey } from "./address.js";

/**
 * Process-local counters exposed as JSON on GET /metrics. Reasons are bucketed so merchants and
 * operators can see *why* payments fail without the facilitator logging payloads.
 */
export class Metrics {
  readonly startedAt = new Date();
  private readonly counters = new Map<string, number>();
  private readonly reasons = new Map<string, Map<string, number>>();
  private readonly gasWei = new Map<string, bigint>();
  private readonly settledAmounts = new Map<string, bigint>();
  private readonly networkFees = new Map<string, bigint>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  reason(bucket: string, reason: string | undefined): void {
    const r = reason ?? "unknown";
    let map = this.reasons.get(bucket);
    if (!map) {
      map = new Map();
      this.reasons.set(bucket, map);
    }
    map.set(r, (map.get(r) ?? 0) + 1);
  }

  addGas(network: string, wei: bigint): void {
    this.gasWei.set(network, (this.gasWei.get(network) ?? 0n) + wei);
    this.gasWei.set("total", (this.gasWei.get("total") ?? 0n) + wei);
  }

  addSettledAmount(network: string, asset: string, amount: bigint): void {
    const key = `${network}|${addressKey(asset)}`;
    this.settledAmounts.set(key, (this.settledAmounts.get(key) ?? 0n) + amount);
  }

  /** Network fees paid on a non-EVM network (Stellar: stroops). Kept apart from `gasWei`, whose total is in wei. */
  addNetworkFee(network: string, amount: bigint): void {
    // Negative amounts correct an earlier worst-case charge; the total never goes below zero.
    const next = (this.networkFees.get(network) ?? 0n) + amount;
    this.networkFees.set(network, next < 0n ? 0n : next);
  }

  networkFeesSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.networkFees) out[k] = v.toString();
    return out;
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): Record<string, unknown> {
    const reasons: Record<string, Record<string, number>> = {};
    for (const [bucket, map] of this.reasons) reasons[bucket] = Object.fromEntries(map);
    const gas: Record<string, string> = {};
    for (const [k, v] of this.gasWei) gas[k] = v.toString();
    const settledAmounts: Record<string, string> = {};
    for (const [k, v] of this.settledAmounts) settledAmounts[k] = v.toString();
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      verify: {
        total: this.get("verify.total"),
        valid: this.get("verify.valid"),
        invalid: this.get("verify.invalid"),
        errors: this.get("verify.error"),
        byReason: reasons["verify"] ?? {},
      },
      settle: {
        total: this.get("settle.total"),
        success: this.get("settle.success"),
        failed: this.get("settle.failed"),
        pending: this.get("settle.pending"),
        errors: this.get("settle.error"),
        byReason: reasons["settle"] ?? {},
        settledAmountAtomic: settledAmounts,
      },
      policy: {
        rateLimited: this.get("policy.rate_limited"),
        denylisted: this.get("policy.denylisted"),
        gasBudgetExceeded: this.get("policy.gas_budget_exceeded"),
        gasCapExceeded: this.get("policy.gas_cap_exceeded"),
        duplicate: this.get("policy.duplicate"),
        unauthorized: this.get("policy.unauthorized"),
        unsupported: this.get("policy.unsupported"),
        invalidRequest: this.get("policy.invalid_request"),
      },
      gas: {
        spentWei: gas,
        txCount: this.get("gas.tx"),
      },
      http: {
        requests: this.get("http.requests"),
        supported: this.get("http.supported"),
      },
    };
  }
}
