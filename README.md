<div align="center">

# Whitechain x402 Facilitator

**whitechain-x402-facilitator is the first public x402 v2 facilitator for Whitechain, live on Whitechain Sepolia (testnet).**

Point a standard x402 server at it, and AI agents pay your API per request in EIP-3009 tokens. The payer pays you directly; the facilitator pays the gas.

Self-hosted, it also settles on Stellar testnet (`stellar:testnet`) through the official `@x402/stellar` package, with the same limits and screening: see [docs/STELLAR.md](docs/STELLAR.md).

[![Website](https://img.shields.io/badge/inferit.cc-website-141414?labelColor=6B6D71)](https://inferit.cc)
[![Docs](https://img.shields.io/badge/docs-API%20%C2%B7%20operations-141414?labelColor=6B6D71)](docs)
[![Live service](https://img.shields.io/badge/facilitator-live%20on%20testnet-141414?labelColor=6B6D71)](https://x402-facilitator-production-ff5f.up.railway.app/health)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-141414?labelColor=6B6D71)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/InferitAI/whitechain-x402-facilitator/ci.yml?branch=main&label=CI&color=141414&labelColor=6B6D71)](https://github.com/InferitAI/whitechain-x402-facilitator/actions/workflows/ci.yml)
[![x402 v2](https://img.shields.io/badge/x402-v2%20%C2%B7%20%40x402%2Fcore%202.28-141414?labelColor=6B6D71)](https://github.com/x402-foundation/x402)
[![Whitechain Sepolia](https://img.shields.io/badge/network-eip155%3A1874-141414?labelColor=6B6D71)](https://explorer.testnet.whitechain.io)
[![X](https://img.shields.io/badge/X-%40inferit__-141414?logo=x&logoColor=ECEAE4&labelColor=6B6D71)](https://x.com/inferit_)

<sub>Testnet: payments use Inferit Test Credit (ITC), a test token with no monetary value.</sub>

</div>

---

- **Public facilitator:** `https://x402-facilitator-production-ff5f.up.railway.app` (free on Whitechain Sepolia, no sign-up)
- **Docs:** [docs/](docs): the HTTP API, architecture, operations and the planned mainnet setup
- **Works with:** `@x402/express`, `@x402/hono`, `@x402/next` (merchants), `@x402/fetch`, `@x402/axios` (agents, once the token is allowed in the client's spend controls)

## Contents

- [What is x402?](#what-is-x402)
- [Why Whitechain](#why-whitechain)
- [Use the public facilitator](#use-the-public-facilitator)
- [Merchant quickstart](#merchant-quickstart)
- [Agent quickstart](#agent-quickstart)
- [Stellar](#stellar)
- [Supported networks and tokens](#supported-networks-and-tokens)
- [HTTP API](#http-api)
- [Self-hosting](#self-hosting)
- [Policy: free testnet, with limits](#policy-free-testnet-with-limits)
- [Security model](#security-model)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [Built by](#built-by)

## What is x402?

[x402](https://x402.org) is an open payment protocol built on the HTTP status code `402 Payment Required`. A server answers an unpaid request with 402 and a machine-readable price. The client, typically an AI agent or another API, signs a payment for exactly that amount and retries with a `PAYMENT-SIGNATURE` header. The server asks a **facilitator** to verify the signature and, once the response is produced, to settle it on chain. One HTTP round trip, one on-chain transfer, no accounts or invoices.

The facilitator is the only infrastructure in that loop. This repository is that piece for Whitechain: an x402 v2 facilitator with `/verify`, `/settle` and `/supported`, built on the official `@x402/core` and `@x402/evm` packages, plus the operating policy a public gas sponsor needs.

## Why Whitechain

- **WhiteBIT ecosystem.** Whitechain is the EVM network of the WhiteBIT exchange; merchants and agents that already hold assets there can use them for pay-per-request APIs without leaving it.
- **OP Stack L2 with 1-second blocks.** A settlement confirms inside the same HTTP request instead of making the client wait.
- **Low fees, gas in WBT.** A settlement is one `transferWithAuthorization` call, paid for by the facilitator, so sub-cent micropayments stay economical and the payer needs no gas at all.
- **USDC.e via the Portal.** Bridged USDC.e follows Circle's FiatToken interface, including EIP-3009, which is exactly what x402's `exact` scheme signs. On testnet the Inferit Test Credit (ITC) plays that role.

## Use the public facilitator

| | |
| --- | --- |
| Facilitator URL | `https://x402-facilitator-production-ff5f.up.railway.app` |
| Network | Whitechain Sepolia, `eip155:1874` |
| Scheme | `exact` (EIP-3009 `transferWithAuthorization`) |
| Test token | Inferit Test Credit (ITC), 6 decimals, public faucet: `0x2E672dFE33EA977FD064E01aDe7d8c73B3Be7fBB` |
| Price | Free, within [limits](#policy-free-testnet-with-limits) |
| Status | `https://x402-facilitator-production-ff5f.up.railway.app/health` |
| First settlement | [`0xc1e9c255…`](https://explorer.testnet.whitechain.io/tx/0xc1e9c255d7ac63c99a68406a3a0226cf717654a25f55c73c0454f9ae82e33615) on 2026-10-04: an agent with 0 WBT paid 0.01 ITC through `@x402/fetch`; the facilitator paid the gas |

Merchants need an address. Agents need ITC and no WBT. Nobody needs an account.

Get 1,000 test ITC for an agent address without any gas (sponsored by the Inferit testnet API, once per address per 24 h), or call `faucet()` on the token from a wallet that holds test WBT:

```sh
curl -X POST https://api-production-c74b9.up.railway.app/v1/faucet \
  -H 'content-type: application/json' -d '{"address":"0xYourAgentAddress"}'
```

## Merchant quickstart

Any x402 resource server works. The three things that differ from a Base setup: the facilitator URL, the network `eip155:1874`, and an explicit token price (the x402 SDK has no "$" default asset for Whitechain yet).

### Express

```sh
npm install @x402/express @x402/core @x402/evm express
```

```ts
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const facilitator = new HTTPFacilitatorClient({ url: "https://x402-facilitator-production-ff5f.up.railway.app" });
const server = new x402ResourceServer(facilitator).register("eip155:1874", new ExactEvmScheme());

const app = express();
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          network: "eip155:1874", // Whitechain Sepolia
          payTo: "0xYourMerchantAddress",
          price: {
            asset: "0x2E672dFE33EA977FD064E01aDe7d8c73B3Be7fBB",
            amount: "10000", // 0.01 ITC (6 decimals)
            extra: { name: "Inferit Test Credit", version: "1" }, // the token's EIP-712 domain
          },
          maxTimeoutSeconds: 120,
        },
        description: "Current weather, paid per request on Whitechain",
        mimeType: "application/json",
      },
    },
    server,
  ),
);

app.get("/weather", (_req, res) => res.json({ city: "Lisbon", temperatureC: 24 }));
app.listen(4021);
```

### Hono

```sh
npm install @x402/hono @x402/core @x402/evm hono @hono/node-server
```

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const facilitator = new HTTPFacilitatorClient({ url: "https://x402-facilitator-production-ff5f.up.railway.app" });
const server = new x402ResourceServer(facilitator).register("eip155:1874", new ExactEvmScheme());

const app = new Hono();
app.use(
  paymentMiddleware(
    {
      "POST /summarize": {
        accepts: {
          scheme: "exact",
          network: "eip155:1874",
          payTo: "0xYourMerchantAddress",
          price: { asset: "0x2E672dFE33EA977FD064E01aDe7d8c73B3Be7fBB", amount: "2500", extra: { name: "Inferit Test Credit", version: "1" } },
        },
      },
    },
    server,
  ),
);

app.post("/summarize", async (c) => c.json({ summary: "..." }));
serve({ fetch: app.fetch, port: 4022 });
```

`@x402/next` takes the same `routes` object and `x402ResourceServer`. To price in dollars (`"$0.01"`) instead, register a money parser on `ExactEvmScheme` that maps a decimal amount to the ITC address; see [docs/API.md](docs/API.md#pricing-in-dollars).

Optional merchant API key (higher limits): pass `createAuthHeaders` to `HTTPFacilitatorClient` returning `{ verify, settle, supported }` each set to `{ "X-API-Key": key }`. Full programs: [examples/merchant-express](examples/merchant-express), [examples/merchant-hono](examples/merchant-hono).

## Agent quickstart

Agents never talk to the facilitator; they talk to the merchant and sign. Two Whitechain specifics: register the network, and allow the token in `spendControls` (the SDK refuses tokens outside its default list unless you opt in).

```sh
npm install @x402/fetch @x402/evm viem
```

```ts
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:1874", client: new ExactEvmScheme(account) }],
  spendControls: {
    // allow the Whitechain token, cap each payment at 0.10 ITC
    allowedAssets: [{ network: "eip155:1874", asset: "0x2E672dFE33EA977FD064E01aDe7d8c73B3Be7fBB", maxAmountPerPayment: "100000" }],
  },
});

const res = await fetchWithPayment("https://api.example.com/weather"); // 402 -> signed -> 200
console.log(await res.json());
const receipt = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE") as string);
console.log(`https://explorer.testnet.whitechain.io/tx/${receipt.transaction}`);
```

The wallet needs ITC and **no WBT**: the facilitator pays the gas. Full program: [examples/agent-fetch](examples/agent-fetch).

## Stellar

Set `STELLAR_FACILITATOR_KEY` (a Stellar secret seed for a fee-payer account, friendbot-funded on testnet) and the facilitator also serves `stellar:testnet`:

- **Merchants** register `ExactStellarScheme` from `@x402/stellar/exact/server` for `stellar:testnet` and price a route in a token contract (`price: { asset: "C…", amount }`, 7 decimals for Stellar Asset Contracts), with a G…, C… or M… `payTo`.
- **Agents** register `ExactStellarScheme` from `@x402/stellar` with `createEd25519Signer(secret, "stellar:testnet")`. They sign only the Soroban authorization for `transfer(payer, payTo, amount)` and need no XLM; the facilitator's fee-payer account submits the transaction and pays the fee.
- **Verification is the official implementation**: `@x402/stellar` checks the single `transfer` call, its asset, recipient and exact amount, simulates it, checks the transfer event and the payer's signed authorization. This project adds the same policy as on Whitechain, per network: rate limits, daily fee budgets in XLM, denylist (Stellar addresses kept case-sensitive, muxed accounts screened through their owner), replay protection on the authorization nonce, API-key scope and an asset allowlist.
- **Throughput**: each fee-payer account settles one payment at a time (Stellar sequence numbers); list several keys, comma-separated, for parallel settlements.

Configuration, wire format, outcomes and limits: [docs/STELLAR.md](docs/STELLAR.md). Try it end to end with throwaway testnet accounts: `npm run smoke:stellar`.

## Supported networks and tokens

| Network | CAIP-2 | RPC | Explorer | Gas | Status |
| --- | --- | --- | --- | --- | --- |
| Whitechain Sepolia (testnet) | `eip155:1874` | `https://rpc.testnet.whitechain.io` | https://explorer.testnet.whitechain.io | test WBT ([faucet](https://faucet.testnet.whitechain.io)) | Live, free |
| Whitechain mainnet | `eip155:<chain id>` | published by Whitechain at launch | | WBT | Config entry; see [docs/MAINNET.md](docs/MAINNET.md) |
| Stellar testnet | `stellar:testnet` | `https://soroban-testnet.stellar.org` | https://stellar.expert/explorer/testnet | test XLM ([friendbot](https://friendbot.stellar.org)) | Self-hosted, enable with `STELLAR_FACILITATOR_KEY`; see [docs/STELLAR.md](docs/STELLAR.md) |

| Token | Network | Standard | EIP-712 domain (`extra`) | Decimals |
| --- | --- | --- | --- | --- |
| Inferit Test Credit (ITC) `0x2E672dFE33EA977FD064E01aDe7d8c73B3Be7fBB` | Whitechain Sepolia | EIP-3009 + EIP-2612, public faucet (1,000 ITC per address per 24 h) | `name: "Inferit Test Credit"`, `version: "1"` | 6 |
| USDC.e | Whitechain mainnet | Circle FiatToken (EIP-3009) | Read `name` and `version` from the deployed contract (the Whitechain Sepolia USDC.e reads `"Bridged USDC (Whitechain)"`, `"2"`) | 6 |
| Any ERC-20 | any | Permit2 (`exact`) and `upto` | n/a | token's |
| Any SEP-41 token contract (every classic asset's Stellar Asset Contract, e.g. XLM `CDLZFC3S…CYSC`, testnet USDC `CBIELTK6…DAMA`) | Stellar testnet | Soroban `transfer` with the payer's signed authorization entry | n/a | 7 for Stellar Asset Contracts |

Schemes: `exact` with EIP-3009 on every configured network. `exact` via Permit2 and `upto` are registered automatically on networks where the x402 Permit2 proxy contracts exist (see [Roadmap](#roadmap)). Networks are configuration, not code: `NETWORKS` is a JSON list of `{ id, name, rpc, explorer, nativeSymbol, testnet, assets? }`.

## HTTP API

The wire format is x402 v2 exactly as `@x402/core`'s `HTTPFacilitatorClient` sends it; the middleware calls these for you. Full request and response examples: [docs/API.md](docs/API.md).

| Endpoint | Purpose |
| --- | --- |
| `GET /supported` | `{ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:1874" }], extensions: ["eip2612GasSponsoring"], signers: { "eip155:*": ["0x…"] } }` |
| `POST /verify` | `{ x402Version, paymentPayload, paymentRequirements }` → `{ isValid, invalidReason?, invalidMessage?, payer? }` |
| `POST /settle` | same body → `{ success, transaction, network, payer?, errorReason?, errorMessage? }` |
| `GET /health` | status (`ok` / `degraded`), signer address, per-network gas balance, settle runway, budget state |
| `GET /metrics` | JSON counters: verifies, settles, failures by reason, gas spent, budget, fees |
| `GET /` | this project's landing page |

With Stellar enabled, `/supported` also lists `{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } }` and the fee-payer account(s) under `signers["stellar:*"]`, and `/health` and `/metrics` gain a Stellar entry.

Policy refusals keep the x402 body shape but use a non-2xx status, so the official client surfaces them as typed `VerifyError` / `SettleError`: `invalid_request` (400), `unsupported_scheme_network` and `unsupported_asset` (400), `invalid_api_key` (401), `address_denylisted` and `fee_policy_rejected` (403), `duplicate_settlement` (409), `rate_limit_exceeded` and `gas_budget_exceeded` (429 with `Retry-After`), `facilitator_out_of_gas`, `rpc_unavailable` and, on Stellar, `facilitator_busy` (503 with `Retry-After`). Verdicts about the payment itself come back as HTTP 200 with `isValid: false` / `success: false`: the scheme-level reasons from `@x402/evm` (`invalid_exact_evm_*`, `permit2_*`, …) and `@x402/stellar` (`invalid_exact_stellar_*`, `settle_exact_stellar_*`) plus `settle_gas_cap_exceeded` and `settlement_pending`. Full table: [docs/API.md](docs/API.md#reason-codes).

## Self-hosting

Requirements: Node 22 (or Docker), a wallet funded with WBT for gas, an RPC URL. The signer key is read from the environment and never logged.

```sh
docker build -t whitechain-x402-facilitator .
docker run -p 8402:8402 -e FACILITATOR_PRIVATE_KEY=0x... whitechain-x402-facilitator
curl -s localhost:8402/supported
```

From source:

```sh
git clone https://github.com/InferitAI/whitechain-x402-facilitator
cd whitechain-x402-facilitator
npm ci
cp .env.example .env            # set FACILITATOR_PRIVATE_KEY
npm run build && npm start      # or: npm run dev
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `FACILITATOR_PRIVATE_KEY` | required | 0x-prefixed 32-byte key of the gas wallet. Holds WBT only. |
| `NETWORKS` | Whitechain Sepolia | JSON array (or path to a JSON file) of networks: `{ id, name, rpc, explorer, nativeSymbol, testnet, assets? }`. |
| `SCHEMES` | `exact,upto` | Schemes to register; `upto` is advertised only where the x402 Permit2 proxies exist. |
| `PORT`, `HOST` | `8402`, `0.0.0.0` | Listen address. |
| `TRUST_PROXY` | `false` | `true` or hop count behind a reverse proxy (client IP for rate limits). |
| `SIMULATE_IN_SETTLE` | `true` | Simulate before broadcasting so doomed transactions never cost gas. |
| `CONFIRMATION_TIMEOUT_MS` | `60000` | Receipt wait bound; keep below your platform's request deadline. |
| `MAX_SETTLE_GAS`, `SETTLE_GAS_ESTIMATE` | `300000`, `120000` | Per-settlement gas cap; reservation before the real cost is known. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Token-bucket window. |
| `RATE_LIMIT_IP_PER_WINDOW`, `RATE_LIMIT_PAYER_PER_WINDOW`, `RATE_LIMIT_PAYTO_PER_WINDOW` | `120`, `30`, `120` | Requests per window per client IP (or API key), payer, payTo. |
| `RATE_LIMIT_GLOBAL_PER_WINDOW` | `1200` | Facilitator-wide ceiling on verify+settle calls per window (bounds RPC fan-out); `0` disables. |
| `RATE_LIMIT_MAX_KEYS` | `50000` | Memory bound on tracked IPs/payers/payTos (LRU). |
| `GAS_BUDGET_GLOBAL_DAILY`, `GAS_BUDGET_PER_PAYTO_DAILY` | `1`, `0.1` | Daily budgets in native units (decimal). `unlimited` (or empty) disables, `0` refuses every settlement. |
| `LOW_RUNWAY_SETTLES` | `50` | `/health` goes `degraded` below this many affordable settlements. |
| `HEALTH_CACHE_SECONDS` | `10` | How long one `/health` probe is reused before the RPC is asked again. |
| `PROXY_PROBE_MINUTES` | `10` | Re-probe networks for newly deployed Permit2 proxies (`0` = at start only). |
| `API_KEYS`, `REQUIRE_API_KEY` | none, `false` | JSON array of `{ name, key \| keySha256, rateLimitMultiplier?, dailyGasBudget?, dailyStellarFeeBudget?, payTo? }`; `payTo` may list EVM and Stellar addresses. |
| `DENYLIST_FILE`, `DENYLIST_RELOAD_SECONDS` | `denylist.txt`, `300` | Sanctions denylist, one address per line, hot-reloaded. |
| `FEE_MODE`, `FEE_BPS`, `FEE_FLAT_ATOMIC` | `off`, `0`, `0` | Fee hook; `accrue` records a fee per settlement in `/metrics`. |
| `LANDING_FILE`, `DOCS_URL`, `REPO_URL`, `PUBLIC_URL` | `site/landing.html`, … | What `GET /` serves and links to. |
| `LOG_LEVEL` | `info` | pino level. Signatures, keys and `X-API-Key` are always redacted. |
| `STELLAR_FACILITATOR_KEY` | unset (Stellar off) | Stellar secret seed(s) (`S…`, comma-separated for several fee-payer accounts). Each account holds XLM for fees only. |
| `STELLAR_NETWORKS` | `stellar:testnet` | JSON array of `{ id, name?, rpc?, explorer?, assets?, maxFeeStroops?, inclusionFeeStroops?, maxTimeoutSeconds? }`; only `stellar:testnet` in this release. |
| `STELLAR_FEE_BUDGET_GLOBAL_DAILY`, `STELLAR_FEE_BUDGET_PER_PAYTO_DAILY` | `50`, `5` | Daily network-fee budgets in XLM, per Stellar network; same `unlimited` / `0` forms. |
| `STELLAR_RATE_LIMIT_GLOBAL_PER_WINDOW` | `300` | Ceiling on Stellar verify+settle calls per window, per network; `0` disables. |
| `STELLAR_SETTLE_QUEUE_TIMEOUT_MS` | `30000` | How long a settle waits for a free fee-payer account before `facilitator_busy`. |

Operations (funding, budgets, denylist updates, monitoring, incidents): [docs/OPERATIONS.md](docs/OPERATIONS.md). Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Policy: free testnet, with limits

The public facilitator sponsors every settlement on Whitechain Sepolia. To keep that sustainable it enforces:

- **Rate limits** per client IP, per payer address and per `payTo` address (token buckets; defaults 120, 30 and 120 requests per minute), plus a facilitator-wide ceiling (1,200 per minute) so many callers together cannot exhaust the RPC.
- **Daily gas budgets**, per `payTo` and global, in WBT, checked on `/verify` as well as `/settle`; a payment beyond the budget is refused with `gas_budget_exceeded` and a `Retry-After` pointing at the 00:00 UTC reset. Refusals happen before broadcast, so they cost nothing.
- **Optional merchant API keys** (`X-API-Key`) with 10x limits and a dedicated budget. Request one with the [API key issue template](https://github.com/InferitAI/whitechain-x402-facilitator/issues/new?template=api_key_request.yml).
- **Sanctions screening**: a denylist of addresses built from the public OFAC SDN list, checked on payer and payee of every verify and settle.
- **Per-settlement gas cap** (`MAX_SETTLE_GAS`): the facilitator will not sponsor a transfer whose simulation needs more.
- **On Stellar** the same limits apply per network, with daily budgets in XLM and a per-settlement fee cap (`maxFeeStroops`).

Nothing about you is stored beyond counters and short-lived rate-limit keys. Signatures are never logged. Testnet tokens have no monetary value.

## Security model

- **No custody.** An `exact` payment is one on-chain transfer from the payer to `payTo`, signed by the payer. The signature covers recipient, amount, validity window and nonce; the facilitator can only submit it or not.
- **Verification is the official implementation.** `@x402/evm`'s facilitator scheme does the EIP-712 recovery (EOA, EIP-1271, ERC-6492 smart wallets), balance and nonce checks, and an on-chain simulation. This project adds policy around it rather than re-implementing it.
- **Blast radius is gas.** The signer holds WBT only and the facilitator only ever signs settlement transactions (`transferWithAuthorization`, or the Permit2 proxies' `settle` / `settleWithPermit`), never messages or typed data. The worst case per request is one transaction capped at `MAX_SETTLE_GAS`; the daily budgets bound the total, and a transfer that reverts on chain is charged to them like any other. Rotate the key by changing one environment variable; `/supported` advertises the new signer.
- **Replay and duplicate protection.** On-chain nonces plus an in-memory registry of in-flight and recently settled authorizations; a retried settle reconciles against the broadcast hash instead of re-broadcasting. Signatures are bound to one chain by their EIP-712 domain, so an authorization cannot be replayed on another configured network.
- **Screening sees the real payer.** A payload must be exactly one of EIP-3009 (`authorization`) or Permit2 (`permit2Authorization`); anything else is `invalid_request`. Denylist, rate limits and dedupe therefore always look at the same payer `@x402/evm` will settle for.
- **Sanctions hook.** Payer and payee are checked against the denylist file; `npm run denylist:ofac` rebuilds it from the OFAC SDN list.
- **Stellar: blast radius is fees.** The fee-payer accounts hold XLM only and sign only the rebuilt settlement transaction, whose single operation is the `transfer` the payer authorized; `@x402/stellar` refuses any payload in which a facilitator account is the payer, the source or an authorizer, and each settlement's fee is capped by `maxFeeStroops`.
- **No secrets in logs or responses.** pino redaction covers signatures, keys and auth headers; request bodies are never logged whole; error text that reaches callers, `/health` or the log has URLs (and thus RPC provider keys) removed, and so has the console output of the SDKs (`@x402/stellar` prints raw RPC errors with `console.*`; `src/console.ts` cuts every URL to its host before it is written).

Vulnerabilities: see [SECURITY.md](SECURITY.md). The adversarial review and its regression tests are summarised in [VERIFICATION.md](VERIFICATION.md).

## Roadmap

- **Whitechain mainnet**: enable the mainnet network entry with USDC.e once Whitechain publishes the chain id and the token is bridged ([docs/MAINNET.md](docs/MAINNET.md)).
- **Permit2 and `upto`**: Uniswap Permit2 is deployed on Whitechain Sepolia (`0x000000000022D473030F116dDEE9F6B43aC78BA3`); the x402 Permit2 proxies (`x402ExactPermit2Proxy` `0x402085c2…0001`, `x402UptoPermit2Proxy` `0x4020A4f3…0002`) are not yet. Their canonical addresses are reproducible there: the repository vendors the published init code, `npm run permit2:check` verifies the hashes and CREATE2 addresses against the deterministic deployer at `0x4e59b44847b379578588920cA78FbF26c0B4956C`, and `scripts/deploy-permit2-proxies.ts --broadcast` deploys them (a deliberate, manual step with a funded key). Once they exist the facilitator registers Permit2 `exact` and `upto` on that network automatically.
- **Fees**: the fee hook (basis points or flat, in the payment token) is implemented and off by default; mainnet operators can run sponsored or fee-funded.
- **Stellar mainnet** (`stellar:pubnet`): the code path is the same; it waits for a dedicated RPC endpoint, fee-payer accounts funded with real XLM and held in a key vault, and a small real-money test ([docs/MAINNET.md](docs/MAINNET.md#stellar-mainnet)).
- **Shared state**: Redis-backed rate limits, budgets and dedupe for multi-replica deployments (interfaces are already in place).

## FAQ

**How do I accept x402 payments on Whitechain?**
Run a standard x402 resource server (`@x402/express`, `@x402/hono` or `@x402/next`) and point its `HTTPFacilitatorClient` at `https://x402-facilitator-production-ff5f.up.railway.app`. In the route config use scheme `exact`, network `eip155:1874`, your wallet as `payTo`, and a price that names an EIP-3009 token (address, atomic amount, and the token's EIP-712 name and version). No contract deployment is needed.

**Does Whitechain support x402?**
Yes. x402 is chain-agnostic: it needs an EVM chain, a token with EIP-3009 `transferWithAuthorization`, and a facilitator that verifies and settles. Whitechain is an EVM OP Stack L2 with 1-second blocks, so the x402 `exact` scheme works there unchanged. This project is the facilitator; on Whitechain Sepolia the Inferit Test Credit (ITC) is the EIP-3009 test asset.

**Is there an x402 facilitator for WhiteBIT's Whitechain?**
Yes: this is the first public x402 v2 facilitator for Whitechain. It is an open-source project (Apache-2.0), built and run by Inferit; it is not an official WhiteBIT or Whitechain service. Anyone can use the hosted endpoint on testnet or self-host it.

**Do AI agents need WBT for gas to pay on Whitechain?**
No. The agent signs an EIP-3009 authorization off-chain and sends it in the `PAYMENT-SIGNATURE` header. The facilitator submits `transferWithAuthorization` and pays the WBT gas. The agent only needs a balance of the token being charged, such as ITC on Whitechain Sepolia.

**Which tokens can be used for x402 payments on Whitechain?**
Any ERC-20 that implements EIP-3009 with a FiatToken-style EIP-712 domain: ITC on Whitechain Sepolia, and bridged USDC.e on mainnet once configured. Other ERC-20s can be charged through Uniswap Permit2 where the x402 Permit2 proxy contracts exist on the network.

**How much does the Whitechain x402 Facilitator cost?**
The public testnet facilitator is free: it sponsors the gas for every settlement within per-IP, per-payer and per-merchant rate limits and a daily gas budget. For mainnet the software has a fee hook (percentage or flat, in the payment token) that is off by default, so an operator can run it sponsored or fee-funded.

**Does the facilitator hold my funds?**
No. An x402 `exact` payment is a single on-chain transfer from the payer directly to the merchant's `payTo` address. The facilitator checks the signature and balance, submits the signed authorization and pays gas. It cannot redirect, hold or reverse funds, and it never sees the payer's private key.

**Can I self-host the Whitechain x402 Facilitator?**
Yes. It is Apache-2.0 licensed, ships a Dockerfile, and is configured through environment variables: `FACILITATOR_PRIVATE_KEY` for the gas wallet, `NETWORKS` as JSON for chain id, RPC and explorer, plus rate limits, gas budgets, API keys and a denylist file. See [Self-hosting](#self-hosting).

**How do I pay a Whitechain x402 API from an AI agent?**
Wrap `fetch` with `@x402/fetch`, register `ExactEvmScheme` for `eip155:1874` with a viem account, and allow the Whitechain token in `spendControls.allowedAssets` with a per-payment cap. The wrapper reads the 402, signs the EIP-3009 authorization and retries with the payment header automatically.

**Does it support Stellar?**
Yes, on Stellar testnet when self-hosted with `STELLAR_FACILITATOR_KEY` set. Merchants and agents use the official `@x402/stellar` server and client schemes with network `stellar:testnet`; the payer signs a Soroban authorization for one token `transfer` and the facilitator pays the XLM fee. See [docs/STELLAR.md](docs/STELLAR.md).

**Is this an official Whitechain or WhiteBIT product?**
No. Inferit builds and runs it. Whitechain and WhiteBIT are trademarks of their owners, used here only to describe compatibility. The project is not affiliated with, sponsored by or endorsed by Whitechain, WhiteBIT, Coinbase, Circle or the x402 Foundation.

## Built by

[Sahil Massey](https://github.com/OGcryptonaut) at **Inferit**, where x402 on Whitechain already pays for open-weight LLM inference per request. The facilitator was split out so any merchant and any agent can use it.

- Design, API, operations, mainnet: [docs/](docs)
- Examples: [examples/](examples)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Changelog: [CHANGELOG.md](CHANGELOG.md) · Security: [SECURITY.md](SECURITY.md)
- x402 protocol: https://x402.org · reference implementation: https://github.com/x402-foundation/x402
- Whitechain: https://whitechain.io · explorer: https://explorer.testnet.whitechain.io

## Licence and trademarks

Copyright 2026 Sahil Massey and contributors. Licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE).

Whitechain and WhiteBIT are trademarks of their respective owners. x402 is a protocol stewarded by the x402 Foundation. USDC is a trademark of Circle. These names are used only to describe compatibility; this project is not affiliated with, sponsored by or endorsed by any of them. Testnet tokens have no monetary value.
