// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stellar test helpers that need no network: an offline builder for `exact` payment payloads
 * (the same transaction shape @x402/stellar's client produces, signed with a real ed25519 key),
 * and a minimal Soroban JSON-RPC stand-in that counts calls, so policy refusals can be shown to
 * happen before any simulation or submission.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

/** Native XLM's Stellar Asset Contract on testnet. */
export const XLM_SAC_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
/** Placeholder source account (the facilitator rebuilds the transaction with its own). */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export function stellarRequirements(overrides: Partial<PaymentRequirements> & { payTo: string }): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: XLM_SAC_TESTNET,
    amount: "1000000",
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
    ...overrides,
  } as PaymentRequirements;
}

export interface StellarPaymentOptions {
  nonce?: bigint;
  expirationLedger?: number;
  /** Overrides the transfer's `to` / `amount` / function name (for negative tests). */
  to?: string;
  amount?: bigint;
  functionName?: string;
}

let nonceCounter = BigInt(Date.now()) * 1000n;

/** Builds a signed `exact` payload: one `transfer(from, to, amount)` invocation with the payer's auth entry. */
export async function buildStellarPayment(
  payer: Keypair,
  requirements: PaymentRequirements,
  opts: StellarPaymentOptions = {},
): Promise<PaymentPayload> {
  const from = payer.publicKey();
  const functionName = opts.functionName ?? "transfer";
  const args = [
    nativeToScVal(from, { type: "address" }),
    nativeToScVal(opts.to ?? requirements.payTo, { type: "address" }),
    nativeToScVal(opts.amount ?? BigInt(requirements.amount), { type: "i128" }),
  ];
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(from).toScAddress(),
        nonce: xdr.Int64.fromString((opts.nonce ?? nonceCounter++).toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(requirements.asset).toScAddress(), functionName, args }),
      ),
      subInvocations: [],
    }),
  });
  const signed = await authorizeEntry(entry, payer, opts.expirationLedger ?? 1_000_000, Networks.TESTNET);
  const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: requirements.asset, function: functionName, args, auth: [signed] }))
    .setTimeout(60)
    .build();
  return { x402Version: 2, accepted: requirements, payload: { transaction: tx.toXDR() } } as PaymentPayload;
}

// --------------------------------------------------------------------------- mock Soroban RPC

export interface MockSorobanRpcOptions {
  passphrase?: string;
  /** Spendable stroops reported for every account; undefined = account not found. */
  balanceStroops?: bigint | undefined;
  latestLedger?: number;
}

export interface MockSorobanRpc {
  url: string;
  calls: Map<string, number>;
  options: Required<Pick<MockSorobanRpcOptions, "passphrase" | "latestLedger">> & { balanceStroops: bigint | undefined };
  /** When set, simulateTransaction waits for this promise before answering (to hold a settlement open). */
  holdSimulation: Promise<void> | undefined;
  /** Methods that are accepted and never answered (a stalled RPC: the connection stays open). */
  stall: Set<string>;
  /** Spendable stroops of one account, overriding `balanceStroops` (undefined = account not found). */
  balances: Map<string, bigint | undefined>;
  count(method: string): number;
  stop(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function accountEntryXdr(accountId: string, balance: bigint): string {
  const entry = new xdr.AccountEntry({
    accountId: Keypair.fromPublicKey(accountId).xdrAccountId(),
    balance: xdr.Int64.fromString(balance.toString()),
    seqNum: xdr.Int64.fromString("1"),
    numSubEntries: 0,
    inflationDest: null,
    flags: 0,
    homeDomain: "",
    thresholds: Buffer.from([1, 0, 0, 0]),
    signers: [],
    ext: new xdr.AccountEntryExt(0),
  });
  return xdr.LedgerEntryData.account(entry).toXDR("base64");
}

/**
 * Answers the Soroban RPC methods the facilitator's policy layer uses (getNetwork,
 * getLatestLedger, getLedgerEntries for fee-payer balances); simulateTransaction always fails,
 * so no payment ever verifies against it and sendTransaction is never reached.
 */
export async function startMockSorobanRpc(opts: MockSorobanRpcOptions = {}): Promise<MockSorobanRpc> {
  const state: MockSorobanRpc = {
    url: "",
    calls: new Map(),
    options: {
      passphrase: opts.passphrase ?? Networks.TESTNET,
      latestLedger: opts.latestLedger ?? 1_000,
      balanceStroops: "balanceStroops" in opts ? opts.balanceStroops : 10_000n * 10_000_000n,
    },
    holdSimulation: undefined,
    stall: new Set(),
    balances: new Map(),
    count: (method) => state.calls.get(method) ?? 0,
    stop: async () => undefined,
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown> };
      state.calls.set(body.method, (state.calls.get(body.method) ?? 0) + 1);
      if (state.stall.has(body.method)) return; // accepted, never answered
      const ledger = state.options.latestLedger;
      let result: unknown;
      switch (body.method) {
        case "getNetwork":
          result = { passphrase: state.options.passphrase, protocolVersion: 23, friendbotUrl: "https://friendbot.example.invalid/" };
          break;
        case "getLatestLedger":
          result = { id: "00", protocolVersion: 23, sequence: ledger };
          break;
        case "getLedgerEntries": {
          const keys = (body.params?.["keys"] as string[] | undefined) ?? [];
          const entries = keys.flatMap((key) => {
            const ledgerKey = xdr.LedgerKey.fromXDR(key, "base64");
            if (ledgerKey.switch() !== xdr.LedgerEntryType.account()) return [];
            const accountId = Address.account(ledgerKey.account().accountId().ed25519()).toString();
            const spendable = state.balances.has(accountId) ? state.balances.get(accountId) : state.options.balanceStroops;
            if (spendable === undefined) return [];
            // Spendable = balance - 1 XLM minimum balance (2 base reserves, no subentries).
            return [{ key, xdr: accountEntryXdr(accountId, spendable + 10_000_000n), lastModifiedLedgerSeq: ledger - 1 }];
          });
          result = { entries, latestLedger: ledger };
          break;
        }
        case "simulateTransaction":
          if (state.holdSimulation) await state.holdSimulation;
          result = { error: "mock RPC: simulation disabled", events: [], latestLedger: ledger };
          break;
        case "getTransaction":
          result = { status: "NOT_FOUND", latestLedger: ledger, latestLedgerCloseTime: "0", oldestLedger: 1, oldestLedgerCloseTime: "0" };
          break;
        case "getHealth":
          result = { status: "healthy", latestLedger: ledger, oldestLedger: 1, ledgerRetentionWindow: 17_280 };
          break;
        default:
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `mock: ${body.method} not implemented` } }));
          return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  state.url = `http://127.0.0.1:${address.port}`;
  state.stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections(); // stalled requests hold their sockets open
      server.close(() => resolve());
    });
  return state;
}
