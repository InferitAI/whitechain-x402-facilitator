// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, statSync } from "node:fs";
import type { FacilitatorConfig } from "./config.js";

/**
 * GET / serves `site/landing.html` (written by the docs build) when it exists, otherwise this
 * small built-in page. The file is re-read when its mtime changes, so a redeploy of the docs
 * does not need a restart.
 */
export class LandingPage {
  private cache: { mtimeMs: number; html: string } | undefined;
  private readonly path: string;
  private readonly fallback: string;

  constructor(config: FacilitatorConfig, facilitatorAddress: string) {
    this.path = config.landingFile;
    this.fallback = renderFallback(config, facilitatorAddress);
  }

  html(): string {
    try {
      const stat = statSync(this.path, { throwIfNoEntry: false });
      if (!stat) return this.fallback;
      if (!this.cache || this.cache.mtimeMs !== stat.mtimeMs) {
        this.cache = { mtimeMs: stat.mtimeMs, html: readFileSync(this.path, "utf8") };
      }
      return this.cache.html;
    } catch {
      return this.fallback;
    }
  }

  get servesFile(): boolean {
    try {
      return !!statSync(this.path, { throwIfNoEntry: false });
    } catch {
      return false;
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function renderFallback(config: FacilitatorConfig, facilitatorAddress: string): string {
  const networks = config.networks
    .map(
      (n) =>
        `<li><code>${escapeHtml(n.id)}</code> — ${escapeHtml(n.name)}${
          n.explorerUrl ? ` · <a href="${escapeHtml(n.explorerUrl)}/address/${escapeHtml(facilitatorAddress)}">facilitator wallet</a>` : ""
        }</li>`,
    )
    .concat(
      (config.stellar?.networks ?? []).map(
        (n) => `<li><code>${escapeHtml(n.id)}</code> — ${escapeHtml(n.name)} · fee-payer account(s) listed in <code>GET /supported</code></li>`,
      ),
    )
    .join("\n");
  const docs = escapeHtml(config.docsUrl);
  const repo = escapeHtml(config.repoUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Whitechain x402 Facilitator</title>
<meta name="description" content="Open-source x402 facilitator for Whitechain: verify and settle gasless EIP-3009 and Permit2 payments.">
<style>
:root{color-scheme:light dark;--fg:#111;--bg:#fff;--muted:#555;--line:#ddd;--accent:#0b5fff}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#101214;--muted:#9aa;--line:#2a2f35;--accent:#6ea8ff}}
body{margin:0;padding:32px 16px;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:720px;margin:0 auto}
h1{font-size:28px;margin:0 0 8px}p{margin:8px 0}a{color:var(--accent)}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(127,127,127,.12);padding:2px 5px;border-radius:4px}
ul{padding-left:20px}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.muted{color:var(--muted)}
</style>
</head>
<body><main>
<h1>Whitechain x402 Facilitator</h1>
<p>An open-source <a href="https://x402.org">x402</a> v2 facilitator for Whitechain. Point any standard x402 resource server at this URL and accept gasless token payments; funds move payer → merchant directly, the facilitator only submits the signed authorization and pays the gas.</p>
<p><a href="${docs}">Documentation</a> · <a href="${repo}">Source (Apache-2.0)</a></p>
<table>
<tr><th>Endpoint</th><th>Purpose</th></tr>
<tr><td><code>GET /supported</code></td><td>Schemes, networks and signer addresses</td></tr>
<tr><td><code>POST /verify</code></td><td>Verify a payment payload against requirements</td></tr>
<tr><td><code>POST /settle</code></td><td>Settle a verified payment on-chain</td></tr>
<tr><td><code>GET /health</code></td><td>Signer gas balance and settle runway per network</td></tr>
<tr><td><code>GET /metrics</code></td><td>Verify/settle counters, failures, gas spent</td></tr>
</table>
<p>Networks:</p>
<ul>
${networks}
</ul>
<p class="muted">Facilitator signer: <code>${escapeHtml(facilitatorAddress)}</code></p>
</main></body>
</html>
`;
}
