// node --test   (no network unless LIVE=1)
//
// Fixtures are two real Robinhood Chain payments made through the live app:
//   robinhood-faceid-checkout.json  0.009999 USDG, Face ID checkout   (0x06c2…b604)
//   robinhood-pay.json              0.01 USDG, Robinhood Pay request   (0x9461…607a)
// Negative cases mutate copies of them in memory; the files are never changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkPayment, checkRefund, fetchReceipt, toUnits, fromUnits } from "./verify.mjs";

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));
const POS = "0xafdd6f1608f20481ad8376ab36b5080b2ad27456";
const BUYER = "0xa80bebca505725c04f7fa83d47d43b77b0275578";
const faceid = load("robinhood-faceid-checkout");
const pay = load("robinhood-pay");
const order = (over = {}) => ({
  chainId: 4663,
  token: "USDG",
  payee: POS,
  amount: "0.009999",
  createdAt: faceid.blockTimestamp - 60,
  ttlSeconds: 1800,
  ...over,
});
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

test("Face ID checkout settles its order", () => {
  const r = checkPayment(faceid, order());
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.paid, "0.009999");
  assert.equal(r.payer, BUYER);
});

test("Robinhood Pay request settles its order", () => {
  const r = checkPayment(pay, order({ amount: "0.01", createdAt: pay.blockTimestamp - 120 }));
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.paid, "0.01");
});

test("duplicate order: one transaction cannot settle two orders", () => {
  const seen = new Set([faceid.receipt.transactionHash.toLowerCase()]);
  assert.deepEqual(failed(checkPayment(faceid, order(), { seen })), ["unique"]);
});

test("expired quote: paid after the request's time-to-live", () => {
  const r = checkPayment(faceid, order({ createdAt: faceid.blockTimestamp - 3600, ttlSeconds: 1800 }));
  assert.deepEqual(failed(r), ["window"]);
});

test("payment older than the order is not accepted", () => {
  assert.deepEqual(failed(checkPayment(faceid, order({ createdAt: faceid.blockTimestamp + 10 }))), ["window"]);
});

test("wrong payee: funds went to another wallet", () => {
  const r = checkPayment(faceid, order({ payee: "0x000000000000000000000000000000000000dead" }));
  assert.ok(failed(r).includes("payee"));
  assert.equal(r.ok, false);
});

test("wrong token: WETH order is not settled by USDG", () => {
  const r = checkPayment(faceid, order({ token: "WETH", amount: "0.000001" }));
  assert.ok(failed(r).includes("token"));
  assert.equal(r.ok, false);
});

test("underpayment is rejected, tolerance is explicit", () => {
  assert.deepEqual(failed(checkPayment(faceid, order({ amount: "0.01" }))), ["amount"]);
  assert.equal(checkPayment(faceid, order({ amount: "0.01", tolerance: "0.000001" })).ok, true);
});

test("cap: a payment above the merchant's limit is flagged", () => {
  assert.deepEqual(failed(checkPayment(pay, order({ amount: "0.005", maxAmount: "0.005", createdAt: pay.blockTimestamp - 1 }))), ["cap"]);
});

test("failed settlement: a reverted transaction never settles", () => {
  const reverted = clone(faceid);
  reverted.receipt.status = "0x0";
  assert.ok(failed(checkPayment(reverted, order())).includes("settled"));
});

test("refund: same token back from the merchant to the payer, at most what was paid", () => {
  const payment = { ...checkPayment(faceid, order()), blockTimestamp: faceid.blockTimestamp };
  const refund = clone(faceid);
  const [log] = refund.receipt.logs;
  [log.topics[1], log.topics[2]] = [log.topics[2], log.topics[1]]; // POS -> buyer
  refund.blockTimestamp += 300;
  assert.equal(checkRefund(refund, payment, order()).ok, true);

  const tooMuch = clone(refund);
  tooMuch.receipt.logs[0].data = "0x" + (10n ** 9n).toString(16).padStart(64, "0");
  assert.ok(checkRefund(tooMuch, payment, order()).checks.some((c) => c.name === "amount" && !c.ok));

  const elsewhere = clone(refund);
  elsewhere.receipt.logs[0].topics[2] = "0x" + "0".repeat(24) + "000000000000000000000000000000000000dead";
  assert.equal(checkRefund(elsewhere, payment, order()).ok, false);
});

test("exact decimal math, no floating point", () => {
  assert.equal(toUnits("19.99", 6), 19990000n);
  assert.equal(fromUnits(9999n, 6), "0.009999");
  assert.throws(() => toUnits("0.0000001", 6));
});

test("live: the fixtures match Robinhood Chain today", { skip: !process.env.LIVE }, async () => {
  for (const fx of [faceid, pay]) {
    const live = await fetchReceipt(4663, fx.receipt.transactionHash);
    assert.equal(live.receipt.status, fx.receipt.status);
    assert.equal(live.blockTimestamp, fx.blockTimestamp);
    assert.deepEqual(live.receipt.logs.map((l) => l.data), fx.receipt.logs.map((l) => l.data));
  }
});
