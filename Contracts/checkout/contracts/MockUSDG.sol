// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// MOCK for local tests only: mimics USDG's EIP-3009 (CallerMustBePayee, expiry, single-use nonce, and the silent no-op on a used nonce). Not the real token.
contract MockUSDG {
    string public constant name = "Global Dollar";
    string public constant symbol = "USDG";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    bytes32 public constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    error CallerMustBePayee();
    error AuthorizationExpired();
    error AuthorizationNotYetValid();
    error AuthorizationUsed();
    error InvalidSignature();
    error InsufficientBalance();

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsedEvent(address indexed authorizer, bytes32 indexed nonce);

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Global Dollar"), keccak256("1"), block.chainid, address(this)
        ));
    }

    // Tests only: simulates the payer's cancelAuthorization.
    function burnNonce(address from, bytes32 nonce) external { authorizationState[from][nonce] = true; }

    function mint(address to, uint256 v) external { totalSupply += v; balanceOf[to] += v; emit Transfer(address(0), to, v); }

    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }

    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) return; // the real USDG silently ignores an already used authorization
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce))));
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != from) revert InvalidSignature();
        authorizationState[from][nonce] = true;
        emit AuthorizationUsedEvent(from, nonce);
        _move(from, to, value);
    }

    function _move(address from, address to, uint256 v) internal {
        if (balanceOf[from] < v) revert InsufficientBalance();
        balanceOf[from] -= v; balanceOf[to] += v; emit Transfer(from, to, v);
    }
}
