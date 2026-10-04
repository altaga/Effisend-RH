# AGENTS.md

Instructions for AI coding agents working in this repository. Humans should read `README.md`.

## 1. What this repository is (and is not)

- This is the **public, minimal** companion of Effisend for the Robinhood Chain hackathon.
- It contains:
  - the Effi NFT contract project (`Contracts/`): source and compiler settings unchanged from production, test tooling on Hardhat 3;
  - an independent, read-only checkout verifier (`Verifier/`), dependency-free, with tests on real receipts;
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

## 3. Facts the documentation relies on (do not inflate them)

| Claim | Value | Source of truth |
|---|---|---|
| Face ID checkout on Robinhood | 0.009999 USDG, test wallet → point of sale | tx `0x06c2a265…b604` (Robinhood) |
| Robinhood Pay | 0.01 USDG, test wallet → point of sale | tx `0x94611b25…607a` (Robinhood) |
| Card top-up | Robinhood `0xc9bdb0d5…8a75` → Linea `0x3ca8e0b8…713e` | explorers |
| Effi delivered on Robinhood | token #0 via `distribute()` | tx `0x470f2546…2d82` |
| Pudgy Penguins Pop-Up (2026-09-24 → 10-02, closed 9/26-27) | 20 orders · $635.67 · 14 distinct paying wallets (one paid 7) · Solana 11/$420.91, Ethereum 6/$149.90, Base 3/$64.86 · 18 USDC + 2 USDT | the 20 hashes in README |
| Robinhood Chain in the pop-up | **0 orders** | on-chain |
| Point-of-sale wallet (EVM) | `0xAfDd6F1608F20481aD8376AB36B5080B2Ad27456` | public |
| Effisend test wallet (EVM) | `0xa80BEBca505725C04f7fa83d47D43b77B0275578` (owner's own; not a customer) | public |

Rules:

- The Robinhood and Arbitrum payments shown are **internal test payments**. Never present them as customer purchases.
- The pop-up's third network is **Base, not BNB**.
- Do not publish a checkout success rate: attempts that never reached the chain are not measurable on-chain.
- Do not list customers' wallet addresses in prose (the explorer links are enough).
- Photos: no identifiable customer faces, and strip EXIF/GPS before committing.
- When an external purchase on Robinhood Chain happens, add its hash to "At a glance" and "What is proven". Do not reword the existing claims to suggest it happened earlier.

## 4. Verifier: run and extend

```bash
cd Verifier
node --test            # 12 offline tests (fixtures = 2 real Robinhood receipts)
LIVE=1 node --test     # + live re-read of both receipts from Robinhood Chain
node verify.mjs --chain 4663 --tx <hash> --payee <addr> --token USDG --amount <x> --created <ISO> [--ttl 1800] [--max <cap>] [--seen <file>]
```

- No dependencies: keep it that way (Node ≥ 20 `fetch` and `node:test`).
- Chains and tokens: Robinhood comes from `App/robinhood-chain.json`; Arbitrum One USDC is `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`. Add a token only with its official contract.
- Amounts are exact `BigInt` math (`toUnits` / `fromUnits`). Never use floating point for money.
- Fixtures are real on-chain data. Negative tests mutate in-memory copies; never edit the fixture files.
- It is a public reference for settlement checks, **not** Effisend's backend. Don't describe it as production code.

## 5. Contracts: build, test, verify

```bash
cd Contracts
npm ci                        # exact versions from package-lock.json
EVM=cancun node compile.cjs   # REQUIRED: EVM=cancun (see below) -> build/EffisendNFT.json
node test.cjs                 # local Hardhat network; prints "ALL TESTS PASSED"
```

- `compile.cjs` defaults to `evmVersion: paris`. With OpenZeppelin 5.6.1 that **fails** (`mcopy` needs Cancun). Always pass `EVM=cancun`.
- The deployed runtime bytecode on Robinhood Chain matches the source compiled with **solc 0.8.28, optimizer on with 200 runs, `evmVersion: cancun`**, byte for byte. Any change to `contracts/EffisendNFT.sol`, the compiler or its settings breaks that match. Do not edit the contract unless the task is explicitly about a new deployment, and say so when you do.
- `build/`, `artifacts/`, `cache/` and `node_modules/` are gitignored; never commit them.
- `package.json` is `"type": "module"` because Hardhat 3 needs an ESM `hardhat.config.js`; the `.cjs` scripts stay CommonJS. `overrides.tmp` pins a patched `tmp` under `solc` (it is only used by solc's CLI, not by `compile.cjs`). Keep `npm audit` at 0 vulnerabilities, and never bump `solc` or `@openzeppelin/contracts`: that would change the bytecode.

Contract behaviour (`EffisendNFT`, ERC-721 on OpenZeppelin 5, `Ownable`):

- Token ids start at **0**. The app reads a collection with `balanceOf` and then `tokenURI(0)`, so token 0 must exist.
- All tokens share one metadata URI (`tokenURI` returns `_sharedURI`; the owner can change it with `setURI`).
- `mintBatch(n)` mints to the owner (treasury). `distribute(to)` transfers the **next token the owner still holds**, in id order, and reverts with "No tokens left to distribute" when none remain.
- `mint(to)` mints directly to a recipient. Every write function is `onlyOwner`.

## 6. Verifying claims on-chain (read-only)

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

## 7. Editing the documentation

- `README.md` is user-facing usage documentation: features on Robinhood Chain, connected services, and how it works (Mermaid).
  - Keep every statement verifiable from this repo, the chain or the live app.
  - When you change behaviour descriptions, keep the Mermaid diagrams consistent with the tables.
- Mermaid must render on GitHub (Mermaid 11). Quote labels that contain punctuation (`A["text (x)"]`), use `<br/>` for line breaks, and avoid `;` inside messages. Render-check the diagrams before committing.
- Screenshots live in `App/screenshots/` as JPEGs under 200 KB each: 4 compositions of 3 phone screens (1620 px wide) plus one single screen (`5_effi_nft_robinhood.jpg`, 620 px wide) and the pop-up photo strip (`6_pudgy_popup_tokyo_dome_city.jpg`, faces of customers excluded, no EXIF). README sections are organised by feature, each with its screenshot, its Mermaid diagram and its on-chain proof; keep that structure. Reference them with relative paths. Do not add screenshots that show secrets, seed phrases, PIN entry with digits visible, or personal data beyond public addresses.
- Write in English. Use the product names exactly as written: "Effisend", "DeSmond", "Robinhood Chain", "USDG", "Effi", "LI.FI", "Layerswap".

## 8. Hard rules

1. No secrets, keys, `.env` files, private endpoints, cloud resource names or internal hostnames. The `.gitignore` already blocks `.env*`, `*.pem` and `*.key`; do not weaken it.
2. Do not add the app or backend source, and do not reconstruct them from the screenshots.
3. Do not change contract source or compiler settings without saying that the on-chain match will no longer hold.
4. Do not invent addresses, chain ids, token decimals, fees or features. If something is not in this repo or verifiable on-chain, leave it out.
5. License is MIT (`LICENSE`). Keep it.

## 9. Repository map

```
App/robinhood-chain.json       public chain config (RPCs, tokens, explorer, Effi address)
App/screenshots/*.jpg          UI captures from the live app (JPEG, 1620 px wide)
Contracts/contracts/EffisendNFT.sol
Contracts/compile.cjs          solc build -> build/EffisendNFT.json (use EVM=cancun)
Contracts/test.cjs             Hardhat in-memory tests
Contracts/hardhat.config.js    Hardhat 3 (ESM), in-memory EVM for tests, hardfork cancun
Contracts/deployments.json     addresses + explorers on every chain
Verifier/verify.mjs            checkout receipt verifier (library + CLI)
Verifier/verify.test.mjs       node --test (offline; LIVE=1 adds a chain re-read)
Verifier/fixtures/*.json       two real Robinhood Chain receipts
README.md                      usage docs for humans
AGENTS.md                      this file
LICENSE                        MIT
```
