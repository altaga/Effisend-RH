// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Checkout settles one USDG payment order on Robinhood Chain.
//
// Who does what
//   - operator: a key held by Effisend. It signs every order off-chain (EIP-712). Nothing is stored
//               on-chain until the order is paid, so creating an order costs no gas.
//   - payer:    signs a USDG "receiveWithAuthorization" (EIP-3009) that lets this contract pull exactly
//               the order amount, for that order only. Signing is a message, not a transaction.
//   - relayer:  anyone can send the payment transaction and pay its gas. Effisend runs one.
//
// Guarantees: the exact amount, one payment per order id, a hard expiry, and this contract never
// keeps funds: every payment ends with a zero USDG balance.

// The three USDG functions Checkout uses. receiveWithAuthorization is USDG's EIP-3009 entry point and
// only works when its caller is the `to` address: that is why this contract is the payee of the payment.
interface IUSDG {
    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// How pay() works: validate the order, verify the operator's signature, mark the order paid, pull the USDG
// with the payer's authorization, check the balance really grew, pay the splits and the merchant, and emit
// Paid. Any failure reverts the whole transaction, so no money moves.
contract Checkout {
    // A revenue share: `recipient` receives bps / 10,000 of the order amount (100 bps = 1%).
    struct Split { address recipient; uint16 bps; }
    // The order the operator signs. `expiry` is a unix timestamp. Whatever is left after the optional
    // splits goes to the merchant.
    struct Order { bytes32 id; address merchant; uint256 amount; uint256 expiry; Split[] splits; }
    // The payer's USDG authorization (an EIP-3009 signature split into v, r, s). Its time window,
    // validAfter..validBefore, is the payer's own and is separate from the order expiry.
    struct Auth { address from; uint256 validAfter; uint256 validBefore; uint8 v; bytes32 r; bytes32 s; }

    // The USDG token, set once at deployment.
    IUSDG public immutable usdg;
    // The key allowed to sign orders. It changes only through the two-step transfer below.
    address public operator;
    // The address proposed by transferOperator. It becomes the operator only when it calls acceptOperator.
    address public pendingOperator;
    // paid[orderId] turns true when an order is paid, so an order can never be paid twice.
    mapping(bytes32 => bool) public paid;

    // At most 5 splits per order: it keeps the gas of pay() bounded.
    uint256 public constant MAX_SPLITS = 5;
    // EIP-712 type hash of an order. `splitsHash` is the hash of its splits array.
    bytes32 public constant ORDER_TYPEHASH =
        keccak256("Order(bytes32 id,address merchant,uint256 amount,uint256 expiry,bytes32 splitsHash)");
    // The EIP-712 domain separator, computed once at deployment together with the chain id it was built for.
    bytes32 private immutable CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable CACHED_CHAIN_ID;
    // Half of the secp256k1 curve order. Signatures with s above it are rejected: they are the malleable
    // "twin" of a valid signature.
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // Errors: who may call, problems with the order or its signature, and a payment that did not arrive.
    error NotOperator();
    error NotPendingOperator();
    error InvalidOperator();
    error OrderExpired();
    error OrderAlreadyPaid();
    error InvalidOrder();
    error InvalidOrderSignature();
    error PaymentNotReceived();

    // Paid: one per order. `amount` is what the payer paid; `merchantAmount` is what the merchant received
    // after the splits.
    event Paid(bytes32 indexed id, address indexed payer, address indexed merchant, uint256 amount, uint256 merchantAmount);
    // SplitPaid: one per split that was paid. The other events record operator changes and rescued tokens.
    event SplitPaid(bytes32 indexed id, address indexed recipient, uint256 amount);
    event OperatorChanged(address indexed operator);
    event OperatorTransferStarted(address indexed current, address indexed pending);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    // usdg_ is the USDG token. operator_ is the key that signs orders; it never sends transactions, so it needs no ETH.
    constructor(address usdg_, address operator_) {
        usdg = IUSDG(usdg_);
        operator = operator_;
        CACHED_CHAIN_ID = block.chainid;
        CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    // EIP-712 domain separator. If the chain id ever changes (a chain fork) it is rebuilt, so signatures made
    // for one chain are not valid on the other.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == CACHED_CHAIN_ID ? CACHED_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("EffisendCheckout"), keccak256("1"), block.chainid, address(this)
        ));
    }

    // Step 1 of changing the operator: the current operator proposes a new address. It takes two steps so that
    // a mistyped address cannot leave the contract without a working operator.
    function transferOperator(address o) external {
        if (msg.sender != operator) revert NotOperator();
        if (o == address(0)) revert InvalidOperator();
        pendingOperator = o;
        emit OperatorTransferStarted(operator, o);
    }

    // Step 2: the proposed address accepts and becomes the operator.
    function acceptOperator() external {
        if (msg.sender != pendingOperator) revert NotPendingOperator();
        operator = msg.sender;
        pendingOperator = address(0);
        emit OperatorChanged(msg.sender);
    }

    // The contract never keeps funds in normal use. This only lets the operator return tokens that someone sent
    // to the contract by mistake. It uses a low-level call so it also works with tokens that return no value.
    function rescueTokens(address token, address to, uint256 amount) external {
        if (msg.sender != operator) revert NotOperator();
        if (to == address(0)) revert InvalidOrder();
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IUSDG.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "rescue failed");
        emit TokensRescued(token, to, amount);
    }

    // Settles one order. Anyone can call it (the payer or a relayer) and that is safe: the operator's signature
    // fixes the order, and the payer's authorization is tied to that exact order.
    //
    //   1. Check the order is well formed, not expired and not paid yet.
    //   2. Verify the operator signed it, and mark it paid before any money moves.
    //   3. Pull the USDG from the payer with USDG's receiveWithAuthorization.
    //   4. Pay the splits, then send everything that is left to the merchant.
    function pay(Order calldata o, bytes calldata operatorSig, Auth calldata a) external {
        // Sanity checks: at most 5 splits, a merchant, a positive amount, real split recipients, and shares that
        // add up to at most 100%.
        if (o.splits.length > MAX_SPLITS || o.merchant == address(0) || o.amount == 0) revert InvalidOrder();
        uint256 totalBps;
        for (uint256 i; i < o.splits.length; i++) {
            if (o.splits[i].recipient == address(0)) revert InvalidOrder();
            totalBps += o.splits[i].bps;
        }
        if (totalBps > 10_000) revert InvalidOrder();
        // The order must still be valid (the operator sets the expiry, 30 minutes in the app) and unpaid.
        if (block.timestamp > o.expiry) revert OrderExpired();
        if (paid[o.id]) revert OrderAlreadyPaid();

        // Only an order signed by the operator is accepted. It is marked paid before any external call, so it
        // cannot be paid again, not even by re-entering this function.
        bytes32 hash = orderHash(o);
        _checkOperator(hash, operatorSig);
        paid[o.id] = true;

        // Real USDG does not revert when an authorization was already used or cancelled: it silently does nothing.
        // So we measure our balance before and after, and require it grew by exactly the order amount. The payer's
        // nonce is keccak256(orderHash, payer): the authorization only works for this exact order.
        uint256 balanceBefore = usdg.balanceOf(address(this));
        usdg.receiveWithAuthorization(a.from, address(this), o.amount, a.validAfter, a.validBefore,
            nonceFor(hash, a.from), a.v, a.r, a.s);
        if (usdg.balanceOf(address(this)) - balanceBefore != o.amount) revert PaymentNotReceived();

        // Each split gets its share, rounded down. The merchant receives all that remains.
        uint256 remaining = o.amount;
        for (uint256 i; i < o.splits.length; i++) {
            uint256 part = (o.amount * o.splits[i].bps) / 10_000;
            if (part == 0) continue;
            remaining -= part;
            require(usdg.transfer(o.splits[i].recipient, part), "split transfer failed");
            emit SplitPaid(o.id, o.splits[i].recipient, part);
        }
        require(usdg.transfer(o.merchant, remaining), "merchant transfer failed");
        emit Paid(o.id, a.from, o.merchant, o.amount, remaining);
    }

    // The EIP-712 digest of an order: what the operator signs. The payer's nonce is derived from it, so the
    // payer's signature is tied to the same order.
    function orderHash(Order calldata o) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(ORDER_TYPEHASH, o.id, o.merchant, o.amount, o.expiry, keccak256(abi.encode(o.splits))));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    // The nonce of the payer's USDG authorization. It depends on the whole order hash, so an authorization signed
    // for one order cannot be used for another.
    function nonceFor(bytes32 hash, address from) public pure returns (bytes32) { return keccak256(abi.encode(hash, from)); }

    // Checks the operator's 65-byte signature (r, s, v): rejects malleable signatures and a zero signer.
    function _checkOperator(bytes32 hash, bytes calldata sig) private view {
        if (sig.length != 65) revert InvalidOrderSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert InvalidOrderSignature();
        address signer = ecrecover(hash, v, r, s);
        if (signer == address(0) || signer != operator) revert InvalidOrderSignature();
    }
}
