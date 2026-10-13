# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's private vulnerability reporting for this repository:

**https://github.com/InferitAI/whitechain-x402-facilitator/security/advisories/new**

Do not open a public issue, and do not include private keys, API keys or full payment signatures in a report; a transaction hash or a redacted payload is enough. If you cannot use GitHub, contact the maintainer, Sahil Massey, through the contact details on [his GitHub profile](https://github.com/OGcryptonaut).

You will get an acknowledgement within 3 working days and a first assessment within 10. Fixes for confirmed issues in the public facilitator are deployed before the advisory is published; self-hosters are notified through a GitHub security advisory and a CHANGELOG entry.

## Scope

In scope:

- The facilitator service in `src/` (`/verify`, `/settle`, `/supported`, `/health`, `/metrics`, `GET /`), its policy layer (rate limits, gas budgets, API keys, denylist, dedupe, fees) and its Docker image.
- The example programs in `examples/` as far as they could lead a user to lose funds or leak a key.
- The static site in `site/` (for example content injection through the build variables).
- The public facilitator deployment operated from this repository.

Out of scope:

- The x402 protocol and the official `@x402/*` packages. Report those upstream at https://github.com/x402-foundation/x402/security; we will help coordinate if a fix is needed here.
- Whitechain, WhiteBIT and third-party RPC providers.
- Token contracts (ITC, USDC.e) and Uniswap Permit2.
- Denial of service by exhausting the public facilitator's rate limits or daily gas budget, which is the documented behaviour of those limits. A way to bypass them is in scope.

## What the facilitator can and cannot do

Understanding the trust model helps classify a finding:

- The facilitator **never holds funds**. An `exact` payment is a transfer the payer signed from their address to the merchant's `payTo`; the signature covers recipient, amount, validity window and nonce. A bug here cannot redirect funds; it can at most refuse to settle, settle late, or waste the facilitator's gas.
- The facilitator's only secret is `FACILITATOR_PRIVATE_KEY`, a wallet that holds WBT for gas. Its loss costs the gas balance. The key is read from the environment, kept non-enumerable on the config object, and redacted by the logger together with signatures and `X-API-Key` headers.
- Merchants trust the facilitator's `isValid` answer to serve a response before settlement. A bug that makes `/verify` accept a payment that cannot settle (wrong amount or recipient, insufficient balance, bad signature) is therefore the most serious class of issue for this project, followed by anything that lets a third party drain the gas wallet (budget or rate-limit bypass, forced reverts).

## What has been reviewed

`VERIFICATION.md` records the adversarial review performed before the first release (gas drain, payTo redirection, cross-network replay, denylist and rate-limit bypass, signing surface, secret leakage, server-side request forgery) and the regression tests that pin each finding in `test/interop/hardening.test.ts` and `test/unit/hardening.test.ts`. A report that shows one of those tests to be insufficient is especially welcome.

## Supported versions

Only the latest release on `main` receives fixes. The public facilitator always runs the latest `main`.

## Good practice for operators

- Fund the signer with gas only and set `GAS_BUDGET_GLOBAL_DAILY` to what you are willing to lose in a day.
- Keep `SIMULATE_IN_SETTLE=true` so reverting transfers are refused before they cost gas.
- Put the service behind TLS and set `TRUST_PROXY` correctly, or per-IP rate limits will see the proxy's address.
- Update the denylist on a schedule (`npm run denylist:ofac`) and watch `/health` for low runway.
