# Contributing

Thanks for helping make x402 payments on Whitechain better. This page covers setup, the checks that run in CI, and what kinds of changes fit where.

## Setup

Requirements: Node 22, npm, and [Foundry](https://getfoundry.sh) (`anvil` for the interop tests; `forge` only if you change the Solidity fixtures).

```sh
git clone https://github.com/InferitAI/whitechain-x402-facilitator
cd whitechain-x402-facilitator
npm ci
cp .env.example .env     # any 0x-prefixed 32-byte key works for local runs; anvil's dev keys are fine
npm run dev              # facilitator on http://localhost:8402 (Whitechain Sepolia by default)
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` with strict settings. |
| `npm test` | Unit tests plus interop tests that spin up `anvil` on an ephemeral port, deploy an EIP-3009 test token and drive the facilitator with the official `@x402/express` and `@x402/fetch` packages. |
| `npm run test:unit` / `npm run test:interop` | Either half on its own. |
| `npm run build` | Compiles to `dist/`. |
| `npm run build:fixtures` | Recompiles the Solidity test fixtures with `forge` (only when `test/fixtures/contracts/*.sol` change). |
| `npm run permit2:check` | Reports whether the x402 Permit2 proxies exist on the configured networks and whether their canonical addresses are reproducible. Read-only. |
| `npm run denylist:ofac` | Rebuilds `denylist.txt` from the public OFAC SDN list. |
| `npm run smoke:sepolia` | Runs a real verify and settle on Whitechain Sepolia (needs a funded signer and a payer with ITC). |

The examples are standalone npm projects: `cd examples/<name> && npm ci && npm run typecheck`.

The site is plain HTML: `cd site && node build.mjs` produces `site/dist/`.

## Pull requests

1. Open an issue first for anything beyond a small fix, so the design can be agreed before the work.
2. Branch from `main`. Keep PRs focused; unrelated refactors go in their own PR.
3. Make sure `npm run typecheck`, `npm test` and `npm run build` pass, and that the examples still typecheck if you touched the SDK versions.
4. Update the docs that describe the behaviour you changed: `README.md`, `docs/`, and `site/docs.html` (they intentionally repeat each other so each is complete on its own).
5. Add a line under "Unreleased" in `CHANGELOG.md` for user-visible changes.
6. Fill in the PR template, including how you tested. A transaction hash on Whitechain Sepolia is the best evidence for settlement changes.

CI runs the same checks on Node 22 with Foundry installed, builds the Docker image and the site.

## Code conventions

- TypeScript strict, ESM, Node 22 APIs. No new runtime dependencies without a reason in the PR.
- Reuse the official `@x402/core` and `@x402/evm` implementations for protocol behaviour; this project adds policy and operations around them, not a second implementation of EIP-3009 verification.
- Never log signatures, keys or whole request bodies. Add new sensitive paths to `REDACT_PATHS` in `src/logger.ts`.
- Tests bind to ephemeral ports (`0`); never hard-code 8545, 8787, 3100, 9101-9103 or 9200.
- Every refusal must keep the x402 wire shape (`isValid: false` / `success: false` with a stable reason code from `src/errors.ts`) so the official client raises a typed error.
- Anything a stranger could abuse (gas, rate limits, screening, secrets in responses or logs) gets a regression test in `test/interop/hardening.test.ts` or `test/unit/hardening.test.ts`, and a line in `VERIFICATION.md`.
- Error text that can reach a caller or the log goes through `publicErrorMessage()` / `loggableErrorMessage()` (URLs removed, length bounded).
- Keep public claims accurate: this is an independent project, not an official Whitechain or WhiteBIT product.

## Reporting bugs and requesting features

Use the issue templates. Security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Licence

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), as stated in section 5 of the licence. There is no separate CLA.
