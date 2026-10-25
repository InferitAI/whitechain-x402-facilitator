# Verification report

Integration and security review of `whitechain-x402-facilitator` before its first release. Everything below was run from a clean `npm ci` on macOS (Darwin 24.1, Node 22.22.3, npm 10.9.8, Foundry 1.7.1: anvil + forge). Nothing was committed or pushed; no private key appears in this file.

## 1. Build, typecheck, tests

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | 198 packages, no audit findings surfaced by npm |
| Typecheck (src, test, scripts; TS 7.0.2 strict) | `npm run typecheck` | clean |
| Unit + interop tests | `npm test` (vitest 5.0.3) | **11 files, 98 tests, 98 passed**, ~5 s |
| Flakiness | `npm test` three more times | 98/98, 98/98, 98/98 |
| Production build | `npm run build` | `dist/` emitted |
| Built server smoke (local anvil, chain id 1874) | `node dist/index.js` | `GET /supported` lists `exact` on `eip155:1874` + signer; `GET /` 200 `text/html` with the CSP; `/health` 200; `/metrics` 200; unknown path 404 JSON; `OPTIONS` 204; malformed JSON 400 `invalid_request`; missing content type 415 `invalid_request`; signer key absent from the log |
| Examples | `npm ci && npm run typecheck` in `examples/merchant-express`, `merchant-hono`, `agent-fetch` | all clean |
| Docker | `docker` is not installed on this machine | Dockerfile validated statically instead: 24 instructions, stages `build -> stage -> runtime`, all `COPY` sources present in the context and not excluded by `.dockerignore`, non-root `USER`, `EXPOSE`, `HEALTHCHECK`, `CMD`; `.env` and `node_modules` ignored. The CI `docker` job builds and runs the image. One residual: TypeScript 7 ships per-platform native binaries (`@typescript/typescript-linux-x64` is in the lockfile, no `libc` field, Go static binary) so the `node:22-alpine` build stage is expected to work, but that is unverified locally |

Test inventory (98):

| File | Tests | What it proves |
| --- | --- | --- |
| `test/interop/exact-eip3009.test.ts` | 25 | Official `@x402/express` and `@x402/hono` servers + official `@x402/fetch` client against this facilitator on anvil: 402 → paid 200 with `PAYMENT-RESPONSE`, tokens move payer → merchant, facilitator pays exactly the gas, payer pays none; replay refused; every negative reason code; denylist, rate limit, API key, budgets, asset allowlist, gas cap, concurrent duplicates |
| `test/interop/permit2.test.ts` | 5 | Vendored init codes reproduce the canonical x402 Permit2 proxy addresses via CREATE2; `exact` via Permit2, `exact` via Permit2 + EIP-2612 gas sponsoring (payer holds 0 gas, sends 0 txs), `upto` |
| `test/interop/pending.test.ts` | 1 | `settlement_pending` with the hash, retry reconciles without a second broadcast, gas counted once |
| `test/interop/hardening.test.ts` | 17 | Adversarial suite written for this review (section 3) |
| `test/unit/*.test.ts` (7 files) | 50 | Rate limiter, gas budget, denylist + OFAC XML, config, API keys, dedupe, fees, schema, logger redaction, metrics, Permit2 init-code hashes, hardening helpers |

## 2. Documentation consistency

README, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/MAINNET.md`, `site/docs.html`, `site/index.html`, `.env.example` and `CHANGELOG.md` were reconciled with the code. Corrections made:

- Reason-code tables listed several policy refusals as HTTP 200; the service answers `unsupported_scheme_network` / `unsupported_asset` 400, `address_denylisted` / `fee_policy_rejected` 403, `duplicate_settlement` 409, `gas_budget_exceeded` and `duplicate_settlement` on **both** endpoints, `facilitator_out_of_gas` on both. Tables now match `src/errors.ts` and `src/facilitator.ts`, and include the new `rpc_unavailable` (503) and the 413 / 415 cases of `invalid_request`.
- Pipeline order in `docs/ARCHITECTURE.md` said dedupe and gas budget were settle-only; both run on `/verify` too (tested).
- `docs/OPERATIONS.md` claimed each log line carries Fastify's request id and that `LOG_LEVEL=debug` adds policy decisions; neither is true. Replaced with the actual log fields.
- `HEALTH_CACHE_SECONDS` was documented (and parsed) but not implemented; it is now (section 3.6).
- README and `site/docs.html` env tables were missing `HEALTH_CACHE_SECONDS`, `PROXY_PROBE_MINUTES`, `RATE_LIMIT_MAX_KEYS`; added, plus the new `RATE_LIMIT_GLOBAL_PER_WINDOW`.
- "Settlement outcomes" now has the reverted-on-chain case (gas is spent and charged) next to "refused by simulation" (nothing is spent).
- `TRUST_PROXY=true` warning (believes any `X-Forwarded-For`) added to the reverse-proxy section.
- Comment in `src/chain/signer.ts` said Whitechain blocks are ~2 s; they are ~1 s (confirmed read-only against `rpc.testnet.whitechain.io`: 5 blocks in 5 s, gas price 5 gwei, matching `docs/OPERATIONS.md`'s sizing).
- Link check (script over 16 markdown files and 4 site pages: relative targets, markdown anchors, in-page `id`s): one broken anchor fixed (`examples/README.md` → `docs/OPERATIONS.md#8-local-development`); everything else resolves. External URLs: 28 checked by HEAD; all 200 except the project's own not-yet-published GitHub repository URLs and the not-yet-deployed Vercel site (404 until publication, as expected).

## 3. Adversarial review

Threat model: an anonymous caller who can send any HTTP request and deploy any contract on the testnet; the facilitator's only assets are its gas wallet and its RPC quota. Each item lists what was checked, what was found, what changed, and the test that pins it.

### 3.1 Drain the gas wallet

- **Spam** `/verify` or `/settle`: each admitted call costs RPC requests, never gas (nothing is broadcast until the SDK's simulation passes). Per-caller buckets (IP or API key) exist; per-payer / per-payTo buckets are only consumed by valid payments so they cannot be used against a victim. **Added** a facilitator-wide ceiling (`RATE_LIMIT_GLOBAL_PER_WINDOW`, default 1,200/min, `0` disables) because many source addresses could otherwise multiply RPC load without bound. Test: "the facilitator-wide ceiling caps RPC fan-out even across many source addresses".
- **Huge batches**: no batch endpoint is registered; one body = one payment; bodies over 64 KiB are refused with 413 in protocol shape. Test: "an oversized body is refused in protocol shape (413) without being parsed".
- **Unsupported tokens**: a plain ERC-20 fails at simulation (`invalid_exact_evm_eip3009_not_supported`), a non-contract fails with `asset_not_deployed_contract`, a token burning >`MAX_SETTLE_GAS` fails with `settle_gas_cap_exceeded`; none costs gas (existing tests, re-verified).
- **Tokens that revert after gas**: a token can behave differently under `eth_call` than in a transaction. New fixture `SimOnlyToken` (`require(tx.gasprice == 0)`) passes `/verify` and the pre-broadcast simulation, then reverts on chain. Finding: this is inherent to sponsoring arbitrary assets and cannot be prevented by simulation; what matters is that the loss is bounded and accounted. Verified: `success: false` with the hash and `invalid_exact_evm_transaction_failed`, gas used ≤ `MAX_SETTLE_GAS`, the facilitator balance decreases by exactly `gasUsed × effectiveGasPrice`, `/metrics` `settle.failed`, `gas.txCount` and `budget.globalSpentTodayWei` increase by exactly that. Mitigations documented: asset allowlist, `REQUIRE_API_KEY`, daily budgets. Test: "a token that passes simulation but reverts on chain costs at most one capped transaction, and that cost is charged to the budget".
- **Budget race**: three concurrent settles of distinct authorizations against a budget with room for 1.9 estimates → exactly one broadcast, two `gas_budget_exceeded` (429), facilitator nonce +1; after the real (smaller) cost replaces the reservation a fourth sequential settle fits and a fifth is refused. Test: "concurrent settles of distinct authorizations cannot overshoot the daily budget by more than one estimate".
- **Settlement to an EIP-6492 counterfactual wallet** would make the facilitator deploy an attacker-supplied factory (`sendTransaction` to it). `@x402/evm` only does that for allowlisted factories and the facilitator allows none; verified `eip6492_factory_not_allowed` on verify and settle with no broadcast. Test: "an ERC-6492 signature naming an attacker's factory is refused and the factory is never called".

### 3.2 Settle to a different `payTo` than the merchant asked

The payer's EIP-712 signature covers `to`; `@x402/evm` checks `authorization.to == paymentRequirements.payTo` (and `witness.to` for Permit2) in **settle as well as verify**, so neither a mismatched authorization nor a client-chosen `accepted.payTo` can redirect funds. Verified with no broadcast for the mismatch and funds landing at the merchant's `payTo` when only `accepted` is tampered with. Tests: "settle (not just verify) refuses an authorization signed to a different payTo, with no broadcast"; "a client-chosen accepted.payTo is ignored".

### 3.3 Replay across networks

Two anvils with different chain ids and the token at the same address, one facilitator serving both. An authorization settled on chain A presented for chain B fails with `invalid_exact_evm_signature` (the EIP-712 domain binds the chain id) on verify and settle with no broadcast on B; the same authorization on A again is `duplicate_settlement` (409) from the in-memory registry; a payment signed for B settles on B. Test: "an authorization settled on one network cannot be replayed on another configured network".

### 3.4 Bypass the denylist or rate limits

- **Found and fixed (the one real bypass):** `@x402/evm` chooses the Permit2 path whenever `permit2Authorization` is present in the payload, but the facilitator's screening helpers (`claimedPayer`, `authorizationKey`) read `authorization` first. A payload carrying a clean decoy `authorization` and a sanctioned payer's `permit2Authorization` would have been screened (denylist, per-payer rate limit, dedupe) on the decoy and settled for the sanctioned payer. Fix: the wire schema now requires exactly one of `authorization` / `permit2Authorization` (both or neither → `invalid_request` 400, before any screening or RPC), and the screening helpers mirror the SDK's routing anyway. Tests: unit "screening helpers pick the same payer the SDK will settle for, even with a decoy authorization"; interop "a payload carrying both … is refused as invalid_request" and "a Permit2-shaped payload from a denylisted payer is refused at screening (403), before the SDK or the chain".
- Malformed inner fields (`0X…` addresses, non-integer values, short nonces) previously reached the SDK and could surface as 500s; the schema now refuses them with 400. Test: "malformed scheme fields are a 400 in protocol shape, never a 500 from inside the SDK".
- `X-Forwarded-For` is ignored unless `TRUST_PROXY` is set, and honoured per hop when it is. Test: "X-Forwarded-For is ignored unless TRUST_PROXY is set".
- An unknown `X-API-Key` is refused with 401 before any bucket or RPC call (cheap for both sides). Test: "an unknown API key is refused before it can touch any bucket or the chain".
- Permit2 dedupe keys now canonicalise the nonce (`1`, `01`, `0x1` are one key), closing a trivial way to race two spellings of one authorization through the in-memory registry (the chain would still have reverted the second, at the facilitator's gas expense). Unit test: "dedupe keys are canonical across nonce spellings".

### 3.5 Make the facilitator sign anything other than settlement transactions

The `FacilitatorEvmSigner` handed to the SDK exposes exactly `address`, `getAddresses`, `getCode`, `readContract`, `verifyTypedData`, `writeContract`, `sendTransaction`, `waitForTransactionReceipt`; there is no `signMessage`, `signTypedData`, `signTransaction` or raw-send surface, `writeContract`/`sendTransaction` never pass a `value`, and the only `sendTransaction` caller in the SDK (6492 factory deployment) is blocked (3.1). The wallet should hold gas only; a malicious "asset" contract called by the facilitator runs with the contract as `msg.sender`, so it cannot move the facilitator's funds. Test: "the signer exposes nothing the SDK could use to sign messages, typed data or raw transactions".

### 3.6 Leak the key, signatures or other secrets

- Signer key: non-enumerable on the config object, never logged (existing unit test; re-checked in the built-server smoke log and in a captured debug log).
- **Found and fixed:** error text from viem embeds the RPC URL (providers put API keys in the path) and multi-line request dumps. It reached callers via `unexpected_*` 500 bodies, the 503 "RPC unavailable" message and the SDK's `invalidMessage` / `errorMessage` passthrough, `/health`'s `error` field, and the operator log. Added `publicErrorMessage()` (URLs → `[url]`, whitespace collapsed, ≤ 240 chars) applied at every exit point, `loggableErrorMessage()` for the log, `redactUrl()` (host only) for logged RPC URLs. Tests: unit "strip URLs …"; interop "the RPC URL (which may carry a provider key) never appears in responses or logs, even when the RPC is down" (facilitator configured with a dead RPC whose path holds a secret: `/health` 200 `degraded`, `/verify` and `/settle` 503 `rpc_unavailable` with `Retry-After`, secret absent from bodies and from the captured log, host-only form present in the log).
- Payment signatures and `X-API-Key`: a facilitator run at `LOG_LEVEL=debug` through a real verify/settle/409 with an API key produced logs that contain the op lines and the key *name* but not the private key, the 65-byte signature, or the API key. Test: "logs at debug level contain neither the signer key, nor payment signatures, nor API keys".
- `/health` is unauthenticated and performed three RPC calls per hit; `HEALTH_CACHE_SECONDS` was not implemented. Implemented (cache + shared in-flight probe). Test with a counting RPC proxy: 1 + 20 polls → RPC calls equal to one probe; with `HEALTH_CACHE_SECONDS=0`, 5 polls → ≥ 5 RPC calls. Test: "GET /health is cached for HEALTH_CACHE_SECONDS, so polling it cannot multiply RPC calls".

### 3.7 SSRF via configured RPCs

RPC and explorer URLs come from the operator's environment only; no request field ever selects a URL or host (networks are looked up by CAIP-2 id in the configured map, the asset/payTo are addresses). The denylist fetcher and `LANDING_FILE` are likewise operator-controlled. Hardening: `NETWORKS[].rpc` / `explorer` must be `http(s)` (so a `file:` or `javascript:` value cannot slip into viem or into the landing page's links). Unit test: "only accepts http(s) RPC and explorer URLs".

### 3.8 Not changed, documented as inherent

- Between `/verify` and `/settle` a payer can race two requests with one authorization; the facilitator serializes and dedupes settles so only one broadcasts, but the merchant may have run its handler twice (x402 protocol property).
- On a free testnet with no asset allowlist, an attacker who is both payer and payee can make the facilitator sponsor transfers to themselves (with any token, including a `SimOnlyToken`-style one) up to the per-payTo (rotatable) and global daily budgets. The global budget is the bound; `REQUIRE_API_KEY` or an asset allowlist removes the vector. `/health` shows `globalSpentToday`.
- Rate limits, budgets, dedupe and the pending-settlement store are in-process (single replica).

## 4. SEO artefacts (`site/`)

Checked on the source and on a CI-style build (`FACILITATOR_URL=… node build.mjs`, which also substituted every `https://x402-facilitator-production-ff5f.up.railway.app` placeholder and injected the Google verification meta when set):

- JSON-LD parses on all three pages: `index.html` SoftwareApplication (name, url, description, category, OS, free Offer, author), SoftwareSourceCode, Person, WebSite, FAQPage (10 Question/Answer pairs); `docs.html` TechArticle + BreadcrumbList (the `about` reference now carries an inline typed node instead of pointing at an `@id` that only exists on the home page); `landing.html` WebAPI. `@context` is `https://schema.org` everywhere.
- Open Graph: `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image` (+ width/height 1200×630) on all pages; Twitter `summary_large_image` card with title, description and image on all pages (`landing.html` was missing `og:url` and the Twitter title/description/image; added).
- Titles 58 / 63 / 57 characters, descriptions 159 / 154 / 158, canonical and `lang` on every page, one `h1` per page, `404.html` is `noindex`.
- `sitemap.xml`: valid namespace, two `<loc>` entries that match the canonical URLs of `index.html` and `docs.html`, ISO `lastmod`; `robots.txt` allows all and points at the same origin's sitemap.
- `og.png` is 1200×630 RGB; `icon-512.png` 512², `apple-touch-icon.png` 180², `favicon-32.png` 32², `favicon.ico` 32×32; all icons referenced by `site.webmanifest` exist.

## 5. Files changed in this review

Source: `src/schema.ts` (payload shape), `src/policy/dedupe.ts` (SDK-mirroring routing, nonce canonicalisation), `src/errors.ts` (`rpc_unavailable`, `publicErrorMessage`, `loggableErrorMessage`), `src/config.ts` (http(s) URLs, `redactUrl`, `RATE_LIMIT_GLOBAL_PER_WINDOW`), `src/facilitator.ts` (health cache, global limiter, sanitised messages, redacted logs), `src/logger.ts` (optional destination), `src/chain/signer.ts` (comment).
Tests: `test/interop/hardening.test.ts` (new, 17), `test/unit/hardening.test.ts` (new, 10), `test/unit/policy.test.ts` (schema cases), helpers (`anvil.ts`, `facilitator.ts`, `chain.ts`), fixture `SimOnlyToken` in `test/fixtures/contracts/TestEIP3009Token.sol` with `test/fixtures/artifacts.json` rebuilt by `npm run build:fixtures` (solc 0.8.26).
Docs: `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/MAINNET.md`, `site/docs.html`, `site/index.html`, `site/landing.html`, `.env.example`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `examples/README.md`, this file.

## 6. Still open

- Done 2026-10-04: deployed (Railway), placeholders filled, `npm run smoke:sepolia` against the public instance passed every check (paid 200, PAYMENT-RESPONSE, settlement [0xc1e9c255…](https://explorer.testnet.whitechain.io/tx/0xc1e9c255d7ac63c99a68406a3a0226cf717654a25f55c73c0454f9ae82e33615), payer paid no gas, replay refused).
- Build the Docker image once on a machine with Docker (or let CI do it) to confirm the alpine + TypeScript 7 native binary assumption.
- Decide whether to deploy the Permit2 proxies on Whitechain Sepolia (`npm run permit2:check`, then `scripts/deploy-permit2-proxies.ts --broadcast` with a throwaway funded key).

## 7. Stellar testnet support (2026-10-25)

Second network family: `stellar:testnet` through the official `@x402/stellar` 2.28.0 `ExactStellarScheme`, with `@stellar/stellar-sdk` pinned to 16.4.1. Whitechain behaviour is unchanged: the original 98 tests pass untouched, and with `STELLAR_FACILITATOR_KEY` unset no Stellar code runs (`/supported`, `/health`, `/metrics` and `describeConfig` are as before).

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | clean |
| Unit + interop (offline) | `npm test` | **15 files, 140 passed, 4 skipped** (the opt-in live file), three runs in a row |
| Build + built-server smoke | `node dist/index.js` with a friendbot-funded `STELLAR_FACILITATOR_KEY` | `/supported` lists `eip155:1874` and `stellar:testnet` (`extra.areFeesSponsored: true`, `signers["stellar:*"]`); `/health` `ok` with the fee payer's spendable XLM and runway; the secret seed appears 0 times in the log |
| Live, official middleware | `npm run test:stellar-live` | 4/4: `@x402/express` + `@x402/fetch` paid 200, token moved payer → merchant, payer's XLM unchanged, replay refused (`duplicate_settlement`), real fee charged to the budget; `@x402/hono` with two concurrent payments on one fee payer, both settled; an underpaying transfer refused with nothing broadcast |
| Live smoke | `npm run smoke:stellar` (fresh asset + SAC) and `ASSET=xlm npm run smoke:stellar` | all checks passed both ways |

Example settlements from these runs (testnet): [`929cfd6b…`](https://stellar.expert/explorer/testnet/tx/929cfd6baa4dfc13741b875a943e20d39b6b9ff1f821808fc846490ca2902c52) (fresh asset), [`69d6f6b1…`](https://stellar.expert/explorer/testnet/tx/69d6f6b168f69196e6b166b5f5620a73a62be82fa5dad759051719d3d5116ad7) (XLM), [`71b3afb0…`](https://stellar.expert/explorer/testnet/tx/71b3afb09659481a1b2c98aa71dcc19caaa7dcb8dc6725b4a48b12a1373d705f) (express), [`8d0d7e43…`](https://stellar.expert/explorer/testnet/tx/8d0d7e437d4fbb7e8eb7aad776ed7207eb25538473f84a481c015a94d88f87e1) and [`ecaef075…`](https://stellar.expert/explorer/testnet/tx/ecaef075a264ba207c328a54023901e36161a13b8253aeba767bc93df66dee2b) (hono, concurrent). A settlement fee was about 10,300 stroops (0.001 XLM).

Adversarial points specific to Stellar, and what pins them:

- **Screening sees the SDK's payer.** `src/stellar/payload.ts` decodes the envelope exactly as the SDK does (one `invokeHostFunction`, `invokeContract`, `transfer`, three arguments, `from = args[0]`); anything it cannot decode is refused by the SDK before simulation. `test/unit/stellar.test.ts`.
- **Case and muxed addresses.** Stellar strkeys are kept verbatim everywhere; a lower-cased strkey fails its checksum and is refused. An M… `payTo` is screened through its G… owner and shares that owner's rate-limit bucket and fee budget, so varying the mux id cannot multiply a merchant's limits. `test/unit/stellar.test.ts`, `test/interop/stellar-policy.test.ts`.
- **Refusals cost nothing.** Denylist, allowlist, timeout and zero-amount refusals, rate limits and the budget kill switch happen before any simulation (counted on the RPC stand-in); a settle that fails before broadcast releases its reservation and its replay lock. `test/interop/stellar-policy.test.ts`.
- **Sequence numbers.** One settlement per fee-payer account at a time (`src/stellar/pool.ts`); others wait or get `facilitator_busy`; the SDK's `selectSigner` throws (no broadcast) if no account is leased. Offline and live tests.
- **Lost outcomes.** A broadcast the SDK reports as failed is checked on chain: landed → success, undecided → `settlement_pending` reconciled on retry without resubmitting, expired → nothing charged, failed → fee charged and authorization left usable. `test/interop/stellar-settlement-accounting.test.ts`.
- **RPC failures.** `getAccountEntry` in the SDK reports an unreachable RPC as "account not found"; balances use `getLedgerEntries` so an outage is `rpc_unavailable` (503), never "out of funds". An RPC serving another network disables Stellar. RPC URLs are redacted as on EVM, in the SDK's console diagnostics too (`src/console.ts`). `test/interop/stellar-policy.test.ts`, `test/unit/console.test.ts`.
- **A stalled RPC.** `rpc.Server` ignores a `timeout` option and the SDK builds its own clients without one, so every request to the Stellar RPC and Horizon goes through a bounded fetch (20 s per call); the SDK's confirmation polling is capped at its own budget plus one call; `start()` and `/health` wait at most 5 s for a Stellar probe, so Whitechain is never held up. `test/interop/stellar-resilience.test.ts`.
- **A lost submission answer.** The fee payer's signer records the hash it signs; when `sendTransaction` fails after the RPC may have taken the transaction (the SDK then reports no hash), that hash is checked like any broadcast (success, `settlement_pending`, failed or expired). `test/interop/stellar-resilience.test.ts`.
- **An unfunded key in the pool.** A settle whose leased account cannot pay the worst-case fee moves to another idle account that can; `/health` lists unfunded fee payers (`unfundedFeePayers`) and reports `lowBalance`. `test/interop/stellar-resilience.test.ts`.
- **Inherent, documented.** A payment can pass simulation and fail on chain (payer moves funds, authorization expires before the ledger closes); the fee is lost, capped by `maxFeeStroops` and counted against the budgets. `@x402/stellar` writes some diagnostics with `console.*` rather than pino (URLs redacted, see above).

Not done here: `site/` pages are unchanged (Whitechain only); no public deployment has Stellar enabled; mainnet (`stellar:pubnet`) stays refused by configuration ([docs/MAINNET.md](docs/MAINNET.md#stellar-mainnet)).
