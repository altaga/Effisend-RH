import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
const U = (n: number) => BigInt(Math.round(n * 1e6));
const TTL = 30 * 60;
const MIN = 60;

async function setup() {
  const [operator, payer, merchant, feeWallet, partner, relayer, stranger] = await ethers.getSigners();
  const usdg = await ethers.deployContract("MockUSDG");
  const checkout = await ethers.deployContract("Checkout", [await usdg.getAddress(), operator.address]);
  await usdg.mint(payer.address, U(100));
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const usdgDomain = { name: "Global Dollar", version: "1", chainId, verifyingContract: await usdg.getAddress() };
  const coDomain = { name: "EffisendCheckout", version: "1", chainId, verifyingContract: await checkout.getAddress() };
  const receiveTypes = { ReceiveWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" } ] };
  const orderTypes = { Order: [
    { name: "id", type: "bytes32" }, { name: "merchant", type: "address" }, { name: "amount", type: "uint256" },
    { name: "expiry", type: "uint256" }, { name: "splitsHash", type: "bytes32" } ] };
  const now = async () => (await ethers.provider.getBlock("latest"))!.timestamp;
  const splitsHash = (splits: any[]) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["tuple(address recipient,uint16 bps)[]"], [splits]));

  async function makeOrder(name: string, amount: bigint, splits: any[] = [], opts: { merchantAddr?: string; ttl?: number; signer?: any } = {}) {
    const order = { id: ethers.id(name), merchant: opts.merchantAddr ?? merchant.address, amount, expiry: (await now()) + (opts.ttl ?? TTL), splits };
    const sig = await (opts.signer ?? operator).signTypedData(coDomain, orderTypes, { ...order, splitsHash: splitsHash(splits) });
    return { order, sig };
  }
  async function authFor(order: any, value: bigint, opts: { from?: any; ttl?: number } = {}) {
    const signer = opts.from ?? payer;
    const hash = await checkout.orderHash(order);
    const msg = { from: signer.address, to: await checkout.getAddress(), value, validAfter: (await now()) - MIN,
      validBefore: (await now()) + (opts.ttl ?? 300), nonce: await checkout.nonceFor(hash, signer.address) };
    const s = ethers.Signature.from(await signer.signTypedData(usdgDomain, receiveTypes, msg));
    return { from: msg.from, validAfter: msg.validAfter, validBefore: msg.validBefore, v: s.v, r: s.r, s: s.s };
  }
  const fullPay = async (name: string, amount: bigint, splits: any[] = []) => {
    const o = await makeOrder(name, amount, splits);
    return { ...o, auth: await authFor(o.order, amount) };
  };
  const advance = async (sec: number) => { await ethers.provider.send("evm_increaseTime", [sec]); await ethers.provider.send("evm_mine", []); };
  return { operator, payer, merchant, feeWallet, partner, relayer, stranger, usdg, checkout, usdgDomain, receiveTypes, makeOrder, authFor, fullPay, advance, now };
}

describe("Checkout (order signed off-chain)", () => {
  it("charges, pays the split, leaves the contract at zero and records the payment", async () => {
    const t = await setup();
    const p = await t.fullPay("o1", U(10), [{ recipient: t.feeWallet.address, bps: 150 }, { recipient: t.partner.address, bps: 50 }]);
    await expect(t.checkout.connect(t.relayer).pay(p.order, p.sig, p.auth)).to.emit(t.checkout, "Paid")
      .withArgs(p.order.id, t.payer.address, t.merchant.address, U(10), U(9.8));
    expect(await t.usdg.balanceOf(t.payer.address)).to.equal(U(90));
    expect(await t.usdg.balanceOf(t.feeWallet.address)).to.equal(U(0.15));
    expect(await t.usdg.balanceOf(t.partner.address)).to.equal(U(0.05));
    expect(await t.usdg.balanceOf(t.merchant.address)).to.equal(U(9.8));
    expect(await t.usdg.balanceOf(await t.checkout.getAddress())).to.equal(0n);
    expect(await t.checkout.paid(p.order.id)).to.equal(true);
  });
  it("the payer can also call pay", async () => {
    const t = await setup(); const p = await t.fullPay("o2", U(5));
    await t.checkout.connect(t.payer).pay(p.order, p.sig, p.auth);
    expect(await t.usdg.balanceOf(t.merchant.address)).to.equal(U(5));
  });
  it("an order cannot be paid twice", async () => {
    const t = await setup(); const p = await t.fullPay("o3", U(5));
    await t.checkout.pay(p.order, p.sig, p.auth);
    await expect(t.checkout.pay(p.order, p.sig, p.auth)).to.be.revertedWithCustomError(t.checkout, "OrderAlreadyPaid");
  });
  it("an order lasts 30 min: paid at 29, OrderExpired at 31", async () => {
    const t = await setup();
    const ok = await t.makeOrder("late1", U(5)); const okAuth = await t.authFor(ok.order, U(5), { ttl: TTL + 600 });
    const bad = await t.makeOrder("late2", U(5)); const badAuth = await t.authFor(bad.order, U(5), { ttl: TTL + 600 });
    await t.advance(29 * MIN);
    await t.checkout.pay(ok.order, ok.sig, okAuth);
    await t.advance(2 * MIN);
    await expect(t.checkout.pay(bad.order, bad.sig, badAuth)).to.be.revertedWithCustomError(t.checkout, "OrderExpired");
    expect(await t.checkout.paid(bad.order.id)).to.equal(false);
  });
  it("an order signed by someone other than the operator reverts", async () => {
    const t = await setup();
    const o = await t.makeOrder("fake", U(5), [], { signer: t.stranger });
    await expect(t.checkout.pay(o.order, o.sig, await t.authFor(o.order, U(5)))).to.be.revertedWithCustomError(t.checkout, "InvalidOrderSignature");
  });
  it("changing merchant, amount or split after signing reverts", async () => {
    const t = await setup(); const p = await t.fullPay("tamper", U(5), [{ recipient: t.feeWallet.address, bps: 100 }]);
    const auth = await t.authFor(p.order, U(5));
    await expect(t.checkout.pay({ ...p.order, merchant: t.stranger.address }, p.sig, auth)).to.be.revertedWithCustomError(t.checkout, "InvalidOrderSignature");
    await expect(t.checkout.pay({ ...p.order, amount: U(1) }, p.sig, auth)).to.be.revertedWithCustomError(t.checkout, "InvalidOrderSignature");
    await expect(t.checkout.pay({ ...p.order, splits: [{ recipient: t.stranger.address, bps: 9000 }] }, p.sig, auth)).to.be.revertedWithCustomError(t.checkout, "InvalidOrderSignature");
  });
  it("the payer's signature is bound to the whole order (same id, other merchant)", async () => {
    const t = await setup();
    const a = await t.makeOrder("same-id", U(5));
    const b = await t.makeOrder("same-id", U(5), [], { merchantAddr: t.stranger.address });
    const authForA = await t.authFor(a.order, U(5));
    await expect(t.checkout.pay(b.order, b.sig, authForA)).to.be.revertedWithCustomError(t.usdg, "InvalidSignature");
    await t.checkout.pay(a.order, a.sig, authForA);
    expect(await t.usdg.balanceOf(t.merchant.address)).to.equal(U(5));
  });
  it("a payer signature for another amount, or by someone else, fails", async () => {
    const t = await setup(); const o = await t.makeOrder("o4", U(5));
    await expect(t.checkout.pay(o.order, o.sig, await t.authFor(o.order, U(4)))).to.be.revertedWithCustomError(t.usdg, "InvalidSignature");
    const other = await t.authFor(o.order, U(5), { from: t.stranger });
    await expect(t.checkout.pay(o.order, o.sig, { ...other, from: t.payer.address })).to.be.revertedWithCustomError(t.usdg, "InvalidSignature");
  });
  it("an expired payer signature reverts and the order stays payable with a new one", async () => {
    const t = await setup(); const o = await t.makeOrder("o5", U(5));
    const old = await t.authFor(o.order, U(5), { ttl: 100 });
    await t.advance(200);
    await expect(t.checkout.pay(o.order, o.sig, old)).to.be.revertedWithCustomError(t.usdg, "AuthorizationExpired");
    expect(await t.checkout.paid(o.order.id)).to.equal(false);
    await t.checkout.pay(o.order, o.sig, await t.authFor(o.order, U(5)));
    expect(await t.checkout.paid(o.order.id)).to.equal(true);
  });
  it("isolated replay with an EOA payee: like real USDG, the second call does not revert but moves no funds", async () => {
    const t = await setup(); const n = await t.now();
    const msg = { from: t.payer.address, to: t.relayer.address, value: U(1), validAfter: n - 60, validBefore: n + 300, nonce: ethers.hexlify(ethers.randomBytes(32)) };
    const sig = ethers.Signature.from(await t.payer.signTypedData(t.usdgDomain, t.receiveTypes, msg));
    const call = () => t.usdg.connect(t.relayer).receiveWithAuthorization(msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce, sig.v, sig.r, sig.s);
    await call();
    await call();
    expect(await t.usdg.balanceOf(t.relayer.address)).to.equal(U(1));
  });
  it("authorization cancelled by the payer + leftover balance in the contract: pay() reverts PaymentNotReceived and pays nothing", async () => {
    const t = await setup(); const p = await t.fullPay("cancelled", U(5));
    await t.usdg.mint(await t.checkout.getAddress(), U(50));
    await t.usdg.burnNonce(t.payer.address, await t.checkout.nonceFor(await t.checkout.orderHash(p.order), t.payer.address));
    await expect(t.checkout.pay(p.order, p.sig, p.auth)).to.be.revertedWithCustomError(t.checkout, "PaymentNotReceived");
    expect(await t.checkout.paid(p.order.id)).to.equal(false);
    expect(await t.usdg.balanceOf(t.merchant.address)).to.equal(0n);
    expect(await t.usdg.balanceOf(await t.checkout.getAddress())).to.equal(U(50));
  });
  it("calling USDG directly without being the payee reverts CallerMustBePayee", async () => {
    const t = await setup(); const p = await t.fullPay("o6", U(5));
    await t.checkout.pay(p.order, p.sig, p.auth);
    await expect(t.usdg.connect(t.stranger).receiveWithAuthorization(p.auth.from, await t.checkout.getAddress(), U(5), p.auth.validAfter,
      p.auth.validBefore, ethers.ZeroHash, p.auth.v, p.auth.r, p.auth.s)).to.be.revertedWithCustomError(t.usdg, "CallerMustBePayee");
  });
  it("insufficient balance reverts everything and the order stays unpaid", async () => {
    const t = await setup(); const p = await t.fullPay("o7", U(500));
    await expect(t.checkout.pay(p.order, p.sig, p.auth)).to.be.revertedWithCustomError(t.usdg, "InsufficientBalance");
    expect(await t.checkout.paid(p.order.id)).to.equal(false);
  });
  it("invalid orders: amount 0, merchant 0, more than 5 splits, bps over 100%", async () => {
    const t = await setup(); const z = ethers.ZeroAddress;
    const s = (n: number, bps = 10) => Array.from({ length: n }, () => ({ recipient: t.partner.address, bps }));
    for (const [name, amount, m, splits] of [["z1", 0n, undefined, []], ["z2", U(1), z, []], ["z3", U(1), undefined, s(6)], ["z4", U(1), undefined, s(2, 6000)]] as any[]) {
      const o = await t.makeOrder(name, amount, splits, { merchantAddr: m });
      await expect(t.checkout.pay(o.order, o.sig, await t.authFor(o.order, U(1)))).to.be.revertedWithCustomError(t.checkout, "InvalidOrder");
    }
  });
  it("two-step operator transfer: only the pending operator can accept and the old operator's signature stops working", async () => {
    const t = await setup(); const o = await t.makeOrder("op1", U(1));
    await expect(t.checkout.connect(t.stranger).transferOperator(t.stranger.address)).to.be.revertedWithCustomError(t.checkout, "NotOperator");
    await expect(t.checkout.transferOperator(ethers.ZeroAddress)).to.be.revertedWithCustomError(t.checkout, "InvalidOperator");
    await t.checkout.transferOperator(t.stranger.address);
    expect(await t.checkout.operator()).to.equal(t.operator.address);
    await expect(t.checkout.connect(t.relayer).acceptOperator()).to.be.revertedWithCustomError(t.checkout, "NotPendingOperator");
    await t.checkout.pay(o.order, o.sig, await t.authFor(o.order, U(1)));
    await t.checkout.connect(t.stranger).acceptOperator();
    expect(await t.checkout.operator()).to.equal(t.stranger.address);
    expect(await t.checkout.pendingOperator()).to.equal(ethers.ZeroAddress);
    const o2 = await t.makeOrder("op2", U(1));
    await expect(t.checkout.pay(o2.order, o2.sig, await t.authFor(o2.order, U(1)))).to.be.revertedWithCustomError(t.checkout, "InvalidOrderSignature");
  });
  it("rescueTokens: operator only, recovers USDG sent directly and does not affect payments", async () => {
    const t = await setup(); const addr = await t.checkout.getAddress();
    await t.usdg.connect(t.payer).transfer(addr, U(3));
    await expect(t.checkout.connect(t.stranger).rescueTokens(await t.usdg.getAddress(), t.stranger.address, U(3))).to.be.revertedWithCustomError(t.checkout, "NotOperator");
    await expect(t.checkout.rescueTokens(await t.usdg.getAddress(), ethers.ZeroAddress, U(3))).to.be.revertedWithCustomError(t.checkout, "InvalidOrder");
    await expect(t.checkout.rescueTokens(await t.usdg.getAddress(), t.feeWallet.address, U(4))).to.be.revertedWith("rescue failed");
    await t.checkout.rescueTokens(await t.usdg.getAddress(), t.feeWallet.address, U(3));
    expect(await t.usdg.balanceOf(t.feeWallet.address)).to.equal(U(3));
    expect(await t.usdg.balanceOf(addr)).to.equal(0n);
    const p = await t.fullPay("after-rescue", U(2));
    await t.checkout.pay(p.order, p.sig, p.auth);
    expect(await t.usdg.balanceOf(t.merchant.address)).to.equal(U(2));
  });
  it("DOMAIN_SEPARATOR matches the expected EIP-712 domain", async () => {
    const t = await setup();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    expect(await t.checkout.DOMAIN_SEPARATOR()).to.equal(ethers.TypedDataEncoder.hashDomain({ name: "EffisendCheckout", version: "1", chainId, verifyingContract: await t.checkout.getAddress() }));
  });
  it("gas of pay with 2 splits", async () => {
    const t = await setup();
    const p = await t.fullPay("g1", U(10), [{ recipient: t.feeWallet.address, bps: 150 }, { recipient: t.partner.address, bps: 50 }]);
    console.log("      gasUsed pay (2 splits, mock):", (await (await t.checkout.pay(p.order, p.sig, p.auth)).wait())!.gasUsed.toString());
  });
});
