# Operations

Running the Whitechain x402 Facilitator as a public service: funding, budgets, limits, keys, the sanctions denylist, monitoring and what to do when something goes wrong.

## 1. The wallet

The facilitator needs one EOA, the **signer**, whose only job is to pay gas for `transferWithAuthorization` calls. It never holds tokens and has no approvals, so its compromise costs at most the WBT in it.

1. Generate a fresh key and never reuse it elsewhere:
   ```sh
   node -e 'const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts"); const k = generatePrivateKey(); console.log(privateKeyToAccount(k).address); require("fs").writeFileSync(".signer.key", k, { mode: 0o600 })'
   ```
   Put the key in `FACILITATOR_PRIVATE_KEY` through your platform's secret store (Railway/Fly/Render secrets, Docker secrets, a `.env` file with mode 600). Never commit it; `.gitignore` excludes `.env*`.
2. Fund the address with WBT:
   - Whitechain Sepolia: https://faucet.testnet.whitechain.io (test WBT).
   - Mainnet: send WBT from WhiteBIT or bridge through the Whitechain Portal.
3. Check `GET /health`: `networks[].gasBalance` and `settleRunway`.

Sizing: a settlement is roughly 60-120k gas. At the testnet's ~5 gwei that is about 0.0003-0.0006 WBT per settlement; `settleRunway` in `/health` does this arithmetic for you at the current `maxFeePerGas`. Keep at least a day of expected volume plus the global daily budget in the wallet.

Rotation: start a new instance with the new key (or restart with the env changed). `GET /supported` immediately advertises the new signer; resource servers pick it up on their next `/supported` sync (restart them, or wait for their periodic refresh). Pending settlements signed by the old key still confirm.

### Stellar fee-payer accounts

With `STELLAR_FACILITATOR_KEY` set, one or more Stellar accounts pay the network fee of each Stellar settlement (about 0.001 XLM on testnet). They hold XLM only.

1. Generate one key per account (`Keypair.random()` from `@stellar/stellar-sdk`; see [STELLAR.md](STELLAR.md#enable-it)) and fund it: on testnet `curl "https://friendbot.stellar.org/?addr=G…"` gives 10,000 test XLM.
2. Put the secret seed(s) in `STELLAR_FACILITATOR_KEY`, comma-separated. Each account settles one payment at a time, so the number of keys is the number of Stellar settlements in flight.
3. Check `GET /health`: the Stellar entry's `feeBalances`, `settleRunway` and `settlementSlots`.

Rotation works as for the EVM key: restart with the new seed(s); `/supported` lists the new accounts under `signers["stellar:*"]`.

## 2. Budgets and limits

| Setting | Default | What it protects |
| --- | --- | --- |
| `GAS_BUDGET_GLOBAL_DAILY` | `1` WBT | The most the service will spend on gas in a UTC day, over all merchants |
| `GAS_BUDGET_PER_PAYTO_DAILY` | `0.1` WBT | One merchant cannot consume the whole global budget |
| `MAX_SETTLE_GAS` | `300000` | A single malicious or broken token cannot burn a large transaction |
| `SETTLE_GAS_ESTIMATE` | `120000` | Reservation per settle until the receipt reports the real cost |
| `RATE_LIMIT_IP_PER_WINDOW` | `120` / 60 s | One resource server (or one attacker) cannot flood verify |
| `RATE_LIMIT_PAYER_PER_WINDOW` | `30` / 60 s | One payer cannot grind nonces or balances |
| `RATE_LIMIT_PAYTO_PER_WINDOW` | `120` / 60 s | One merchant cannot monopolise throughput |
| `RATE_LIMIT_GLOBAL_PER_WINDOW` | `1200` / 60 s | Many callers together cannot exhaust the RPC quota (each admitted call fans out into several RPC requests); `0` disables |
| `HEALTH_CACHE_SECONDS` | `10` | `/health` is unauthenticated; one probe serves every poll in the window |
| `LOW_RUNWAY_SETTLES` | `50` | `/health` turns degraded in time to top up |

Budgets are in native units as decimals (`0.25` = 0.25 WBT). An empty string disables that budget. The day rolls at 00:00 UTC; `/health` and `/metrics` show `resetsInSeconds`.

How the budget behaves under load: a settle first *reserves* `SETTLE_GAS_ESTIMATE * maxFeePerGas` under every scope it touches (global, `payto:<address>`, `apikey:<name>`). On receipt the reservation becomes the real `gasUsed * effectiveGasPrice`; if nothing was broadcast it is released. Concurrent settles therefore cannot overshoot a budget by more than one estimate.

Stellar has its own budgets in XLM, per network: `STELLAR_FEE_BUDGET_GLOBAL_DAILY` (`50`) and `STELLAR_FEE_BUDGET_PER_PAYTO_DAILY` (`5`), an API key's `dailyStellarFeeBudget`, and the per-settlement cap `maxFeeStroops` (default 50,000 stroops = 0.005 XLM, also the reservation). The `RATE_LIMIT_*` buckets apply with per-network keys, and `STELLAR_RATE_LIMIT_GLOBAL_PER_WINDOW` (`300`) bounds Soroban RPC fan-out. Watch `settlementSlots.waiting` in `/health` and `facilitator_busy` in `metrics.settle.byReason`: either means it is time to add a fee-payer key.

Tuning for your traffic: start with the defaults, watch `metrics.policy.gasBudgetExceeded` and `metrics.policy.rateLimited`; raise per-payTo limits for merchants you know by giving them an API key rather than raising the global defaults.

## 3. Merchant API keys

Keys raise limits; they are never required on the public testnet (`REQUIRE_API_KEY=false`). Configure them as JSON:

```sh
API_KEYS='[
  { "name": "weather-inc", "keySha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "rateLimitMultiplier": 20, "dailyGasBudget": "0.5", "payTo": ["0xWeatherIncAddress"] },
  { "name": "staging", "key": "a-long-random-string-at-least-16-chars", "rateLimitMultiplier": 5 }
]'
```

- Generate a key: `openssl rand -base64 32`. Give the merchant the key; store only its digest: `printf '%s' "$KEY" | shasum -a 256`.
- `rateLimitMultiplier` multiplies the per-IP limit for calls carrying the key and the payer/payTo limits for payments it settles (default 10).
- `dailyGasBudget` replaces the per-payTo budget for that key's settlements (still capped by the global budget).
- `payTo` restricts the key to those merchant addresses; a settle to any other `payTo` is refused with `invalid_api_key`.
- Revoke by removing the entry and restarting.

Requests for keys on the public facilitator arrive through the "Merchant API key request" issue template; send the key out of band, never in the issue.

## 4. Sanctions denylist

`DENYLIST_FILE` (default `denylist.txt`, one `0x` address per line, `#` comments allowed) is checked against the payer and the `payTo` of every verify and settle. A match is refused with `address_denylisted`. The file is re-read whenever its modification time changes (polled every `DENYLIST_RELOAD_SECONDS`), so updating it needs no restart.

Source: the U.S. Treasury OFAC Specially Designated Nationals (SDN) list, which includes digital-currency addresses tagged `Digital Currency Address - ETH` (and other chains). The list is public at https://sanctionslist.ofac.treas.gov/ (also published as `SDN.XML` / `SDN_ADVANCED.XML` and CSV). `npm run denylist:ofac` downloads the current list, extracts the EVM addresses, and writes `denylist.txt`; run it on a schedule (daily is plenty; OFAC updates a few times a month):

```sh
# cron, daily at 03:15 UTC
15 3 * * * cd /srv/facilitator && npm run denylist:ofac >> /var/log/facilitator-denylist.log 2>&1
```

The script overwrites its output file (`OUT`, default `denylist.txt`; `OFAC_SDN_URL` overrides the source) and refuses to write an empty list. To keep your own entries, generate the OFAC part into a separate file and concatenate: `OUT=denylist.ofac.txt npm run denylist:ofac && cat denylist.ofac.txt denylist.local.txt > denylist.txt`. Any other screening provider can be plugged in by implementing `AddressScreener` in `src/policy/denylist.ts`.

The denylist is a compliance aid, not legal advice. Operators are responsible for the screening obligations that apply to them.

## 5. Deployment

### Docker

```sh
docker build -t whitechain-x402-facilitator .
docker run -d --name facilitator -p 8402:8402 \
  -e FACILITATOR_PRIVATE_KEY=0x... \
  -e TRUST_PROXY=1 \
  -e GAS_BUDGET_GLOBAL_DAILY=1 \
  -v $(pwd)/denylist.txt:/app/denylist.txt:ro \
  whitechain-x402-facilitator
```

The image runs as a non-root user, listens on `8402`, and reads `site/landing.html` from the image for `GET /`.

### Behind a reverse proxy

Terminate TLS in front (Caddy, nginx, the platform's proxy) and set `TRUST_PROXY` to the number of proxy hops. Without it every request looks like it comes from the proxy and the per-IP limit becomes a shared limit. Only set it when the service is reachable *solely* through that proxy: `TRUST_PROXY=true` believes any `X-Forwarded-For` header, so a client that can reach the port directly could spoof its address and sidestep the per-IP bucket (the facilitator-wide ceiling and the budgets still apply). Keep the proxy's request timeout above `CONFIRMATION_TIMEOUT_MS` (default 60 s) plus a margin, or set `CONFIRMATION_TIMEOUT_MS` below the platform's limit so a slow settlement is reported as `settlement_pending` instead of a cut connection.

### Platforms

Railway, Fly.io, Render and similar work from the Dockerfile with the environment variables as secrets. Serverless platforms with short request deadlines (10-30 s) need `CONFIRMATION_TIMEOUT_MS` below that deadline; Whitechain's 1-second blocks normally confirm well within it.

### Multiple networks

```sh
NETWORKS='[
  { "id": "eip155:1874", "name": "Whitechain Sepolia", "rpc": "https://rpc.testnet.whitechain.io", "explorer": "https://explorer.testnet.whitechain.io", "testnet": true },
  { "id": "eip155:<MAINNET_ID>", "name": "Whitechain", "rpc": "https://<rpc>", "explorer": "https://<explorer>", "testnet": false, "assets": ["0xUSDCe"] }
]'
```

Or point `NETWORKS` at a JSON file path. One signer key serves all networks; fund it on each.

## 6. Monitoring

- **Uptime**: poll `GET /health` every 30-60 s; alert on a non-200 (the process is down) and on `status != "ok"` in the body (degraded: low runway or an unreachable RPC). The probe is cached for `HEALTH_CACHE_SECONDS`.
- **Runway**: alert when any `networks[].settleRunway` drops below a day of expected settles, or on `lowBalance: true`.
- **Budget**: `metrics.budget.globalSpentTodayWei` against `globalDailyLimitWei`; `metrics.policy.gasBudgetExceeded` climbing means merchants are being refused.
- **Failures**: `metrics.settle.failed`, `metrics.settle.pending` and `metrics.settle.byReason`. A spike in `invalid_exact_evm_*` reasons is usually a merchant misconfiguration (wrong EIP-712 domain, too-short `maxTimeoutSeconds`); `settlement_pending` growing points at the RPC or the chain.
- **Logs**: pino JSON on stdout, one line per verify/settle with `op`, `network`, `scheme`, `asset`, `amount`, `payTo`, `payer`, the outcome and `reason` (and `tx` / `explorer` for settlements, `apiKey` name when one was used). The reason code is what to ask a merchant for. Signatures, keys and `X-API-Key` are redacted, request bodies are never logged, and error text has URLs removed so an RPC provider key cannot end up in the log. `LOG_LEVEL=warn` keeps only problems (RPC failures, out-of-gas, unexpected errors).

A minimal scrape for Prometheus-style tooling: `curl -s localhost:8402/metrics | jq -r '"facilitator_settle_success \(.settle.success)\nfacilitator_settle_failed \(.settle.failed)\nfacilitator_gas_spent_wei \(.gas.spentWei.total)"'`.

## 7. Incidents

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `/health` `status: "degraded"`, `lowBalance: true` | Signer running out of WBT | Top up the signer; raise `LOW_RUNWAY_SETTLES` if alerts come too late |
| `/health` `status: "degraded"`, `rpcOk: false`; merchants see `rpc_unavailable` (503) | RPC down or rate-limiting | Switch `NETWORKS[].rpc` to another provider; the service keeps serving other networks. Refusals cost nothing; the `Retry-After` tells middleware when to try again |
| Merchants see `rate_limit_exceeded` mentioning "facilitator-wide" | Total traffic above `RATE_LIMIT_GLOBAL_PER_WINDOW` (or an attack from many addresses) | Check `/metrics` `http.requests`; raise the ceiling to what your RPC plan allows, or front the service with a WAF |
| `settle.failed` with `invalid_exact_evm_transaction_failed` and a hash | A token that passes simulation but reverts in a real transaction (gas was spent) | Add the token to the network's denylist of assets (set `assets` allowlist), or leave it: the loss per attempt is bounded by `MAX_SETTLE_GAS` and the budgets |
| Merchants see `gas_budget_exceeded` early in the day | Budget too small for real traffic, or one merchant dominating | Check `/metrics`; give the merchant an API key with its own budget; raise the global budget if the wallet supports it |
| `settlement_pending` rising | Chain congestion or RPC lag | Verify the hashes on the explorer; nothing is double-spent; raise `CONFIRMATION_TIMEOUT_MS` if the platform allows |
| Many `invalid_exact_evm_*` from one merchant | Wrong `extra.name/version`, wrong `payTo`, expired authorizations | Point them at the troubleshooting section of the docs; nothing to do server-side |
| Suspected key compromise | | Move remaining WBT out, restart with a new `FACILITATOR_PRIVATE_KEY`, note the old address in CHANGELOG |
| Abuse from one IP or payer | | Lower that scope's limit, add the payer to the denylist, or front the service with a WAF |

Nothing the facilitator does can move a payer's funds anywhere but to the `payTo` they signed for. The worst case of every incident above is wasted gas or refused settlements.

## 8. Local development

Run everything on a local Anvil chain: `npm test` already does this in the interop tests (ephemeral port, test EIP-3009 token, real `@x402/express` and `@x402/fetch`). To do it by hand:

```sh
anvil --chain-id 1874 --port 0 &                     # prints the port it chose
NETWORKS='[{"id":"eip155:1874","rpc":"http://127.0.0.1:<port>"}]' \
FACILITATOR_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
PORT=8402 npm run dev
```

Deploy any EIP-3009 token (the test fixture in `test/fixtures/artifacts.json` works), mint to a payer, then run `examples/merchant-express` with `FACILITATOR_URL=http://localhost:8402` and `examples/agent-fetch` against it. The key above is Anvil's public dev key #0; it holds nothing on any real network.
