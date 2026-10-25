// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { describeConfig, loadConfig } from "./config.js";
import { installConsoleRedaction } from "./console.js";
import { FacilitatorService } from "./facilitator.js";
import { createLogger } from "./logger.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  // SDK diagnostics written with console.* carry raw errors (RPC URLs, provider keys included).
  installConsoleRedaction();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info(describeConfig(config), "starting whitechain-x402-facilitator");

  const service = new FacilitatorService(config, logger);
  logger.info({ facilitator: service.address }, "facilitator signer loaded (fund this address with gas)");
  for (const [network, feePayers] of Object.entries(service.stellarSigners())) {
    logger.info({ network, feePayers }, "Stellar fee-payer account(s) loaded (fund with XLM; on testnet: https://friendbot.stellar.org/?addr=<address>)");
  }
  const { app } = buildServer(config, logger, service);

  await service.start();
  await app.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port, publicUrl: config.publicUrl }, "listening");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    service.stop();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => {
    const denylist = service.denylist as { reload?: () => number };
    if (typeof denylist.reload === "function") {
      const count = denylist.reload();
      logger.info({ count }, "denylist reloaded on SIGHUP");
    }
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Startup errors are the one place a plain console line is clearer than a JSON log.
  console.error(`whitechain-x402-facilitator failed to start: ${message}`);
  process.exit(1);
});
