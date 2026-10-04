// Effisend checkout receipt verifier — independent, read-only settlement checks.
//
// Given a transaction hash and the order a merchant expected, it reads the chain and
// answers one question: did this exact order get paid, once, on time, to the right
// wallet, in the right token? No keys, no backend, no dependencies.
//
//   node verify.mjs --chain 4663 --tx 0x… --payee 0x… --token USDG --amount 5 \
//                   --created 2026-10-02T06:00:00Z [--ttl 1800] [--max 100] [--seen seen.txt]
//
// Library use: import { checkPayment, checkRefund, fetchReceipt } from "./verify.mjs".
import { readFileSync, existsSync } from "node:fs";

const RH = JSON.parse(readFileSync(new URL("../App/robinhood-chain.json", import.meta.url), "utf8"));

export const CHAINS = {
  4663: {
    name: "Robinhood Chain",
    explorer: "https://robin.etherscan.io/tx/",
    rpcs: RH.publicRpcs,
    tokens: Object.fromEntries(RH.tokens.filter((t) => t.symbol !== "ETH").map((t) => [t.symbol, t])),
  },
  42161: {
    name: "Arbitrum One",
    explorer: "https://arbiscan.io/tx/",
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
    tokens: { USDC: { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 } },
  },
};

// keccak256("Transfer(address,address,uint256)")
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const lc = (s) => String(s || "").toLowerCase();
const topicAddr = (t) => "0x" + lc(t).slice(-40);

/** "12.5" with 6 decimals -> 12500000n. Exact: no floating point. */
export function toUnits(value, decimals) {
  const [whole, frac = ""] = String(value).trim().split(".");
  if (!/^\d+$/.test(whole || "0") || !/^\d*$/.test(frac) || frac.length > decimals) {
    throw new Error(`invalid amount ${value} for ${decimals} decimals`);
  }
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function fromUnits(units, decimals) {
  const s = units.toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return s.slice(0, -decimals) + (frac ? "." + frac : "");
}

function tokenOf(chainId, symbol) {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`unsupported chain ${chainId}`);
  const token = chain.tokens[String(symbol).toUpperCase()];
  if (!token) throw new Error(`unsupported token ${symbol} on ${chain.name}`);
  return token;
}

function transfers(receipt) {
  return (receipt.logs || [])
    .filter((l) => lc(l.topics?.[0]) === TRANSFER && l.topics.length === 3)
    .map((l) => ({ token: lc(l.address), from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), value: BigInt(l.data) }));
}

/**
 * Checks one payment receipt against the order it should settle.
 *
 * order: { chainId, token, payee, amount, createdAt (unix s), ttlSeconds?, maxAmount?, tolerance? }
 *   amount / maxAmount / tolerance are decimal strings in token units ("0.01").
 * ctx:   { seen?: Set<string> } — hashes already credited to an order (duplicate guard).
 * tx:    { receipt, blockTimestamp } — receipt as returned by eth_getTransactionReceipt.
 */
export function checkPayment(tx, order, ctx = {}) {
  const token = tokenOf(order.chainId, order.token);
  const payee = lc(order.payee);
  const want = toUnits(order.amount, token.decimals);
  const tol = order.tolerance ? toUnits(order.tolerance, token.decimals) : 0n;
  const ttl = order.ttlSeconds ?? 1800;
  const hash = lc(tx.receipt.transactionHash);
  const all = transfers(tx.receipt);
  const toPayee = all.filter((t) => t.to === payee);
  const right = toPayee.filter((t) => t.token === lc(token.address));
  const paid = right.reduce((a, t) => a + t.value, 0n);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add("settled", tx.receipt.status === "0x1", tx.receipt.status === "0x1" ? "transaction succeeded" : "transaction failed or reverted");
  add(
    "token",
    right.length > 0 || toPayee.length === 0,
    right.length > 0 ? `${token.symbol} received` : toPayee.length ? `payee received a different token (${toPayee.map((t) => t.token).join(", ")})` : "no transfer to payee",
  );
  add(
    "payee",
    right.length > 0,
    right.length > 0 ? `paid to ${payee}` : all.some((t) => t.token === lc(token.address)) ? `${token.symbol} went to another address` : `no ${token.symbol} transfer to the payee`,
  );
  add("amount", paid + tol >= want, `paid ${fromUnits(paid, token.decimals)} ${token.symbol}, expected ${order.amount}`);
  if (order.maxAmount != null) {
    const cap = toUnits(order.maxAmount, token.decimals);
    add("cap", paid <= cap, paid <= cap ? `within cap ${order.maxAmount}` : `paid ${fromUnits(paid, token.decimals)} above cap ${order.maxAmount}`);
  }
  const ts = Number(tx.blockTimestamp);
  add(
    "window",
    ts >= order.createdAt && ts <= order.createdAt + ttl,
    ts < order.createdAt ? "payment predates the order" : ts > order.createdAt + ttl ? `quote expired (${ts - order.createdAt - ttl}s late)` : `paid ${ts - order.createdAt}s after the order`,
  );
  const dup = ctx.seen?.has(hash);
  add("unique", !dup, dup ? "this transaction already settled another order" : "first use of this transaction");

  return {
    ok: checks.every((c) => c.ok),
    hash,
    payer: right[0]?.from ?? null,
    paid: fromUnits(paid, token.decimals),
    token: token.symbol,
    checks,
  };
}

/** A refund must send the same token back from the payee to the original payer, after the payment, for at most what was paid. */
export function checkRefund(refundTx, payment, order) {
  const token = tokenOf(order.chainId, order.token);
  const back = transfers(refundTx.receipt).filter(
    (t) => t.token === lc(token.address) && t.from === lc(order.payee) && t.to === lc(payment.payer),
  );
  const refunded = back.reduce((a, t) => a + t.value, 0n);
  const paid = toUnits(payment.paid, token.decimals);
  const checks = [
    { name: "settled", ok: refundTx.receipt.status === "0x1" },
    { name: "to-payer", ok: back.length > 0, detail: back.length ? `refunded to ${payment.payer}` : "no refund to the original payer" },
    { name: "amount", ok: refunded > 0n && refunded <= paid, detail: `refunded ${fromUnits(refunded, token.decimals)} of ${payment.paid}` },
    { name: "after-payment", ok: Number(refundTx.blockTimestamp) >= Number(payment.blockTimestamp ?? 0) },
  ];
  return { ok: checks.every((c) => c.ok), refunded: fromUnits(refunded, token.decimals), checks };
}

async function rpc(urls, method, params) {
  let last;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "effisend-rh-verifier/1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json();
      if (body.result !== undefined) return body.result;
      last = new Error(body.error?.message || `no result from ${url}`);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Reads { receipt, blockTimestamp } from public RPCs (first one that answers). */
export async function fetchReceipt(chainId, hash) {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`unsupported chain ${chainId}`);
  const receipt = await rpc(chain.rpcs, "eth_getTransactionReceipt", [hash]);
  if (!receipt) throw new Error("transaction not found (not mined yet?)");
  const block = await rpc(chain.rpcs, "eth_getBlockByNumber", [receipt.blockNumber, false]);
  return { receipt, blockTimestamp: Number(BigInt(block.timestamp)) };
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isMain) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
  );
  const need = ["chain", "tx", "payee", "token", "amount", "created"].filter((k) => !args[k]);
  if (need.length) {
    console.error(`missing --${need.join(", --")}\nusage: node verify.mjs --chain 4663 --tx 0x… --payee 0x… --token USDG --amount 5 --created 2026-10-02T06:00:00Z [--ttl 1800] [--max 100] [--seen seen.txt]`);
    process.exit(2);
  }
  const seen = args.seen && existsSync(args.seen) ? new Set(readFileSync(args.seen, "utf8").split(/\s+/).filter(Boolean).map(lc)) : new Set();
  const order = {
    chainId: Number(args.chain),
    token: args.token,
    payee: args.payee,
    amount: args.amount,
    createdAt: Math.floor(Date.parse(args.created) / 1000),
    ttlSeconds: args.ttl ? Number(args.ttl) : undefined,
    maxAmount: args.max,
    tolerance: args.tolerance,
  };
  const tx = await fetchReceipt(order.chainId, args.tx);
  const result = checkPayment(tx, order, { seen });
  for (const c of result.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(8)} ${c.detail ?? ""}`);
  console.log(`\n${result.ok ? "✔ order settled" : "✖ order NOT settled"} · ${CHAINS[order.chainId].explorer}${args.tx}`);
  process.exit(result.ok ? 0 : 1);
}
