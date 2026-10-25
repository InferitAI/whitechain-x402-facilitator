// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { inspect } from "node:util";
import { redactUrl } from "./config.js";

const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;
const LEVELS = ["error", "warn", "info", "log", "debug"] as const;

/** `text` with every URL cut to its scheme and host (redactUrl): an RPC provider key in a path or query never shows. */
export function redactConsoleText(text: string): string {
  return text.replace(URL_PATTERN, (url) => redactUrl(url));
}

/**
 * Filters console output through redactConsoleText. The structured log (pino) redacts on its own,
 * but @x402/stellar writes its diagnostics with console.error / console.warn, passing the raw
 * error, whose response.config.url is the full RPC URL (a provider key in its path included).
 * Every argument is rendered (util.inspect for non-strings) and redacted before it is written.
 * Returns a function that restores the original methods.
 */
export function installConsoleRedaction(target: Pick<Console, (typeof LEVELS)[number]> = console): () => void {
  const originals = LEVELS.map((level) => [level, target[level]] as const);
  for (const [level, original] of originals) {
    target[level] = (...args: unknown[]) =>
      original.apply(
        target,
        args.map((a) => redactConsoleText(typeof a === "string" ? a : inspect(a, { depth: 4, breakLength: 160 }))),
      );
  }
  return () => {
    for (const [level, original] of originals) target[level] = original;
  };
}
