// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { rpc } from "@stellar/stellar-sdk";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { installConsoleRedaction, redactConsoleText } from "../../src/console.js";

describe("console redaction (SDK diagnostics)", () => {
  it("cuts every URL to its scheme and host", () => {
    expect(redactConsoleText("failed at https://rpc.provider.example/v1/PROVIDERKEY123?x=1 then http://10.0.0.1:8000/k/abc")).toBe(
      "failed at https://rpc.provider.example/… then http://10.0.0.1:8000/…",
    );
  });

  it("keeps a keyed Soroban RPC URL out of what @x402/stellar prints with console.error", async () => {
    // A provider that answers 503 (rate limiting): the SDK's error object carries response.config.url.
    const server = createServer((_req, res) => {
      res.writeHead(503);
      res.end("busy");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    let error: unknown;
    try {
      await new rpc.Server(`http://127.0.0.1:${port}/v1/PROVIDERKEY123`, { allowHttp: true }).getHealth();
    } catch (e) {
      error = e;
    } finally {
      server.close();
    }
    expect(error).toBeDefined();
    const written: string[] = [];
    const sink = { error: (...a: unknown[]) => written.push(a.join(" ")), warn: (...a: unknown[]) => written.push(a.join(" ")), info: () => undefined, log: () => undefined, debug: () => undefined };
    const restore = installConsoleRedaction(sink);
    sink.error("Unexpected verification error:", error);
    sink.warn("Poll attempt 0 failed:", error);
    restore();
    expect(written).toHaveLength(2);
    expect(written.join("\n")).toContain("Unexpected verification error:");
    expect(written.join("\n")).toContain(`http://127.0.0.1:${port}/…`);
    expect(written.join("\n")).not.toContain("PROVIDERKEY123");
    // Restored: the original methods are back.
    sink.error("after https://x.example/KEY");
    expect(written[2]).toBe("after https://x.example/KEY");
  });
});
