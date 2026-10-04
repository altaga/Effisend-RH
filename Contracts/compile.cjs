const solc=require("solc"),fs=require("fs"),path=require("path");
const input={language:"Solidity",sources:{"EffisendNFT.sol":{content:fs.readFileSync("contracts/EffisendNFT.sol","utf8")}},
 settings:{optimizer:{enabled:true,runs:200},evmVersion:process.env.EVM||"paris",outputSelection:{"*":{"*":["abi","evm.bytecode.object"]}}}};
const imp=p=>{try{return{contents:fs.readFileSync(require.resolve(p),"utf8")}}catch{return{error:"not found "+p}}};
const out=JSON.parse(solc.compile(JSON.stringify(input),{import:imp}));
const errs=(out.errors||[]).filter(e=>e.severity==="error"); if(errs.length){console.error(errs.map(e=>e.formattedMessage).join("\n"));process.exit(1);}
(out.errors||[]).forEach(e=>console.log("warn:",e.message));
const c=out.contracts["EffisendNFT.sol"].EffisendNFT; fs.mkdirSync("build",{recursive:true});
fs.writeFileSync("build/EffisendNFT.json",JSON.stringify({abi:c.abi,bytecode:"0x"+c.evm.bytecode.object},null,1));
console.log("ok evm",input.settings.evmVersion,"bytecode bytes",c.evm.bytecode.object.length/2);
