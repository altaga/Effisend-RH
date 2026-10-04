# AGENTS.md

Instructions for AI coding agents working in this repository. Humans should read `README.md`.

## 1. What this repository is (and is not)

- This is the **public, minimal** companion of Effisend for the Robinhood Chain hackathon.
- It contains:
  - the Effi NFT contract project (`Contracts/`), copied unchanged from production;
  - the public Robinhood Chain configuration (`App/robinhood-chain.json`);
  - UI screenshots (`App/screenshots/`);
  - documentation.
- It does **not** contain the Effisend app source, its backend, infrastructure names, keys or private endpoints. Do not add them, do not invent them, and do not describe internals beyond what `README.md` already states.
- The live app is https://effisend-tdc.expo.app. Treat it as a black box you can observe, not code you can change from here.

## 2. Ground truth: constants

Never guess these values. Use them exactly as written.

| Item | Value |
|---|---|
| Robinhood Chain id | `4663` |
| Native token | ETH (18 decimals) |
| Explorer | `https://robin.etherscan.io/` |
| USDG (Global Dollar) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals) |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (18 decimals) |
| Effi NFT (EffisendNFT) | `0xDDa30795FF04677C1c4B58616b7b77503554DC97`: same address on Robinhood (4663), Arbitrum One (42161), Arc (5042), Base (8453), Polygon (137), Avalanche (43114) and Monad (143) |
| Public RPCs | listed in `App/robinhood-chain.json` (`publicRpcs`); all answer `eth_chainId = 0x1237` (4663) |

Domain rules that the docs and any example must respect:

- **Robinhood Chain has no USDC.** On Robinhood, "dollars" / "USD" means **USDG**.
- Robinhood Chain is **not on Circle CCTP**. Bridges in and out of Robinhood go through **LI.FI**, with **Layerswap** as fallback.
- Gas on Robinhood is paid in **ETH**. Recommend keeping ≥ 0.0001 ETH.

## 3. Contracts: build, test, verify

```bash
cd Contracts
npm ci                        # exact versions from package-lock.json
EVM=cancun node compile.cjs   # REQUIRED: EVM=cancun (see below) -> build/EffisendNFT.json
node test.cjs                 # local Hardhat network; prints "ALL TESTS PASSED"
```

- `compile.cjs` defaults to `evmVersion: paris`. With OpenZeppelin 5.6.1 that **fails** (`mcopy` needs Cancun). Always pass `EVM=cancun`.
- The deployed runtime bytecode on Robinhood Chain matches the source compiled with **solc 0.8.28, optimizer on with 200 runs, `evmVersion: cancun`**, byte for byte. Any change to `contracts/EffisendNFT.sol`, the compiler or its settings breaks that match. Do not edit the contract unless the task is explicitly about a new deployment, and say so when you do.
- `build/`, `artifacts/`, `cache/` and `node_modules/` are gitignored; never commit them.

Contract behaviour (`EffisendNFT`, ERC-721 on OpenZeppelin 5, `Ownable`):

- Token ids start at **0**. The app reads a collection with `balanceOf` and then `tokenURI(0)`, so token 0 must exist.
- All tokens share one metadata URI (`tokenURI` returns `_sharedURI`; the owner can change it with `setURI`).
- `mintBatch(n)` mints to the owner (treasury). `distribute(to)` transfers the **next token the owner still holds**, in id order, and reverts with "No tokens left to distribute" when none remain.
- `mint(to)` mints directly to a recipient. Every write function is `onlyOwner`.

## 4. Verifying claims on-chain (read-only)

Prefer checking the chain over trusting text. These calls are free and move no funds:

```bash
RPC=https://rpc.mainnet.chain.robinhood.com
NFT=0xDDa30795FF04677C1c4B58616b7b77503554DC97
# contract code exists (4846 bytes)
curl -s -X POST $RPC -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["'$NFT'","latest"]}'
# name() -> "Effi"
curl -s -X POST $RPC -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"'$NFT'","data":"0x06fdde03"},"latest"]}'
```

Never send transactions, sign messages or use private keys from this repository.

## 5. Editing the documentation

- `README.md` is user-facing usage documentation: features on Robinhood Chain, connected services, and how it works (Mermaid).
  - Keep every statement verifiable from this repo, the chain or the live app.
  - When you change behaviour descriptions, keep the Mermaid diagrams consistent with the tables.
- Mermaid must render on GitHub (Mermaid 11). Quote labels that contain punctuation (`A["text (x)"]`), use `<br/>` for line breaks, and avoid `;` inside messages. Render-check the diagrams before committing.
- Screenshots live in `App/screenshots/` as JPEGs (1620 px wide, under 200 KB each): 4 compositions of 3 phone screens each. Reference them with relative paths. Do not add screenshots that show secrets, seed phrases, PIN entry with digits visible, or personal data beyond public addresses.
- Write in English. Use the product names exactly as written: "Effisend", "DeSmond", "Robinhood Chain", "USDG", "Effi", "LI.FI", "Layerswap".

## 6. Hard rules

1. No secrets, keys, `.env` files, private endpoints, cloud resource names or internal hostnames. The `.gitignore` already blocks `.env*`, `*.pem` and `*.key`; do not weaken it.
2. Do not add the app or backend source, and do not reconstruct them from the screenshots.
3. Do not change contract source or compiler settings without saying that the on-chain match will no longer hold.
4. Do not invent addresses, chain ids, token decimals, fees or features. If something is not in this repo or verifiable on-chain, leave it out.
5. License is MIT (`LICENSE`). Keep it.

## 7. Repository map

```
App/robinhood-chain.json       public chain config (RPCs, tokens, explorer, Effi address)
App/screenshots/*.jpg          UI captures from the live app (JPEG, 1620 px wide)
Contracts/contracts/EffisendNFT.sol
Contracts/compile.cjs          solc build -> build/EffisendNFT.json (use EVM=cancun)
Contracts/test.cjs             Hardhat in-memory tests
Contracts/hardhat.config.cjs   solidity 0.8.28, hardfork cancun
Contracts/deployments.json     addresses + explorers on every chain
README.md                      usage docs for humans
AGENTS.md                      this file
LICENSE                        MIT
```
