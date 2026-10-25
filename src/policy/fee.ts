// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { addressKey } from "../address.js";
import type { FeeMode } from "../config.js";

/**
 * Fee hook. In the `exact` scheme funds move payer -> payTo directly, so a facilitator cannot
 * skim on-chain; what it *can* do is decide whether to sponsor a settlement and account for a
 * fee owed by the merchant (API key) or covered by a sponsor.
 *
 * Default (`FEE_MODE=off`): sponsor everything, record nothing. `FEE_MODE=accrue`: sponsor
 * everything and accrue `FEE_FLAT_ATOMIC + amount * FEE_BPS / 10_000` (in the payment token's
 * atomic units) per successful settlement, grouped by payTo and API key, visible in /metrics.
 * Mainnet operators who bill merchants can read the accruals or replace this hook.
 */
export interface FeeContext {
  network: string;
  asset: string;
  amount: bigint;
  payTo: string;
  payer: string | undefined;
  apiKeyName: string | undefined;
}

export interface FeeQuote {
  /** False refuses the settlement with reason `fee_policy_rejected`. */
  sponsor: boolean;
  /** Fee owed for this settlement, in the payment asset's atomic units (0n when none). */
  feeAtomic: bigint;
  message?: string;
}

export interface FeePolicy {
  readonly mode: FeeMode;
  quote(ctx: FeeContext): FeeQuote;
  /** Called once a settlement succeeded; implementations accrue or bill here. */
  onSettled(ctx: FeeContext, quote: FeeQuote, transaction: string): void;
  snapshot(): Record<string, unknown>;
}

export class NoFeePolicy implements FeePolicy {
  readonly mode: FeeMode = "off";
  quote(): FeeQuote {
    return { sponsor: true, feeAtomic: 0n };
  }
  onSettled(): void {}
  snapshot(): Record<string, unknown> {
    return { mode: this.mode };
  }
}

export class AccruingFeePolicy implements FeePolicy {
  readonly mode: FeeMode = "accrue";
  private readonly bps: bigint;
  private readonly flatAtomic: bigint;
  private readonly accrued = new Map<string, { asset: string; network: string; feeAtomic: bigint; settles: number }>();

  constructor(opts: { bps: number; flatAtomic: bigint }) {
    this.bps = BigInt(opts.bps);
    this.flatAtomic = opts.flatAtomic;
  }

  quote(ctx: FeeContext): FeeQuote {
    const feeAtomic = this.flatAtomic + (ctx.amount * this.bps) / 10_000n;
    return { sponsor: true, feeAtomic };
  }

  onSettled(ctx: FeeContext, quote: FeeQuote): void {
    const owner = ctx.apiKeyName ? `apikey:${ctx.apiKeyName}` : `payto:${addressKey(ctx.payTo)}`;
    const key = `${owner}|${ctx.network}|${addressKey(ctx.asset)}`;
    const entry = this.accrued.get(key) ?? { asset: ctx.asset, network: ctx.network, feeAtomic: 0n, settles: 0 };
    entry.feeAtomic += quote.feeAtomic;
    entry.settles += 1;
    this.accrued.set(key, entry);
  }

  snapshot(): Record<string, unknown> {
    const accrued: Record<string, unknown> = {};
    for (const [key, v] of this.accrued) {
      accrued[key] = { network: v.network, asset: v.asset, feeAtomic: v.feeAtomic.toString(), settles: v.settles };
    }
    return { mode: this.mode, bps: Number(this.bps), flatAtomic: this.flatAtomic.toString(), accrued };
  }
}

export function createFeePolicy(cfg: { mode: FeeMode; bps: number; flatAtomic: bigint }): FeePolicy {
  return cfg.mode === "accrue" ? new AccruingFeePolicy({ bps: cfg.bps, flatAtomic: cfg.flatAtomic }) : new NoFeePolicy();
}
