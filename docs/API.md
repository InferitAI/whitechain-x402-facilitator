# HTTP API

The facilitator speaks x402 v2 exactly as `@x402/core`'s `HTTPFacilitatorClient` (2.28) does, so the official resource-server middleware works against it unmodified. This page documents every endpoint, the policy additions, and the reason codes merchants can branch on.

Base URL: `https://x402-facilitator-production-ff5f.up.railway.app` (public testnet instance) or wherever you run it. All request and response bodies are JSON. Amounts are decimal strings of atomic token units. EVM addresses are checksummed or lowercase hex; comparisons are case-insensitive. Stellar addresses (G…, C…, M…) are case-sensitive and compared exactly; Stellar specifics are in [STELLAR.md](STELLAR.md).

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/supported` | Advertised `(x402Version, scheme, network)` kinds, extensions and signer addresses |
| POST | `/verify` | Check a payment payload against payment requirements |
| POST | `/settle` | Re-check and submit the payment on chain |
| GET | `/health` | Status, signer gas balance and settlement runway per network |
| GET | `/metrics` | JSON counters |
| GET | `/` | Landing page (HTML) |

### Headers

| Header | Direction | Meaning |
| --- | --- | --- |
| `Content-Type: application/json` | request | required on POST |
| `X-API-Key` | request | optional merchant key; raises limits, attaches a dedicated gas budget |
| `Retry-After` | response | on 429: seconds until the rate-limit bucket refills or the daily gas budget resets; on 503: seconds before retrying an unreachable RPC or an empty gas wallet |
| `WWW-Authenticate` | response | on 401: `ApiKey realm="whitechain-x402-facilitator", header="X-API-Key"` |

Request bodies are limited to 64 KiB (`413`) and must be `application/json` (`415`); both come back in the protocol shape with `invalid_request`.

## GET /supported

```http
GET /supported
```

```json
{
  "kinds": [
    { "x402Version": 2, "scheme": "exact", "network": "eip155:1874" }
  ],
  "extensions": ["eip2612GasSponsoring"],
  "signers": { "eip155:*": ["0xFacilitatorSignerAddress"] }
}
```

- `kinds` lists only what is registered. On a network where the x402 Permit2 proxies exist you will also see `{ "scheme": "upto", ... }`; Permit2-based `exact` payloads are accepted under the same `exact` kind.
- `extensions` advertises `eip2612GasSponsoring`: for Permit2 flows a resource server may offer gasless EIP-2612 permits, which `@x402/evm` handles natively.
- `signers` tells the SDK which address will broadcast; it changes when the operator rotates the key.
- With Stellar enabled (`STELLAR_FACILITATOR_KEY`), `kinds` also contains `{ "x402Version": 2, "scheme": "exact", "network": "stellar:testnet", "extra": { "areFeesSponsored": true } }` and `signers` contains `"stellar:*": ["G…fee-payer account"]`.
- Resource servers call this once on start (`syncFacilitatorOnStart`, default `true`) and refuse to serve routes whose `(scheme, network)` is not listed, so a misconfigured network fails at boot rather than at the first paying customer.

## POST /verify

Request (`VerifyRequest` from `@x402/core/types`):

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "resource": { "url": "https://api.example.com/weather", "description": "Current weather", "mimeType": "application/json" },
    "accepted": {
      "scheme": "exact",
      "network": "eip155:1874",
      "asset": "0x2E672dFE33EA977FD064E01aDe7d8c73B3Be7fBB",
      "amount": "10000",
      "payTo": "0xYourMerchantAddress",
      "maxTimeoutSeconds": 120,
      "extra": { "name": "Inferit Test Credit", "version": "1" }
    },
    "payload": {
      "signature": "0x…65 bytes…",
      "authorization": {
        "from": "0xPayer",
        "to": "0xYourMerchantAddress",
        "value": "10000",
        "validAfter": "0",
        "validBefore": "1791140000",
        "nonce": "0x…32 bytes…"
      }
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:1874",
    "asset": "0x2E672dFE33EA977FD064E01aDe7d8c73B3Be7fBB",
    "amount": "10000",
    "payTo": "0xYourMerchantAddress",
    "maxTimeoutSeconds": 120,
    "extra": { "name": "Inferit Test Credit", "version": "1" }
  }
}
```

`paymentRequirements` is what the merchant offered; `paymentPayload.accepted` is what the client chose (normally identical; its `network` and `scheme` must match, the rest is informational because the merchant's requirements and the payer's signature decide where funds go). `extra.name` and `extra.version` are the token's EIP-712 domain and are required for EIP-3009; a mismatch makes every signature invalid.

`payload` must be exactly one of the two `@x402/evm` shapes: `{ signature, authorization: { from, to, value, validAfter, validBefore, nonce } }` (EIP-3009) or `{ signature, permit2Authorization: { from, spender, nonce, deadline, permitted: { token, amount }, witness: { to, validAfter, … } } }` (Permit2, also used by `upto`). A body with both, neither, or malformed addresses/integers is refused with `invalid_request` (400) before anything else runs.

Response `200`:

```json
{ "isValid": true, "payer": "0xPayer" }
```

```json
{
  "isValid": false,
  "invalidReason": "invalid_exact_evm_payload_authorization_valid_before",
  "invalidMessage": "Authorization expires before the settlement deadline",
  "payer": "0xPayer"
}
```

Verification checks, in order: request schema (including the payload shape above); API key; scheme/network registered, `accepted.network`/`scheme` equal to the requirements, asset allowed, API-key `payTo` restriction; rate limits (caller, facilitator-wide ceiling, then the payer's and `payTo`'s buckets, which only *valid* payments consume); denylist (payer and `payTo`); duplicate check against the in-flight / recently-settled registry; gas budget and signer balance (so a merchant learns about `gas_budget_exceeded` or `facilitator_out_of_gas` before serving the response); then the `@x402/evm` scheme: `to == payTo`, `value == amount`, `validAfter <= now < validBefore` with the SDK's safety margin, nonce unused on chain, payer balance `>= amount`, EIP-712 signature valid for the payer (EOA, EIP-1271, ERC-6492 with no counterfactual factories allowed), and a simulated `transferWithAuthorization` succeeds within `MAX_SETTLE_GAS`.

### Stellar request body

For `stellar:testnet` the requirements name a token contract as `asset` and a Stellar `payTo`, and the payload is one base64 transaction envelope (what `@x402/stellar`'s client produces):

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "accepted": { "scheme": "exact", "network": "stellar:testnet", "asset": "C…TokenContract", "amount": "1000000", "payTo": "G…Merchant", "maxTimeoutSeconds": 60, "extra": { "areFeesSponsored": true } },
    "payload": { "transaction": "AAAAAgAAAAA…base64 XDR…" }
  },
  "paymentRequirements": { "scheme": "exact", "network": "stellar:testnet", "asset": "C…TokenContract", "amount": "1000000", "payTo": "G…Merchant", "maxTimeoutSeconds": 60, "extra": { "areFeesSponsored": true } }
}
```

The facilitator reads the payer from the transaction's single `transfer(from, to, amount)` call for screening and rate limits, and its authorization nonce for replay protection; `@x402/stellar` does the verification. Additional Stellar admission rules: `maxTimeoutSeconds` between 1 and the network's limit (default 300), `amount` above zero. See [STELLAR.md](STELLAR.md#policy-per-network).

## POST /settle

Same request body as `/verify`. The facilitator runs the same admission checks, asks the fee policy, claims the authorization in the dedupe registry (a concurrent settle of the same authorization gets `duplicate_settlement`), reserves gas budget, lets `@x402/evm` re-verify and simulate, broadcasts `transferWithAuthorization` (or the Permit2 proxy call) from its signer and waits for the receipt (up to `CONFIRMATION_TIMEOUT_MS`). The receipt's real cost replaces the reservation; a transaction that reverts on chain is reported with its hash and charged like a successful one.

Response `200`:

```json
{ "success": true, "transaction": "0x…", "network": "eip155:1874", "payer": "0xPayer" }
```

```json
{
  "success": false,
  "errorReason": "invalid_exact_evm_insufficient_balance",
  "errorMessage": "…",
  "transaction": "",
  "network": "eip155:1874",
  "payer": "0xPayer"
}
```

Pending (broadcast, receipt not seen within the timeout):

```json
{ "success": false, "errorReason": "settlement_pending", "transaction": "0x…", "network": "eip155:1874", "payer": "0xPayer" }
```

A pending settlement may still confirm. The merchant middleware returns its settlement-failed response; if the client retries with the same authorization the facilitator reconciles against the known hash rather than broadcasting again, and the on-chain nonce makes a double transfer impossible in any case.

Policy refusals (status in the table below) also use this shape, e.g.:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 21600
Content-Type: application/json

{ "success": false, "errorReason": "gas_budget_exceeded", "errorMessage": "daily gas budget for payTo 0x… is exhausted; resets in 21600 s", "transaction": "", "network": "eip155:1874" }
```

`HTTPFacilitatorClient` turns a non-2xx response whose body has `success` (or `isValid`) into a `SettleError` (or `VerifyError`) carrying `errorReason` / `invalidReason` and the HTTP status.

## Reason codes

Facilitator-level codes are stable strings defined in `src/errors.ts`. Scheme-level codes come from `@x402/evm` and are prefixed `invalid_exact_evm_` (or `invalid_upto_evm_`).

| Reason | HTTP | Endpoint | Meaning |
| --- | --- | --- | --- |
| `invalid_request` | 400 (413 oversized, 415 wrong content type) | both | Body failed schema validation, `x402Version` is not 2, `accepted.network`/`scheme` differ from the requirements, or the payload is not exactly one of EIP-3009 / Permit2 |
| `unsupported_scheme_network` | 400 | both | No scheme registered for that `(x402Version, scheme, network)`; see `GET /supported` |
| `unsupported_asset` | 400 | both | Network has an asset allowlist and the token is not on it |
| `invalid_api_key` | 401 | both | `X-API-Key` unknown, missing while `REQUIRE_API_KEY=true`, or not allowed to settle to this `payTo` |
| `address_denylisted` | 403 | both | Payer or `payTo` is on the sanctions denylist |
| `fee_policy_rejected` | 403 | settle | The fee policy declined to sponsor the payment |
| `duplicate_settlement` | 409 | both | Same authorization is in flight or was settled recently by this facilitator |
| `rate_limit_exceeded` | 429 | both | Caller (IP or key), facilitator-wide, per-payer or per-payTo bucket is empty; see `Retry-After` |
| `gas_budget_exceeded` | 429 | both | Daily gas budget (global, per payTo or per key) is spent; `Retry-After` points at the 00:00 UTC reset |
| `facilitator_out_of_gas` | 503 | both | Signer cannot afford a single settlement on that network |
| `rpc_unavailable` | 503 | both | The network's RPC did not answer (or, on Stellar, serves a different network than configured); nothing was checked or broadcast |
| `facilitator_busy` | 503 | settle | Stellar only: every fee-payer account is busy with another settlement; retry after `Retry-After` (5 s) |
| `unexpected_verify_error`, `unexpected_settle_error` | 500 | both | Unhandled exception; the log line carries the reason and the (URL-redacted) error |
| `settle_gas_cap_exceeded` | 200 | both | Simulation needs more than `MAX_SETTLE_GAS` |
| `settlement_pending` | 200 | settle | Broadcast; receipt not seen within the timeout |
| `invalid_exact_stellar_*`, `settle_exact_stellar_*` | 200 | both | Scheme-level, from `@x402/stellar`: wrong operation, asset, recipient or amount, simulation failed (balance, trustline, used nonce), missing or expiring payer signature, fee above `maxFeeStroops`, transaction failed on chain |
| `invalid_exact_evm_*`, `permit2_*`, `invalid_permit2_*`, `eip6492_factory_not_allowed`, `asset_not_deployed_contract` | 200 | both | Scheme-level, from `@x402/evm`: bad or mismatched signature, wrong `to`/`value`, outside the validity window, nonce used, insufficient balance, simulation failed, missing EIP-712 domain, token without EIP-3009, counterfactual smart wallet, reverted on chain (`invalid_exact_evm_transaction_failed`, with the hash in `transaction`) |

Status `200` with `isValid: false` / `success: false` is the x402 convention for "the payment is bad"; non-2xx statuses mean "the facilitator cannot or will not process this request right now" and are what `HTTPFacilitatorClient` turns into `VerifyError` / `SettleError`. `invalidMessage` / `errorMessage` are human-readable, bounded in length, and never contain URLs.

## GET /health

```json
{
  "status": "ok",
  "service": "whitechain-x402-facilitator",
  "x402Version": 2,
  "uptimeSeconds": 86400,
  "facilitator": "0xFacilitatorSignerAddress",
  "denylistSize": 412,
  "networks": [
    {
      "network": "eip155:1874",
      "name": "Whitechain Sepolia",
      "chainId": 1874,
      "explorer": "https://explorer.testnet.whitechain.io",
      "nativeSymbol": "WBT",
      "schemes": ["exact"],
      "permit2": { "deployed": true, "exactProxy": false, "uptoProxy": false, "probedAt": "2026-10-04T18:00:00.000Z" },
      "facilitator": "0xFacilitatorSignerAddress",
      "gasBudget": {
        "globalDaily": "1000000000000000000",
        "globalSpentToday": "41230000000000000",
        "perPayToDaily": "100000000000000000",
        "resetsInSeconds": 21600
      },
      "rpcOk": true,
      "blockNumber": "9547824",
      "gasBalanceWei": "1234500000000000000",
      "gasBalance": "1.2345 WBT",
      "maxFeePerGasWei": "5001000000",
      "estimatedSettleCostWei": "600120000000000",
      "settleRunway": 2056,
      "lowBalance": false
    }
  ]
}
```

- `status` is `ok` or `degraded`. Degraded means at least one network has `rpcOk: false` or `lowBalance: true` (runway below `LOW_RUNWAY_SETTLES`). The endpoint always answers HTTP 200 (it is a status report, not a liveness probe); monitors should alert on `status != "ok"` or on `lowBalance` / `rpcOk` per network.
- `settleRunway` is `floor(balance / (maxFeePerGas * SETTLE_GAS_ESTIMATE))`: how many settlements the signer could pay for at current gas prices.
- The probe is cached for `HEALTH_CACHE_SECONDS` (default 10) so a monitor polling every few seconds does not hammer the RPC.
- A Stellar network appears in `networks` with `feePayers`, `latestLedger`, `feeBalances` (spendable XLM per fee-payer account), `settleRunway` (spendable XLM ÷ `maxFeeStroops`), `settlementSlots` and its fee budget; see [STELLAR.md](STELLAR.md#health-and-metrics).

## GET /metrics

Process-local counters, reset on restart:

```json
{
  "startedAt": "2026-10-04T18:00:00.000Z",
  "uptimeSeconds": 3600,
  "verify": { "total": 120, "valid": 115, "invalid": 5, "errors": 0, "byReason": { "invalid_exact_evm_insufficient_balance": 5 } },
  "settle": { "total": 110, "success": 109, "failed": 1, "pending": 0, "errors": 0, "byReason": {}, "settledAmountAtomic": { "eip155:1874|0xitc…": "1100000" } },
  "policy": { "rateLimited": 3, "denylisted": 0, "gasBudgetExceeded": 0, "gasCapExceeded": 0, "duplicate": 1, "unauthorized": 0, "unsupported": 0, "invalidRequest": 0 },
  "gas": { "spentWei": { "eip155:1874": "41230000000000000", "total": "41230000000000000" }, "txCount": 109 },
  "http": { "requests": 420, "supported": 12 },
  "budget": { "day": "2026-10-04", "globalSpentTodayWei": "41230000000000000", "globalDailyLimitWei": "1000000000000000000", "perPayToDailyLimitWei": "100000000000000000", "totalSpentWei": "41230000000000000", "resetsInSeconds": 21600 },
  "fees": { "mode": "off" },
  "dedupe": { "tracked": 12 },
  "rateLimiters": { "callers": 8, "payers": 5, "payTos": 3 }
}
```

With Stellar enabled, a `stellar` section adds fees spent per network in stroops, the Stellar transaction count, pending broadcasts, the XLM budget state and fee-payer slot usage.

With `FEE_MODE=accrue`, `fees.accrued` lists, per `payto:<address>` or `apikey:<name>`, the network, asset, accrued fee in atomic units and settle count.

## Pricing in dollars

`price: "$0.01"` needs a default asset for the network, and the x402 SDK does not ship one for Whitechain. Register a money parser once and every route can use dollar strings:

```ts
import { convertToTokenAmount } from "@x402/core/utils";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const ITC = { asset: "0x2E672dFE33EA977FD064E01aDe7d8c73B3Be7fBB", decimals: 6, extra: { name: "Inferit Test Credit", version: "1" } };

const scheme = new ExactEvmScheme().registerMoneyParser(async (amount, network) =>
  network === "eip155:1874"
    ? { asset: ITC.asset, amount: convertToTokenAmount(amount, ITC.decimals), extra: ITC.extra }
    : null,
);
const server = new x402ResourceServer(facilitator).register("eip155:1874", scheme);
```

## Calling the API directly

You normally let the middleware do this, but for debugging:

```sh
curl -s https://x402-facilitator-production-ff5f.up.railway.app/supported | jq
curl -s https://x402-facilitator-production-ff5f.up.railway.app/health | jq '.status, .networks[0].settleRunway'
curl -s -X POST https://x402-facilitator-production-ff5f.up.railway.app/verify -H 'content-type: application/json' -d @verify.json | jq
```

`verify.json` is the body shown above. You can produce a real one by running [`examples/agent-fetch`](../examples/agent-fetch) against a merchant with `LOG_LEVEL=debug` on the merchant side, or by calling `ExactEvmScheme.createPaymentPayload()` from `@x402/evm/exact/client` yourself.
