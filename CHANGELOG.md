# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-04

First public release: the first public x402 v2 facilitator for Whitechain.

### Added

- x402 v2 facilitator HTTP API (`GET /supported`, `POST /verify`, `POST /settle`) compatible with `@x402/core`'s `HTTPFacilitatorClient` 2.28, so `@x402/express`, `@x402/hono`, `@x402/next`, `@x402/fetch` and `@x402/axios` work unmodified.
- `exact` scheme with EIP-3009 `transferWithAuthorization` through the official `@x402/evm` facilitator implementation (EOA, EIP-1271 and ERC-6492 signatures, balance and nonce checks, pre-broadcast simulation).
- Whitechain Sepolia (`eip155:1874`) built in; any other network, including Whitechain mainnet, through the `NETWORKS` JSON setting with id, RPC, explorer and optional asset allowlist.
- Permit2 `exact` and `upto` registered automatically on networks where the x402 Permit2 proxy contracts exist, with `npm run permit2:check` to probe and to verify the canonical deterministic-deployment addresses.
- Testnet policy: token-bucket rate limits per client IP, payer and payTo; daily gas budgets per payTo and global, reserved before broadcast and reconciled with the receipt; per-settlement gas cap; duplicate and replay protection; optional merchant API keys (`X-API-Key`) with higher limits and dedicated budgets.
- Sanctions screening hook: denylist file checked on payer and payee, hot-reloaded, with `npm run denylist:ofac` to build it from the public OFAC SDN list.
- `GET /health` with signer gas balance, settlement runway and budget state per network (`status: "degraded"` on low runway or an unreachable RPC); `GET /metrics` JSON counters (verifies, settles, failures by reason, gas spent, fees).
- Fee hook (`FEE_MODE=off|accrue`, basis points or flat) for mainnet operators, off by default.
- pino logging with redaction of signatures, keys and auth headers; the signer key is never logged or serialised.
- Dockerfile, GitHub Actions CI (typecheck, unit and anvil interop tests, build, Docker image, site), Dependabot, issue and PR templates.
- Examples: `merchant-express`, `merchant-hono`, `agent-fetch`.
- Documentation: README, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/OPERATIONS.md`, `docs/MAINNET.md`, and a static site with FAQ, JSON-LD and Open Graph metadata.
- `RATE_LIMIT_GLOBAL_PER_WINDOW`: a facilitator-wide ceiling on verify/settle calls (default 1,200 per minute, `0` disables) so many callers together cannot exhaust the RPC quota.
- `rpc_unavailable` reason (HTTP 503 with `Retry-After`) when a network's RPC does not answer, on both `/verify` and `/settle`.
- Adversarial regression suite `test/interop/hardening.test.ts` and `VERIFICATION.md` summarising the security review.

### Security

- The scheme payload must be exactly one of EIP-3009 (`authorization`) or Permit2 (`permit2Authorization`), with well-formed addresses and integers; a body carrying both is refused as `invalid_request`. Previously the screening (denylist, per-payer rate limit, dedupe) read `authorization` first while `@x402/evm` routes on `permit2Authorization`, so a payload with a decoy `authorization` could be screened on one payer and settled for another. The screening helpers now mirror the SDK's routing as well.
- `GET /health` is cached for `HEALTH_CACHE_SECONDS` (the setting was documented but not implemented), and concurrent polls share one RPC probe, so the unauthenticated endpoint cannot be used to multiply RPC calls.
- Error text that reaches callers, `/health` or the log has URLs removed and is bounded in length: viem's messages embed the RPC URL, which often carries a provider API key. RPC URLs are logged as host only.
- `NETWORKS[].rpc` / `explorer` must be `http(s)` URLs.
- Permit2 dedupe keys canonicalise the nonce (`1`, `01` and `0x1` are one key).

[Unreleased]: https://github.com/InferitAI/whitechain-x402-facilitator/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/InferitAI/whitechain-x402-facilitator/releases/tag/v0.1.0
