# Architecture

How the Whitechain x402 Facilitator is put together, what it trusts, and why it is shaped the way it is.

## The job

An x402 facilitator sits between a merchant's resource server and the chain. The merchant's middleware calls it twice per paid request:

1. `POST /verify` before the handler runs: is this signed payment good for this price?
2. `POST /settle` after the handler responded: put it on chain.

It also answers `GET /supported` once at middleware start so the merchant knows which `(scheme, network)` pairs it may offer.

Everything else in this repository exists because a *public* facilitator pays gas for strangers: it needs limits, budgets, screening, keys, health and metrics, and it must never leak the one secret it holds.

## Request flow

```
agent                      merchant API (@x402/express)          facilitator (this repo)                Whitechain
  |  GET /weather              |                                      |                                     |
  |--------------------------->|                                      |                                     |
  |  402 + PAYMENT-REQUIRED    |                                      |                                     |
  |<---------------------------|                                      |                                     |
  |  sign EIP-3009 (off-chain) |                                      |                                     |
  |  GET /weather + PAYMENT-SIGNATURE                                 |                                     |
  |--------------------------->|  POST /verify {payload, requirements}|                                     |
  |                            |------------------------------------->|  policy -> @x402/evm verify         |
  |                            |                                      |  (eth_call: balance, nonce, domain, |
  |                            |                                      |   simulate transferWithAuthorization)|
  |                            |  { isValid: true, payer }            |------------------------------------>|
  |                            |<-------------------------------------|                                     |
  |                            |  run handler                         |                                     |
  |                            |  POST /settle {payload, requirements}|                                     |
  |                            |------------------------------------->|  policy -> reserve gas budget       |
  |                            |                                      |  -> @x402/evm settle (re-verify,    |
  |                            |                                      |     broadcast, wait for receipt)    |
  |                            |                                      |------------------------------------>|
  |                            |  { success: true, transaction }      |  tokens: payer -> payTo             |
  |  200 + PAYMENT-RESPONSE    |<-------------------------------------|  gas: facilitator signer            |
  |<---------------------------|                                      |                                     |
```

The agent never talks to the facilitator. The merchant never signs anything. The facilitator never holds tokens: the transfer is `transferWithAuthorization(from=payer, to=payTo, value, validAfter, validBefore, nonce, signature)`, and every one of those fields is covered by the payer's signature.

## Modules

```
src/
  index.ts            process entry: config, logger, server, graceful shutdown
  server.ts           Fastify routes, request parsing, client IP, API key resolution, response shaping
  schema.ts           zod schemas for the x402 v2 wire bodies (VerifyRequest / SettleRequest)
  facilitator.ts      FacilitatorService: policy pipeline around @x402/core's x402Facilitator
  chain/signer.ts     NetworkSigner: viem clients per network, gas cap, receipt timeout, balance reads
  config.ts           zod-validated environment (NETWORKS, limits, budgets, keys, fees); key kept non-enumerable
  errors.ts           stable reason codes and PolicyError (HTTP status + x402-shaped body)
  logger.ts           pino with redaction of signatures, keys and auth headers
  metrics.ts          process-local counters exposed on /metrics
  landing.ts          serves site/landing.html (or a built-in fallback) at GET /
  address.ts          EVM vs Stellar address rules (case-insensitive hex, case-sensitive strkeys, muxed owners)
  stellar/
    payload.ts        decodes a Stellar exact payload the way @x402/stellar reads it (payer, transfer, auth nonce)
    chain.ts          StellarChain: Soroban RPC client, fee-payer signers, balances, transaction status
    pool.ts           SignerPool: one settlement per fee-payer account at a time (sequence numbers)
  policy/
    ratelimit.ts      token buckets per key with LRU bound
    gasBudget.ts      daily budgets per scope with reserve / settle / release
    dedupe.ts         in-flight and recently settled authorization registry
    denylist.ts       file-backed address screener, hot reload
    apiKeys.ts        X-API-Key registry, SHA-256 digests, constant-time compare
    fee.ts            fee hook: NoFeePolicy (default) or AccruingFeePolicy
```

### Protocol layer: official packages, not a reimplementation

`FacilitatorService` owns one `x402Facilitator` from `@x402/core/facilitator` and registers, per configured network:

- `ExactEvmScheme` from `@x402/evm/exact/facilitator` for `exact`. It handles both payload types: EIP-3009 (`transferWithAuthorization`) and, when the x402 Permit2 proxy exists on the network, Permit2.
- `UptoEvmScheme` from `@x402/evm/upto/facilitator` for `upto`, only where the x402 Upto Permit2 proxy exists.

Both take a `FacilitatorEvmSigner`, which `chain/signer.ts` builds from viem clients for that network's RPC. The scheme implementations do the cryptography and the chain reads: EIP-712 domain reconstruction from `requirements.extra.name/version`, signature recovery for EOAs, EIP-1271 contract wallets and ERC-6492 pre-deployment wallets (no counterfactual factory is allowed, so the facilitator never deploys a wallet), `authorizationState` and balance reads, and an `eth_call` simulation before `writeContract`. The facilitator's own code does not parse signatures. The signer wrapper exposes only `readContract`, `verifyTypedData`, `writeContract`, `sendTransaction`, `waitForTransactionReceipt` and `getCode`: there is no way for the SDK (or a bug in it) to sign a message, typed data or an arbitrary raw transaction with the facilitator key.

The facilitator advertises exactly what is registered. `GET /supported` lists `kinds` for v2 only (no v1 network names), plus `signers` so the SDK can show which address will broadcast.

On Stellar networks (`STELLAR_FACILITATOR_KEY` set) it also registers `ExactStellarScheme` from `@x402/stellar/exact/facilitator`, one per Stellar network, with the fee-payer signers from `stellar/chain.ts`. The SDK verifies the single `transfer` invocation, simulates it, checks the transfer event and the payer's authorization entry, then rebuilds the transaction with a fee-payer account as source, signs and submits it. Its `selectSigner` hook is given the account leased for that settlement (`stellar/pool.ts`), so two settlements never build from the same sequence number.

### Policy pipeline

Every `/verify` and `/settle` passes through the same gates, in this order, before the scheme runs:

1. **Schema.** The body must be a valid x402 v2 `VerifyRequest` / `SettleRequest`, and the scheme payload exactly one of EIP-3009 (`authorization`) or Permit2 (`permit2Authorization`) with well-formed addresses and integers (`invalid_request`, 400; 413 over 64 KiB; 415 without JSON). This mirrors `@x402/evm`'s routing, which selects Permit2 whenever `permit2Authorization` is present: the payer the gates below screen is always the payer the SDK settles for.
2. **API key.** `X-API-Key` resolved by SHA-256 digest; unknown keys are refused (`invalid_api_key`, 401); missing keys are fine unless `REQUIRE_API_KEY=true`. A key carries a rate-limit multiplier, an optional budget and an optional `payTo` restriction.
3. **Scheme and network.** `x402Version` must be 2; `(scheme, network)` must be registered (`unsupported_scheme_network`, 400); `accepted.network`/`scheme` must equal the requirements (`invalid_request`); if the network has an asset allowlist the token must be on it (`unsupported_asset`, 400).
4. **Rate limits.** Token buckets for the caller (client IP, or the API key), then a facilitator-wide ceiling (`RATE_LIMIT_GLOBAL_PER_WINDOW`, bounding RPC fan-out whatever the number of source addresses), then the payer (from the payload's `from`) and the `payTo`. The payer and `payTo` buckets are only *consumed* by payments that verify, so forged payloads cannot exhaust a victim's quota. Empty bucket: `rate_limit_exceeded`, 429, `Retry-After`. `X-Forwarded-For` is ignored unless `TRUST_PROXY` says otherwise.
5. **Denylist.** Payer and `payTo` are checked against the screener (`address_denylisted`, 403).
6. **Dedupe.** An authorization that is in flight or was settled recently is refused (`duplicate_settlement`, 409) rather than re-broadcast: `/verify` looks the key up, `/settle` claims it, so concurrent settles of one authorization yield exactly one broadcast. A retry for a *pending* one reconciles against the known hash.
7. **Gas budget and balance.** `SETTLE_GAS_ESTIMATE * maxFeePerGas` is checked (verify) or reserved (settle) under the global scope, the `payTo` scope and the API-key scope; if any is exhausted: `gas_budget_exceeded`, 429, `Retry-After` until 00:00 UTC. After the receipt, the reservation is replaced by `gasUsed * effectiveGasPrice` (plus the L1 data fee when the RPC reports one). A signer that cannot afford one settlement answers `facilitator_out_of_gas`, 503; an RPC that does not answer, `rpc_unavailable`, 503.
8. **Fee policy** (settle only). `quote()` may refuse sponsorship (`fee_policy_rejected`, 403) and, after success, `onSettled()` accrues the fee.
9. **Scheme.** `x402Facilitator.verify()` / `.settle()`. The signer wrapper enforces `MAX_SETTLE_GAS` inside the SDK's simulation and again at broadcast (`settle_gas_cap_exceeded`), serializes broadcasts with explicit nonces, and records every receipt's cost.

Stellar requests (`network` = `stellar:*`) take the same gates with Stellar inputs: the schema checks C… assets, G…/C…/M… `payTo` and a base64 envelope; payer and nonce come from decoding the envelope as the SDK does; every rate-limit key is prefixed with the network and the facilitator-wide ceiling is a separate `STELLAR_RATE_LIMIT_GLOBAL_PER_WINDOW` bucket; budgets are XLM (stroops) in their own `GasBudget`, reserved at `maxFeeStroops` and charged the fee from the transaction result; `maxTimeoutSeconds` and zero amounts are bounded; a muxed `payTo` is screened through its owner. Settle then leases a fee-payer account (or answers `facilitator_busy`), checks its balance, runs the SDK, and checks the transaction itself whenever the SDK reports a failure with a hash (see [STELLAR.md](STELLAR.md#outcomes-the-sdk-cannot-see)).

Refusals are `PolicyError`s: an HTTP status plus a body that still looks like a `VerifyResponse` / `SettleResponse`, so `HTTPFacilitatorClient` raises `VerifyError` / `SettleError` with the reason instead of a generic transport failure.

### Settlement outcomes

- **Success**: `{ success: true, transaction, network, payer }`; budget reconciled with the real cost; dedupe entry marked settled.
- **Pending**: the transaction was broadcast but no receipt arrived within `CONFIRMATION_TIMEOUT_MS`. The SDK reports `errorReason: "settlement_pending"` with the hash; the budget keeps the estimate charged; the SDK's pending store remembers the hash so a retry reconciles instead of double-spending gas, and the budget is corrected to the real cost then.
- **Refused by simulation or policy**: nothing was broadcast, nothing is charged, the authorization is released for another attempt.
- **Reverted on chain**: a token can behave differently under `eth_call` than inside a transaction (the test suite's `SimOnlyToken` does exactly that), so a simulation can pass and the transaction still revert. The response is `success: false` with the hash and `invalid_exact_evm_transaction_failed`; the gas is lost, bounded by `MAX_SETTLE_GAS`, and charged to the budgets and metrics like any other transaction. This is the inherent cost of sponsoring arbitrary tokens; the asset allowlist removes it on mainnet.

### State

All policy state is in memory and bounded (LRU for rate-limit keys and budget scopes, TTL for dedupe). That is deliberate for a single-replica testnet service: no database, nothing personal retained, restart clears everything. The interfaces (`RateLimiter`, `GasBudget`, `AuthorizationRegistry`, `AddressScreener`, `FeePolicy`) are the seams for a shared Redis implementation when running several replicas on mainnet.

### Networks are data

`NETWORKS` is a JSON list; each entry becomes a `NetworkRuntime` with its own viem clients, signer wrapper, balance cache, scheme set and Permit2 probe result. Adding Whitechain mainnet is a configuration change. At start, and every `PROXY_PROBE_MINUTES`, the service checks whether Uniswap Permit2 and the two x402 proxies exist on each network and registers Permit2 `exact` / `upto` accordingly; `/health` shows the probe result.

## Trust and threat model

| Party | Trusts the facilitator for | Can be hurt by a facilitator bug |
| --- | --- | --- |
| Payer (agent) | nothing beyond availability; it signed exactly what it agreed to pay | a late settlement; never a wrong amount or recipient |
| Merchant | the `isValid` answer it serves a response on | a false `isValid` (served for free), or a refusal to settle |
| Operator | the signer key | wasted gas (forced reverts, budget bypass), key leak |

The signer keys are the only secrets. The EVM key is loaded from `FACILITATOR_PRIVATE_KEY`, kept as a non-enumerable property so `JSON.stringify(config)` cannot leak it, never passed to the logger, and redacted anyway (`REDACT_PATHS`). The signer wallet holds WBT for gas only; the facilitator has no token approvals and no role in any contract.

The Stellar fee-payer secret(s) in `STELLAR_FACILITATOR_KEY` get the same treatment (non-enumerable, never logged, never in `/health`, `/metrics` or `describeConfig`). The accounts hold XLM for fees only; `@x402/stellar` refuses any payload where a facilitator account is the payer, the transaction or operation source, or an authorizer, so a fee-payer key only ever signs a rebuilt transaction whose single operation is the transfer the payer authorized.

RPC URLs are a lesser secret (providers put API keys in the path). They are configuration, never derived from a request (so there is no server-side request forgery surface), restricted to `http(s)`, logged as host only, and stripped from every error message that reaches a caller, `/health` or the log (`publicErrorMessage`).

What a hostile caller *can* do is make the facilitator spend RPC calls (bounded by the per-caller and facilitator-wide rate limits) and, with a token that lies to `eth_call`, lose one capped transaction's gas per settlement (bounded by the per-`payTo` and global daily budgets, and removed entirely by an asset allowlist or `REQUIRE_API_KEY`). The regression suite for these properties is `test/interop/hardening.test.ts`; see `VERIFICATION.md`.

## Why these choices

- **Fastify** over Hono for the service: mature Node HTTP server, built-in JSON body limits and content-type handling, structured pino logging.
- **viem** because `@x402/evm` is written against it; `toFacilitatorEvmSigner` wraps a viem wallet client directly.
- **No database**: a testnet sponsor should not accumulate records about who paid whom; counters and bounded caches are enough to enforce policy.
- **JSON metrics** instead of a Prometheus exporter: no dependency, readable in a browser, trivial to scrape and convert.
- **One repository, three audiences**: service, examples and site live together so a change to the protocol surface updates all three in one PR.
