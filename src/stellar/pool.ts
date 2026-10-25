// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Stellar transactions carry the source account's next sequence number, and the RPC reports
 * the sequence of the last *closed* ledger. Two settlements built from the same fee-payer
 * account inside one ledger (~5 s) would therefore reuse a sequence number and one of them
 * would be rejected. The pool hands each settlement an exclusive fee-payer account for the
 * whole build → submit → confirm cycle; with N keys up to N settlements run at once, the rest
 * wait in FIFO order (bounded queue, bounded wait).
 */
export interface SignerLease {
  readonly address: string;
  release(): void;
}

interface Waiter {
  resolve(lease: SignerLease | undefined): void;
  timer: NodeJS.Timeout;
}

export class SignerPool {
  private readonly idle: string[];
  private readonly waiters: Waiter[] = [];
  private readonly maxWaiters: number;
  readonly addresses: readonly string[];

  constructor(addresses: string[], opts: { maxWaiters?: number } = {}) {
    if (addresses.length === 0) throw new Error("signer pool needs at least one address");
    this.addresses = [...addresses];
    this.idle = [...addresses];
    this.maxWaiters = opts.maxWaiters ?? 256;
  }

  /** Resolves with an exclusive lease, or undefined when the queue is full or `timeoutMs` passes. */
  acquire(timeoutMs: number): Promise<SignerLease | undefined> {
    const address = this.idle.shift();
    if (address !== undefined) return Promise.resolve(this.lease(address));
    if (this.waiters.length >= this.maxWaiters || timeoutMs <= 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(undefined);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  get idleCount(): number {
    return this.idle.length;
  }

  get busyCount(): number {
    return this.addresses.length - this.idle.length;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  private lease(address: string): SignerLease {
    let released = false;
    return {
      address,
      release: () => {
        if (released) return;
        released = true;
        const next = this.waiters.shift();
        if (next) {
          clearTimeout(next.timer);
          next.resolve(this.lease(address));
        } else {
          this.idle.push(address);
        }
      },
    };
  }
}

/**
 * Carries the leased fee-payer address into @x402/stellar's `selectSigner` callback, which the
 * SDK calls synchronously inside `settle()` (same async context), and brings back the hash of the
 * transaction the fee payer signed (set by the signer, see StellarChain).
 */
export const stellarSignerContext = new AsyncLocalStorage<{ address: string; signedHash?: string }>();

/** `selectSigner` for ExactStellarScheme: the leased account, never a round-robin guess. */
export function selectLeasedSigner(addresses: readonly string[]): string {
  const leased = stellarSignerContext.getStore()?.address;
  if (!leased || !addresses.includes(leased)) {
    // Throwing inside settle() makes the SDK return unexpected_settle_error before it builds or
    // submits anything, which is the safe outcome for a settlement that holds no lease.
    throw new Error("no Stellar fee-payer account is leased for this settlement");
  }
  return leased;
}
