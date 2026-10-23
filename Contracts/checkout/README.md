# Checkout: the contract behind Robinhood Order

`Checkout` settles one payment order in **USDG** on Robinhood Chain. The payer signs once (free), a relayer sends the transaction and pays the gas, and the contract collects the USDG, pays the merchant and records the payment in a single transaction.

| | |
|---|---|
| **Address** | [`0x97a394a57d9Cb523CAAFa2482215e86908b780F4`](https://robin.etherscan.io/address/0x97a394a57d9Cb523CAAFa2482215e86908b780F4) on Robinhood Chain (4663) |
| **Deployment** | [`0x5471fc2f…dd21e`](https://robin.etherscan.io/tx/0x5471fc2f9a49b3edac502a66245c179a44669642dcc0d061038453ca7cddd21e), block 95745829 |
| **Constructor** | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, operator `0xF4f830b19421B818e03e1005D7ba4b987c3f3d57` |
| **Compiler** | solc 0.8.28, optimizer on with 200 runs, `evmVersion: cancun` |
| **Verified** | Sourcify, `exact_match` for runtime and creation bytecode ([record](https://sourcify.dev/server/v2/contract/4663/0x97a394a57d9Cb523CAAFa2482215e86908b780F4)) |

## Flow

1. The **operator** (a dedicated signing key) signs an order off-chain with EIP-712: `{id, merchant, amount, expiry, splits}`. Nothing is on-chain yet.
2. The **payer** signs a USDG `ReceiveWithAuthorization` (EIP-3009) to the contract for exactly that amount. Its `nonce` is `keccak256(orderHash, payer)`, so the signature is only valid for that exact order.
3. Anyone (the relayer) calls `pay(order, operatorSignature, payerAuthorization)`. The contract checks the order and its expiry, verifies the operator signature, marks the order paid, pulls the USDG, checks that its balance grew by exactly the amount, pays the splits and the merchant, and emits `Paid`.

The contract never keeps funds: every payment ends with zero USDG in it, and a failure at any step reverts everything.

## Rules enforced on-chain

- One payment per order id (`paid(id)`), and a hard expiry set by the operator (30 minutes in the app).
- Merchant, amount and splits are fixed by the operator's signature; the payer's signature commits to the same order.
- At most 5 splits, shares in basis points, total at most 100%. The remainder goes to the merchant. **Supported and covered by the tests; the app does not use splits yet.**
- Operator changes are a two-step transfer (`transferOperator`, then `acceptOperator` by the new address), so a wrong address cannot lock the contract.
- `rescueTokens` returns tokens sent to the contract by mistake (operator only).
- The EIP-712 domain separator is recomputed if the chain id ever changes.

## A finding about real USDG

USDG does **not** revert when an EIP-3009 authorization is replayed or was cancelled: the call returns successfully and does nothing (no events, no transfer). On Robinhood Chain the second call with the same authorization succeeded with `status 1` and 41,197 gas and no logs ([first use `0xee4ee0a8…c877a`](https://robin.etherscan.io/tx/0xee4ee0a829f47925e7fa475e7fb16073c80ef964f0f988e1cc788b3ecb0c877a), [second call `0x0a1e2f4c…de2d1`](https://robin.etherscan.io/tx/0x0a1e2f4c0d572121dfe67c4d09f568119e7de30b7da3ddedf20bd930528de2d1)). Bad signatures, wrong value, insufficient balance and expired or not-yet-valid authorizations do revert. Because `pay()` could otherwise continue after a silent no-op (for example paying the merchant out of tokens that were sent to the contract by mistake), it requires its USDG balance to grow by exactly the order amount, and `MockUSDG.sol` reproduces the same behaviour.

## Source and tests

- `contracts/Checkout.sol` is the readable source, commented in English. Its code is identical to the deployed contract: with the comments and whitespace removed, it is the same text as the verified source.
- `verify/Checkout.verified.sol` is the exact source verified on Sourcify (its comments are in Spanish). Solidity's metadata hash covers the comments, so only this file matches the deployed bytecode *byte for byte*; the English copy matches all 5,130 bytes of logic and differs only in that 53-byte hash. `npm run build && node scripts/compare-onchain.mjs` checks it against the chain.
- `contracts/MockUSDG.sol` is a test double that imitates USDG's EIP-3009 (including the silent no-op). It is not deployed.
- `verify/standard-input.json` is the solc standard JSON input used for verification (contract `project/contracts/Checkout.sol:Checkout`).
- `test/Checkout.ts` has 18 tests on Hardhat 3's in-memory EVM: charge and split, double payment, 30-minute expiry, forged or altered orders, signature binding to the whole order, expired payer signature, replay, cancelled authorization with leftover balance, operator transfer, rescue and the domain separator.

```bash
cd Contracts/checkout
npm ci
npm test      # 18 passing
```

`npm audit` reports no known vulnerabilities.
