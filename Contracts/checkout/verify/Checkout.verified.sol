// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IUSDG {
    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// Checkout: la orden la firma el operador off-chain (EIP-712) y se verifica al pagar. El contrato es el payee de
// receiveWithAuthorization, reparte el split y registra el pago. No retiene fondos.
contract Checkout {
    struct Split { address recipient; uint16 bps; }
    struct Order { bytes32 id; address merchant; uint256 amount; uint256 expiry; Split[] splits; }
    struct Auth { address from; uint256 validAfter; uint256 validBefore; uint8 v; bytes32 r; bytes32 s; }

    IUSDG public immutable usdg;
    address public operator;
    address public pendingOperator;
    mapping(bytes32 => bool) public paid;

    uint256 public constant MAX_SPLITS = 5;
    bytes32 public constant ORDER_TYPEHASH =
        keccak256("Order(bytes32 id,address merchant,uint256 amount,uint256 expiry,bytes32 splitsHash)");
    bytes32 private immutable CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable CACHED_CHAIN_ID;
    // s <= n/2 (rechaza firmas maleables)
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    error NotOperator();
    error NotPendingOperator();
    error InvalidOperator();
    error OrderExpired();
    error OrderAlreadyPaid();
    error InvalidOrder();
    error InvalidOrderSignature();
    error PaymentNotReceived();

    event Paid(bytes32 indexed id, address indexed payer, address indexed merchant, uint256 amount, uint256 merchantAmount);
    event SplitPaid(bytes32 indexed id, address indexed recipient, uint256 amount);
    event OperatorChanged(address indexed operator);
    event OperatorTransferStarted(address indexed current, address indexed pending);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    constructor(address usdg_, address operator_) {
        usdg = IUSDG(usdg_);
        operator = operator_;
        CACHED_CHAIN_ID = block.chainid;
        CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    // Se recalcula si el chainId cambia (fork), para que las firmas de una cadena no valgan en la otra.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == CACHED_CHAIN_ID ? CACHED_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("EffisendCheckout"), keccak256("1"), block.chainid, address(this)
        ));
    }

    // Traspaso en dos pasos: el nuevo operador debe aceptar, así una dirección equivocada no deja el contrato sin operador.
    function transferOperator(address o) external {
        if (msg.sender != operator) revert NotOperator();
        if (o == address(0)) revert InvalidOperator();
        pendingOperator = o;
        emit OperatorTransferStarted(operator, o);
    }

    function acceptOperator() external {
        if (msg.sender != pendingOperator) revert NotPendingOperator();
        operator = msg.sender;
        pendingOperator = address(0);
        emit OperatorChanged(msg.sender);
    }

    // El contrato no retiene fondos en operación normal: esto solo recupera tokens enviados directo por error.
    function rescueTokens(address token, address to, uint256 amount) external {
        if (msg.sender != operator) revert NotOperator();
        if (to == address(0)) revert InvalidOrder();
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IUSDG.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "rescue failed");
        emit TokensRescued(token, to, amount);
    }

    // Cualquiera puede llamar (el pagador o un relayer). Los datos de la orden van firmados por el operador y el
    // nonce del cliente es hash(orden, pagador): su firma solo vale para esta orden exacta.
    function pay(Order calldata o, bytes calldata operatorSig, Auth calldata a) external {
        if (o.splits.length > MAX_SPLITS || o.merchant == address(0) || o.amount == 0) revert InvalidOrder();
        uint256 totalBps;
        for (uint256 i; i < o.splits.length; i++) {
            if (o.splits[i].recipient == address(0)) revert InvalidOrder();
            totalBps += o.splits[i].bps;
        }
        if (totalBps > 10_000) revert InvalidOrder();
        if (block.timestamp > o.expiry) revert OrderExpired();
        if (paid[o.id]) revert OrderAlreadyPaid();

        bytes32 hash = orderHash(o);
        _checkOperator(hash, operatorSig);
        paid[o.id] = true;

        // USDG ignora en silencio una autorización ya usada o anulada (no revierte): exigimos que el saldo suba exactamente el monto.
        uint256 balanceBefore = usdg.balanceOf(address(this));
        usdg.receiveWithAuthorization(a.from, address(this), o.amount, a.validAfter, a.validBefore,
            nonceFor(hash, a.from), a.v, a.r, a.s);
        if (usdg.balanceOf(address(this)) - balanceBefore != o.amount) revert PaymentNotReceived();

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

    function orderHash(Order calldata o) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(ORDER_TYPEHASH, o.id, o.merchant, o.amount, o.expiry, keccak256(abi.encode(o.splits))));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function nonceFor(bytes32 hash, address from) public pure returns (bytes32) { return keccak256(abi.encode(hash, from)); }

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
