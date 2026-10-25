# Stellar

The facilitator settles x402 payments on Stellar testnet (`stellar:testnet`) next to Whitechain. It uses the official `@x402/stellar` package (2.28) for verification and settlement, and wraps it in the same policy as the EVM path: rate limits, daily fee budgets, sanctions screening, replay protection and API keys, each applied per network.

Stellar is off until you set `STELLAR_FACILITATOR_KEY`. With it unset, nothing about the Whitechain service changes.

## How a Stellar payment works

1. The merchant's 402 names `scheme: "exact"`, `network: "stellar:testnet"`, a token contract as `asset` (a C… address, for example a Stellar Asset Contract), an atomic `amount` and a `payTo` (G…, C… or M…). `@x402/stellar`'s server scheme adds `extra.areFeesSponsored: true` from this facilitator's `/supported`.
2. The agent's `@x402/stellar` client builds one Soroban call, `transfer(payer, payTo, amount)` on the token contract, and signs only the **authorization entry** for it, valid until a ledger about `maxTimeoutSeconds` ahead. The payload is `{ "transaction": "<base64 transaction envelope>" }`. The agent needs no XLM.
3. `/verify`: after the policy gates, the SDK checks the transaction is exactly that one `transfer` with the right asset, recipient and amount, simulates it, checks the simulation emits exactly one matching transfer event, and checks the payer's signature and its expiry, that no other signature is pending, and that no facilitator account is the payer, the transaction source or an authorizer.
4. `/settle`: the SDK verifies again, then rebuilds the transaction with one of the facilitator's **fee-payer accounts** as source, signs it, submits it and waits for the ledger. The token moves payer → `payTo` directly; the fee-payer account pays the network fee (about 0.001 XLM on testnet).

The facilitator never holds the payment and cannot change it: the transfer arguments are inside the payer's signed authorization entry.

## Enable it

```sh
STELLAR_FACILITATOR_KEY=S...            # one Stellar secret seed, or several separated by commas
# optional, these are the defaults:
STELLAR_NETWORKS='[{"id":"stellar:testnet","rpc":"https://soroban-testnet.stellar.org","explorer":"https://stellar.expert/explorer/testnet","maxFeeStroops":50000,"inclusionFeeStroops":100,"maxTimeoutSeconds":300}]'
STELLAR_FEE_BUDGET_GLOBAL_DAILY=50       # XLM per UTC day, all merchants
STELLAR_FEE_BUDGET_PER_PAYTO_DAILY=5     # XLM per UTC day, per payTo
STELLAR_RATE_LIMIT_GLOBAL_PER_WINDOW=300 # Stellar verify+settle calls per RATE_LIMIT_WINDOW_SECONDS; 0 disables
STELLAR_SETTLE_QUEUE_TIMEOUT_MS=30000    # wait for a free fee-payer account before answering facilitator_busy
```

Create and fund a fee-payer account (testnet XLM comes from friendbot):

```sh
node -e 'const { Keypair } = require("@stellar/stellar-sdk"); const k = Keypair.random(); console.log(k.publicKey()); require("fs").writeFileSync(".stellar-signer.key", k.secret(), { mode: 0o600 })'
# .stellar-signer.key is git- and docker-ignored (*.key); move the secret to your secret store, then delete the file.
curl -s "https://friendbot.stellar.org/?addr=G...the-printed-address"
```

Put the secret in `STELLAR_FACILITATOR_KEY` through your secret store; it is kept out of logs, `/health`, `/metrics` and `describeConfig` like the EVM key. At start the log prints the fee-payer address(es), and `GET /supported` lists them under `signers["stellar:*"]`.

`STELLAR_NETWORKS` fields: `id` (only `stellar:testnet` in this release), `name`, `rpc` (Soroban RPC, http(s); use one endpoint, see below), `explorer`, `assets` (optional allowlist of C… contracts), `maxFeeStroops` (refuse a payment whose settlement fee would exceed this; also the per-settle budget reservation), `inclusionFeeStroops` (bid on top of the resource fee), `maxTimeoutSeconds` (largest `maxTimeoutSeconds` a merchant may ask for).

## Merchant

```ts
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

const facilitator = new HTTPFacilitatorClient({ url: "https://your-facilitator.example" });
const server = new x402ResourceServer(facilitator).register("stellar:testnet", new ExactStellarScheme());

const app = express();
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          network: "stellar:testnet",
          payTo: "G...YourMerchantAccount",
          price: { asset: "C...TokenContract", amount: "100000" }, // 0.01 of a 7-decimal token
          maxTimeoutSeconds: 60,
        },
        description: "Current weather, paid per request on Stellar",
        mimeType: "application/json",
      },
    },
    server,
  ),
);
app.get("/weather", (_req, res) => res.json({ city: "Lisbon", temperatureC: 24 }));
app.listen(4021);
```

The same `routes` work with `@x402/hono` and `@x402/next`, and one route can list a Whitechain option and a Stellar option side by side in `accepts`. `price: "$0.01"` uses the SDK's default testnet USDC contract; to price in another token, register a money parser on `ExactStellarScheme` (as in [API.md](API.md#pricing-in-dollars) for EVM).

A G… `payTo` must hold a trustline to a classic asset before it can receive it (`changeTrust`); C… contract accounts need none.

## Agent

```ts
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactStellarScheme, createEd25519Signer } from "@x402/stellar";

const signer = createEd25519Signer(process.env.AGENT_STELLAR_SECRET!, "stellar:testnet");
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "stellar:testnet", client: new ExactStellarScheme(signer) }],
  spendControls: { allowedAssets: [{ network: "stellar:testnet", asset: "C...TokenContract", maxAmountPerPayment: "1000000" }] },
});
const res = await fetchWithPayment("https://api.example.com/weather");
const receipt = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
console.log(`https://stellar.expert/explorer/testnet/tx/${receipt.transaction}`);
```

The agent account needs the token (and its trustline, for a classic asset) and no XLM beyond the account's minimum balance.

## Assets and amounts

- Any token contract with the standard `transfer(from, to, amount)` interface (SEP-41) works; every classic Stellar asset has one, its Stellar Asset Contract. Native XLM's contract on testnet is `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`; Circle's testnet USDC is `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`.
- Stellar Asset Contracts use **7 decimals**: `amount: "10000000"` is one unit.
- Stellar addresses are case-sensitive strkeys with a checksum. The facilitator keeps them exactly as given everywhere (denylist, API-key `payTo` lists, rate-limit keys, metrics); a lower-cased address is invalid and refused.
- `exact` on Stellar means exact: the transferred amount must equal `amount`.

## Policy, per network

| Guard | On Stellar |
| --- | --- |
| Rate limits | The same `RATE_LIMIT_*` buckets, keyed per network: a caller, payer or `payTo` has separate buckets on Stellar and on Whitechain. All M… muxed addresses of one account share that account's bucket and budget. `STELLAR_RATE_LIMIT_GLOBAL_PER_WINDOW` is the Stellar ceiling (each verify is a simulation plus ledger reads; each settle adds a submission and up to `maxTimeoutSeconds` confirmation polls). |
| Daily budgets | In XLM, per network: global (`STELLAR_FEE_BUDGET_GLOBAL_DAILY`), per `payTo` (`STELLAR_FEE_BUDGET_PER_PAYTO_DAILY`), or per API key (`dailyStellarFeeBudget` in `API_KEYS`). A settle reserves `maxFeeStroops` and is charged the real fee from the transaction result. Reason: `gas_budget_exceeded`. |
| Denylist | Same file: one address per line, EVM or Stellar (G…, C…, M…). Payer and `payTo` are screened; an M… muxed `payTo` is also screened through the G… account that owns it. |
| Replay | The Soroban authorization nonce: `network | payer | nonce`. A concurrent second settle of the same authorization is `duplicate_settlement` (409); a settled one stays refused, and the chain rejects a reused nonce in any case. |
| API keys | `payTo` restrictions accept Stellar addresses; a key restricted to a G… account may also settle to its M… muxed addresses. |
| Asset allowlist | `STELLAR_NETWORKS[].assets` (C… contracts, exact match). |
| Timeouts | `maxTimeoutSeconds` must be between 1 and the network's `maxTimeoutSeconds` (default 300), because the SDK keeps the authorization valid and polls for confirmation that long. |
| Zero amounts | Refused (`invalid_request`): the facilitator does not pay fees for empty transfers. |
| Fee-payer balance | Each settle needs a fee-payer account that can spend `maxFeeStroops` above its minimum balance: a leased account that cannot is swapped for another idle one that can, and only when none can is the answer `facilitator_out_of_gas` (503). `/health` lists accounts that cannot pay one settlement under `unfundedFeePayers` (and sets `lowBalance`). |

## Fee-payer accounts and throughput

A Stellar transaction carries its source account's next sequence number, and two settlements from the same account inside one ledger (about 5 s) would clash. The facilitator therefore leases each fee-payer account to one settlement at a time, from build to confirmation. With one key, settlements on Stellar run one after another (each takes about one ledger); with N keys, N run at once. When every account is busy, a settle waits up to `STELLAR_SETTLE_QUEUE_TIMEOUT_MS`, then answers `facilitator_busy` (503, `Retry-After: 5`). Verification is not limited this way. Add keys to `STELLAR_FACILITATOR_KEY` (comma-separated, each funded) to raise throughput.

## Outcomes the SDK cannot see

`@x402/stellar` reports a failure when it stops polling, even if the transaction lands a moment later. The facilitator checks the transaction itself before answering:

- landed: the answer is `success: true` with the hash;
- failed on chain: `success: false` with the hash; the fee is charged to the budget and the authorization stays usable (a failed transaction does not consume the nonce);
- not landed, and the authorization has expired: `success: false`, no fee charged;
- still undecided: `settlement_pending` with the hash. A retry with the same payment checks that hash first and answers success without submitting again if it landed.

The SDK learns the hash only from `sendTransaction`'s answer. When that call fails after the RPC may have forwarded the transaction (a 502/504 from a load balancer, a reset), it reports no hash; the fee payer's signer records the hash of what it signed, and the facilitator checks that hash exactly as above.

Every request to the Stellar RPC and to Horizon is bounded (20 s per call): `@stellar/stellar-sdk` sets no timeout, its `rpc.Server` ignores a `timeout` option, and `@x402/stellar` builds its own clients for each verify and settle. A stalled RPC therefore holds a fee-payer lease for bounded time; it never holds the process start or `/health` (each waits at most 5 s for a Stellar probe and reports `rpcOk: false`).

## Reason codes

Facilitator codes are the same as on Whitechain ([API.md](API.md#reason-codes)), plus `facilitator_busy` (503). Payment verdicts come from `@x402/stellar` with HTTP 200, for example `invalid_exact_stellar_payload_wrong_amount`, `invalid_exact_stellar_payload_wrong_recipient`, `invalid_exact_stellar_payload_wrong_asset`, `invalid_exact_stellar_payload_simulation_failed` (insufficient balance, missing trustline, reused nonce), `invalid_exact_stellar_signature_expiration_too_far`, `invalid_exact_stellar_payload_missing_payer_signature`, `invalid_exact_stellar_payload_fee_exceeds_maximum`, `settle_exact_stellar_transaction_failed`.

## Health and metrics

`GET /health` adds one entry per Stellar network to `networks`: `network`, `feePayers`, `rpcOk`, `latestLedger`, `feeBalances` (spendable XLM per fee-payer account), `settleRunway` (spendable XLM ÷ `maxFeeStroops`), `lowBalance`, `settlementSlots` (`total`, `busy`, `waiting`) and the fee budget state. `GET /metrics` adds a `stellar` section: fees spent per network (stroops), transaction count, pending broadcasts, budget state and slot usage. Verify and settle counters and reasons are shared with the EVM path.

## Limits of this release

- A payment can pass simulation and still fail on chain, for example when the payer moves the funds or the authorization expires before the ledger closes. The fee is then lost, capped by `maxFeeStroops` per settlement and counted against the daily budgets, as with a reverted transfer on Whitechain.
- Testnet only. `stellar:pubnet` is refused by the configuration; [MAINNET.md](MAINNET.md#stellar-mainnet) lists what it needs.
- `exact` only. Stellar has no `upto` in `@x402/stellar` 2.28, so a metered API charges a fixed price per request.
- Use one Soroban RPC endpoint for verify and settle. Public endpoints behind a load balancer can answer from nodes at different ledgers and make valid payments fail simulation.
- `@x402/stellar` estimates ledger time from Horizon's public testnet endpoint (falling back to 5 s), and writes some diagnostics to the console instead of the structured log. They carry raw RPC errors, so the process filters console output (`src/console.ts`): every URL is cut to its host before it is written, and a provider key in a keyed RPC URL's path or query never reaches the container log.
- `@stellar/stellar-sdk` is pinned to 16.4.1 (also through `overrides`) for its security fix ahead of the next `@x402/stellar` release.

## Try it

```sh
npm run smoke:stellar        # throwaway accounts and asset, in-process facilitator, official middleware and client
npm run test:stellar-live    # the same through @x402/express and @x402/hono, plus concurrency and a refused payment
```

Both create fresh friendbot-funded accounts and a fresh classic asset with its Stellar Asset Contract, so they need nothing but internet access. `npm test` covers the Stellar policy offline (`test/unit/stellar.test.ts`, `test/interop/stellar-policy.test.ts`, `test/interop/stellar-settlement-accounting.test.ts`).
