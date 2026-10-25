// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, statSync } from "node:fs";
import { addressKey, isStellarAddress } from "../address.js";

/**
 * Sanctions screening hook: a file with one address per line (`#` comments allowed), checked
 * against the payer and the payTo of every verify/settle. EVM addresses (0x…) match
 * case-insensitively; Stellar addresses (G…, C…, M…) are case-sensitive strkeys and match
 * exactly. The file is re-read when its mtime changes (polled every `reloadSeconds`).
 *
 * Source the addresses from the OFAC SDN list ("Digital Currency Address - ETH" etc.);
 * `scripts/fetch-ofac-denylist.ts` does that. Any other screening provider can be plugged in by
 * implementing `AddressScreener`.
 */
export interface AddressScreener {
  isDenied(address: string): boolean;
  size(): number;
}

const STELLAR_STRKEY = /\b[GCM][A-Z2-7]{55}(?:[A-Z2-7]{13})?\b/;

export function parseDenylist(text: string): Set<string> {
  const out = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = /0x[0-9a-fA-F]{40}/.exec(line);
    if (match) {
      out.add(match[0].toLowerCase());
      continue;
    }
    const stellar = STELLAR_STRKEY.exec(line);
    if (stellar && isStellarAddress(stellar[0])) out.add(stellar[0]);
  }
  return out;
}

export class FileDenylist implements AddressScreener {
  private addresses = new Set<string>();
  private lastMtimeMs = -1;
  private lastCheckedAt = 0;
  private readonly path: string;
  private readonly reloadMs: number;
  private readonly onReload: ((count: number) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;

  constructor(
    path: string,
    opts: { reloadSeconds?: number; onReload?: (count: number) => void; onError?: (error: unknown) => void } = {},
  ) {
    this.path = path;
    this.reloadMs = (opts.reloadSeconds ?? 300) * 1000;
    this.onReload = opts.onReload;
    this.onError = opts.onError;
    this.reload(true);
  }

  isDenied(address: string): boolean {
    this.maybeReload();
    return this.addresses.has(addressKey(address));
  }

  size(): number {
    return this.addresses.size;
  }

  /** Force a re-read (e.g. on SIGHUP). Returns the number of loaded addresses. */
  reload(initial = false): number {
    try {
      const stat = statSync(this.path, { throwIfNoEntry: false });
      if (!stat) {
        if (initial || this.lastMtimeMs !== -1) {
          this.addresses = new Set();
          this.lastMtimeMs = -1;
          this.onReload?.(0);
        }
        return 0;
      }
      if (stat.mtimeMs === this.lastMtimeMs) return this.addresses.size;
      this.addresses = parseDenylist(readFileSync(this.path, "utf8"));
      this.lastMtimeMs = stat.mtimeMs;
      this.onReload?.(this.addresses.size);
      return this.addresses.size;
    } catch (error) {
      this.onError?.(error);
      return this.addresses.size;
    } finally {
      this.lastCheckedAt = Date.now();
    }
  }

  private maybeReload(): void {
    if (this.reloadMs <= 0) return;
    if (Date.now() - this.lastCheckedAt < this.reloadMs) return;
    this.reload();
  }
}

export class StaticDenylist implements AddressScreener {
  private readonly addresses: Set<string>;
  constructor(addresses: Iterable<string>) {
    this.addresses = new Set([...addresses].map(addressKey));
  }
  isDenied(address: string): boolean {
    return this.addresses.has(addressKey(address));
  }
  size(): number {
    return this.addresses.size;
  }
}
