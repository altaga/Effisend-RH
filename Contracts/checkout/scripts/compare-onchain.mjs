// Proves that the readable source in contracts/Checkout.sol is the code running on Robinhood Chain.
//
//   npm run build && node scripts/compare-onchain.mjs
//
// It compiles nothing itself: it reads the Hardhat build output, zeroes the three immutable slots (they hold
// constructor values), and compares the runtime bytecode with eth_getCode of the deployed contract. The last
// bytes of any Solidity contract are a metadata hash that covers the source text including comments, so a
// comment-only change moves only that tail. The script reports both comparisons.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

const { FetchRequest, JsonRpcProvider } = createRequire(process.cwd() + "/")("ethers");
const CHECKOUT = "0x97a394a57d9Cb523CAAFa2482215e86908b780F4";
const RPC = "https://rpc.mainnet.chain.robinhood.com";

const dir = "artifacts/build-info/";
const outputFile = readdirSync(dir).filter((f) => f.endsWith(".output.json")).sort().pop();
const compiled = JSON.parse(readFileSync(dir + outputFile, "utf8")).output.contracts["project/contracts/Checkout.sol"].Checkout.evm.deployedBytecode;

const zeroImmutables = (hex) => {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  for (const refs of Object.values(compiled.immutableReferences || {})) for (const r of refs) bytes.fill(0, r.start, r.start + r.length);
  return bytes;
};
const withoutMetadata = (b) => b.subarray(0, b.length - 2 - b.readUInt16BE(b.length - 2)); // last 2 bytes = metadata length

const request = new FetchRequest(RPC);
request.setHeader("user-agent", "curl/8.5.0"); // the public RPC rejects requests without a user agent
const provider = new JsonRpcProvider(request, 4663, { staticNetwork: true });

const onChain = zeroImmutables(await provider.getCode(CHECKOUT));
const local = zeroImmutables("0x" + compiled.object);

const sameLogic = Buffer.compare(withoutMetadata(onChain), withoutMetadata(local)) === 0;
const sameMetadata = Buffer.compare(onChain, local) === 0;
console.log(`runtime bytecode: ${onChain.length} bytes on-chain, ${local.length} bytes compiled`);
console.log(`logic identical (metadata hash excluded): ${sameLogic}  (${withoutMetadata(onChain).length} bytes)`);
console.log(`metadata hash identical: ${sameMetadata}  (false is expected when only comments differ from the verified source)`);
process.exit(sameLogic ? 0 : 1);
