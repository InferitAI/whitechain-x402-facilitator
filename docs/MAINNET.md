# Whitechain mainnet

Nothing in the facilitator is testnet-only. This page is the checklist for serving Whitechain mainnet, and what is still unknown until Whitechain publishes the details.

## What is needed

| Item | Status | Where it goes |
| --- | --- | --- |
| Mainnet chain id | published by Whitechain at mainnet launch of the OP Stack L2 | `NETWORKS[].id` as `eip155:<id>` |
| Public RPC and explorer URLs | published with the chain id | `NETWORKS[].rpc`, `NETWORKS[].explorer` |
| An EIP-3009 settlement token | USDC.e bridged through the Whitechain Portal (Circle FiatToken interface, 6 decimals) | merchants' `price.asset`; optionally `NETWORKS[].assets` allowlist |
| The token's EIP-712 domain | read `eip712Domain()` or `name()` / `version()` on the deployed contract; FiatToken v2 is `USD Coin` / `2` | merchants' `price.extra` |
| WBT for gas | buy on WhiteBIT or bridge via the Portal | the signer wallet |
| x402 Permit2 proxies (optional) | not deployed yet; see below | enables Permit2 `exact` and `upto` for any ERC-20 |

## Configuration

```sh
NETWORKS='[
  { "id": "eip155:1874", "name": "Whitechain Sepolia",
    "rpc": "https://rpc.testnet.whitechain.io", "explorer": "https://explorer.testnet.whitechain.io", "testnet": true },
  { "id": "eip155:<MAINNET_CHAIN_ID>", "name": "Whitechain",
    "rpc": "https://<mainnet-rpc>", "explorer": "https://<mainnet-explorer>", "testnet": false,
    "assets": ["0xUSDCe_ADDRESS"],
    "confirmationTimeoutMs": 45000 }
]'
GAS_BUDGET_GLOBAL_DAILY=0.5
GAS_BUDGET_PER_PAYTO_DAILY=0.05
REQUIRE_API_KEY=false
FEE_MODE=off
```

Recommendations that differ from testnet:

- **Allowlist assets** on mainnet. On testnet any EIP-3009 token is accepted; on mainnet restrict to tokens you are willing to sponsor so nobody can make you pay gas for transfers of a worthless token.
- **Budget in real money.** Set the daily budgets to what you would accept losing to abuse in a day, and watch `metrics.policy.gasBudgetExceeded` before raising them.
- **Keys for volume.** Keep the keyless path open with low limits for discovery, and hand out API keys with dedicated budgets to merchants you have a relationship with. `REQUIRE_API_KEY=true` turns the service into an allowlisted facilitator, which also removes the only way a stranger can cost you gas (a token that lies to the simulation).
- **Size the RPC ceiling.** `RATE_LIMIT_GLOBAL_PER_WINDOW` (default 1,200 calls per minute, each fanning out into several JSON-RPC requests) should match what your RPC plan allows; a dedicated endpoint with a key in its URL is fine, the URL is never logged or returned.
- **Separate signer per environment.** Never share the testnet signer key with mainnet.

## Charging for sponsorship

The `exact` scheme moves funds payer to payTo directly, so a facilitator cannot take a cut on chain. What it can do is decide whether to sponsor and account for what it is owed:

- `FEE_MODE=off` (default): sponsor everything, record nothing.
- `FEE_MODE=accrue` with `FEE_BPS` (basis points of the payment amount) and/or `FEE_FLAT_ATOMIC` (in the payment token's atomic units): sponsor everything and accrue `flat + amount * bps / 10000` per successful settlement, grouped by API key (or `payTo` when no key), visible under `fees.accrued` in `/metrics`. Bill merchants from that, or replace `FeePolicy` in `src/policy/fee.ts` with one that calls your billing system and refuses (`fee_policy_rejected`) when an account is overdue.

Other models that fit the hook without protocol changes: a sponsor (for example an ecosystem fund) covering gas for everyone; per-merchant prepaid gas budgets expressed as API keys with `dailyGasBudget`; or a resource server that adds its own fee to the price it asks the agent for.

## Permit2 and `upto`

Uniswap Permit2 is deployed on Whitechain Sepolia at `0x000000000022D473030F116dDEE9F6B43aC78BA3`, and the Arachnid deterministic deployer at `0x4e59b44847b379578588920cA78FbF26c0B4956C` exists there too. The x402 Permit2 proxy contracts (`x402ExactPermit2Proxy`, `x402UptoPermit2Proxy`) are **not** deployed on Whitechain. Their canonical addresses (`0x402085c248EeA27D92E8b30b2C58ed07f9E20001` and `0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002`) come from `CREATE2` through that deployer with the init code and salt published in the x402 repository. `scripts/data/*.hex` vendors that init code, `npm run permit2:check` asserts its hashes and the resulting addresses and reports what exists on the network, and `tsx scripts/deploy-permit2-proxies.ts --broadcast` (with `RPC_URL` and a `DEPLOYER_PRIVATE_KEY` holding a little gas) deploys the missing ones. The addresses are reproducible on Whitechain Sepolia; the deployment is a manual, reviewed step.

Once the proxies exist on a network (deployed by the x402 Foundation, Whitechain, or anyone reproducing them through the deployer), the facilitator registers Permit2-based `exact` and `upto` on that network automatically at the next probe (`PROXY_PROBE_MINUTES`), and `/supported` advertises them. That unlocks any ERC-20 (one-time Permit2 approval by the payer) and the `upto` scheme (authorize a maximum, settle what was used), which suits metered APIs such as LLM inference.

Do not run the deployment script against a public network from this repository's CI or a shared machine; it is a one-off, deliberately manual step that needs a funded key and a review of the init code against the x402 release it came from.

## Stellar mainnet

This release accepts `stellar:testnet` only; the configuration refuses `stellar:pubnet` on purpose, and the hosted facilitator stays on testnet. The code path is the same. This section is what a mainnet operator needs, with the numbers measured on mainnet.

### What a USDC payment costs in fees (measured 2026-11-01)

Measured with `simulateTransaction` on Stellar mainnet (protocol 29, ledger 65251960), read-only: a transfer of mainnet USDC through its Stellar Asset Contract (`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`, which reports `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`, 7 decimals) between two accounts that hold a USDC trustline. Four public RPC providers returned the same numbers.

| Shape | Resource fee | CPU instructions | Footprint (read-only / read-write) | Write bytes |
| --- | --- | --- | --- | --- |
| x402 `exact`: the fee payer is the transaction source, the payer authorizes the transfer with its own signature | **125,409 stroops** (0.0125409 XLM) | 760,878 | 2 / 3 | 396 |
| For comparison: the payer is the transaction source | 12,097 stroops | 242,275 | 1 / 2 | 320 |

- The amount does not change the fee: $0.01 and $2 transfers both simulate at 125,409 stroops.
- Most of the difference between the two shapes is the payer's authorization. A signer that is not the transaction source adds a nonce ledger entry and signature checks to every payment. That is the x402 shape, so plan on about 125,000 stroops per settlement.
- The inclusion fee comes on top. `getFeeStats` showed Soroban inclusion fees of 100 to 200 stroops (p99 200) at the time of measurement; it rises under surge pricing.
- So one settlement costs about 125,600 stroops (0.0126 XLM) on a quiet network. A 10 XLM daily budget covers about 790 settlements.
- The facilitator simulates every payment during verify and refuses it when the fee would exceed `maxFeeStroops`, so the fee it pays comes from the network at that moment, not from this table. Resource fees follow the network's settings, which validators can change by vote; measure again before relying on these numbers.

**The testnet default `maxFeeStroops` (50,000) is below the mainnet fee.** With it, every mainnet USDC settlement would be refused. On `stellar:pubnet` set `maxFeeStroops` to at least 150,000; 500,000 leaves room for an inclusion-fee surge. Each settle reserves `maxFeeStroops` against the daily budgets and the fee-payer balance, so a higher cap also means a fee payer needs more spendable XLM per settle.

To measure again: build the `transfer(from, to, amount)` call with the fee payer as source, run `simulateTransaction` against your RPC and read `minResourceFee`. Nothing is signed or submitted.

### Mainnet RPC providers (checked 2026-11-01)

Each endpoint below was called with `getHealth`, `getNetwork` and the USDC transfer simulation above; the endpoints that answered reported the passphrase `Public Global Stellar Network ; September 2015` and protocol 29. The provider list comes from Stellar's documentation (developers.stellar.org, Data, RPC providers).

| Provider | Endpoint | Access | Result |
| --- | --- | --- | --- |
| Lightsail Network (Quasar) | `https://rpc.lightsail.network/` | Public, no key | Healthy, 7-day retention window (120,960 ledgers), simulation 125,409 stroops. Archive endpoint `https://archive-rpc.lightsail.network/` answers too (archive supports `getLedgers` only) |
| Gateway.fm | `https://soroban-rpc.mainnet.stellar.gateway.fm` | Public, no key | Healthy, simulation 125,409 stroops |
| sorobanrpc.com | `https://mainnet.sorobanrpc.com` | Public, no key | Healthy, simulation 125,409 stroops |
| Ankr | `https://rpc.ankr.com/stellar_soroban` | Public, no key | Healthy, simulation 125,409 stroops |
| Validation Cloud | `https://mainnet.stellar.validationcloud.io/v1/<API_KEY>` | Key in the URL; dedicated nodes available | Host answers `401 missing api key` without one; not exercised further |
| OnFinality | `https://stellar.api.onfinality.io/public` | Needs a key in practice | Unauthenticated calls got 429 and 504 |
| Nodies | `https://stellar-soroban-public.nodies.app` | Listed as public | `404 Unsupported path` at the listed URL; not usable as listed |

Providers with keyed or dedicated plans that were not checked: Blockdaemon, QuickNode, NowNodes, Obsrvr, InfStones, Alchemy, GetBlock, Uniblock, Exaion, node101.

For settlement, use one keyed or dedicated endpoint (Validation Cloud, or a paid plan at one of the others) and keep a public one (Lightsail, Gateway.fm) as the fallback you switch to by configuration. Public endpoints sit behind load balancers, and nodes at different ledgers can fail a valid payment's simulation. A key in the RPC URL is fine: the facilitator never logs or returns the URL.

### Before enabling `stellar:pubnet`

| Item | Why |
| --- | --- |
| A dedicated Soroban RPC endpoint, used for verify and settle (see the provider table) | Public RPCs behind a load balancer can answer from nodes at different ledgers, and valid payments then fail simulation |
| `maxFeeStroops` of at least 150,000 (500,000 recommended) and an `inclusionFeeStroops` that gets Soroban transactions included under load (10,000 leaves headroom) | The measured resource fee is 125,409 stroops. The testnet default cap (50,000) refuses every mainnet settlement, and the 100-stroop bid can leave transactions waiting under load |
| An asset allowlist (`assets`) with mainnet USDC (`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`) | Do not pay fees for transfers of arbitrary tokens |
| Fee-payer accounts funded with real XLM, keys in a vault, never shared with testnet | Blast radius is the XLM in them |
| Daily fee budgets sized from the measured fee (`STELLAR_FEE_BUDGET_GLOBAL_DAILY`, `STELLAR_FEE_BUDGET_PER_PAYTO_DAILY`) | About 0.0126 XLM per settlement; 10 XLM a day is about 790 settlements |
| `@stellar/stellar-sdk` 16.4.1 or later (pinned through `overrides` until `@x402/stellar` ships it) | SDK security fix |
| Monitoring on `settleRunway` and `settlementSlots`, and a small real-money end-to-end run | As for Whitechain |

Then allow `stellar:pubnet` in `StellarNetworkConfigSchema` (`src/config.ts`) with its passphrase (`Public Global Stellar Network ; September 2015`), and add the network to `STELLAR_NETWORKS` with the RPC URL:

```sh
STELLAR_NETWORKS='[{"id":"stellar:pubnet","name":"Stellar","rpc":"https://<dedicated-rpc>","explorer":"https://stellar.expert/explorer/public","assets":["CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"],"maxFeeStroops":500000,"inclusionFeeStroops":10000,"maxTimeoutSeconds":300}]'
```

An alternative for mainnet is to point merchants at a hosted Stellar facilitator and keep this one as the fallback.

## Checklist before announcing mainnet

- [ ] `NETWORKS` entry added with the published chain id; `npm run permit2:check` and `GET /health` show `rpcOk: true`.
- [ ] USDC.e address and EIP-712 domain verified against the deployed contract; documented in README's token table.
- [ ] Signer funded; `settleRunway` comfortably above a day of expected settles; alerting on `/health` in place.
- [ ] `npm run smoke:sepolia`-style end-to-end run on mainnet with a real agent and merchant, transaction linked in the release notes.
- [ ] Budgets, limits and (if any) fee mode decided and written into CHANGELOG.
- [ ] Denylist refreshed and scheduled.
- [ ] Site and README updated: mainnet row in the networks table, `upto` status, facilitator URL.
