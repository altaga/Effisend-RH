// Hardhat 3 is only used for its in-memory EVM in test.cjs; compile.cjs builds with solc directly.
export default {
  networks: {
    default: { type: "edr-simulated", hardfork: "cancun" },
  },
};
