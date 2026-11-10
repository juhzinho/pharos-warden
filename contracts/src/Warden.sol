// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The part of Uniswap's canonical Permit2 (SignatureTransfer) that Warden uses.
interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitBatchTransferFrom {
        TokenPermissions[] permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitBatchTransferFrom calldata permit,
        SignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/// @title Warden — an outcome guarantee for transactions an AI agent prepares on Pharos.
/// @notice The agent proposes an intent; the user signs its guarantees (a Permit2 signature whose witness is the
/// intent) and sends it. Warden pulls exactly the signed inputs, runs only allowlisted protocol calls, pays only
/// signed payees, returns every leftover, and reverts unless the user ends up with at least the signed minimums.
/// Each user also keeps an on-chain policy here: per-token limits per action and per day, the protocols they opted
/// into, approved payees, an expiry and a pause switch.
/// @dev No owner, no admin, no upgrade path. The protocol allowlist is fixed in the constructor.
contract Warden {
    // ─── Types ──────────────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Approve `spender` (an allowlisted protocol) to take `amount` of `token` from Warden, for this call only.
    struct Approval {
        address token;
        address spender;
        uint256 amount;
    }

    /// @notice A call to an allowlisted protocol contract. Warden never sends native PROS.
    struct Call {
        address target;
        bytes data;
    }

    /// @notice The user's balance of `token` must grow by at least `minDelta`.
    struct Out {
        address token;
        uint256 minDelta;
    }

    /// @notice Pay exactly `amount` of `token` to `to`.
    struct Pay {
        address token;
        address to;
        uint256 amount;
    }

    struct Intent {
        address user;
        Approval[] approvals;
        Call[] calls;
        Out[] outs;
        Pay[] pays;
        uint256 deadline;
        bytes32 planId;
    }

    struct Limit {
        uint128 perAction;
        uint128 perDay;
    }

    struct Policy {
        uint64 expiry; // 0 = no expiry
        uint32 protocols; // bit i = protocol i allowed
        bool paused;
        bool payeesOnly; // payments only to payees the user approved
        bool exists;
    }

    // ─── EIP-712 witness ────────────────────────────────────────────────────────────────────────────────────────

    string public constant WITNESS_TYPE_STRING =
        "Intent witness)Intent(address user,bytes32 actionsHash,Out[] outs,Pay[] pays,uint256 deadline,bytes32 planId)Out(address token,uint256 minDelta)Pay(address token,address to,uint256 amount)TokenPermissions(address token,uint256 amount)";

    bytes32 public constant OUT_TYPEHASH = keccak256("Out(address token,uint256 minDelta)");
    bytes32 public constant PAY_TYPEHASH = keccak256("Pay(address token,address to,uint256 amount)");
    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(address user,bytes32 actionsHash,Out[] outs,Pay[] pays,uint256 deadline,bytes32 planId)Out(address token,uint256 minDelta)Pay(address token,address to,uint256 amount)"
    );

    // ─── Immutable configuration ────────────────────────────────────────────────────────────────────────────────

    ISignatureTransfer public immutable PERMIT2;

    /// @notice Protocol id + 1 for each allowlisted call target (0 = not allowlisted).
    mapping(address => uint8) public targetProtocol;
    /// @notice Protocol id + 1 for each allowlisted approval spender (0 = not allowlisted).
    mapping(address => uint8) public spenderProtocol;
    /// @notice Human-readable protocol names, by id.
    string[] public protocolNames;

    // ─── Per-user state ─────────────────────────────────────────────────────────────────────────────────────────

    mapping(address => Policy) public policyOf;
    mapping(address => mapping(address => Limit)) public limitOf;
    /// @dev user => token => day (block.timestamp / 1 days) => amount spent through Warden that day.
    mapping(address => mapping(address => mapping(uint256 => uint256))) public spentOn;
    mapping(address => mapping(address => bool)) public payeeAllowed;

    uint256 private locked = 1;

    // ─── Events ─────────────────────────────────────────────────────────────────────────────────────────────────

    event LimitSet(address indexed user, address indexed token, uint128 perAction, uint128 perDay);
    event ProtocolsSet(address indexed user, uint32 protocols);
    event PayeeSet(address indexed user, address indexed payee, bool allowed);
    event PayeesOnlySet(address indexed user, bool payeesOnly);
    event ExpirySet(address indexed user, uint64 expiry);
    event PausedSet(address indexed user, bool paused);
    event Spent(address indexed user, address indexed token, uint256 amount);
    event Paid(address indexed user, address indexed token, address indexed to, uint256 amount);
    event Delivered(address indexed user, address indexed token, uint256 minDelta, uint256 delta);
    event Executed(address indexed user, bytes32 indexed planId, bytes32 witness);

    // ─── Errors ─────────────────────────────────────────────────────────────────────────────────────────────────

    error NotIntentUser();
    error IntentExpired(uint256 deadline);
    error NoPolicy();
    error PolicyPaused();
    error PolicyExpired(uint64 expiry);
    error NoLimit(address token);
    error OverActionLimit(address token, uint256 amount, uint256 limit);
    error OverDailyLimit(address token, uint256 spentToday, uint256 amount, uint256 limit);
    error TargetNotAllowed(address target);
    error SpenderNotAllowed(address spender);
    error ProtocolNotEnabled(uint8 protocol);
    error PayeeNotAllowed(address payee);
    error BadPayee(address payee);
    error NoGuarantee();
    error SelectorNotAllowed(bytes4 selector);
    error OutBelowMinimum(address token, uint256 minDelta, uint256 delta);
    error CallFailed(uint256 index, bytes reason);
    error TokenCallFailed(address token);
    error Reentrancy();
    error BadConfig();

    // ─── Construction ───────────────────────────────────────────────────────────────────────────────────────────

    /// @param permit2 Canonical Permit2.
    /// @param names Protocol names; protocol i is names[i].
    /// @param targets Call targets; targets[j] belongs to protocol targetIds[j].
    /// @param spenders Approval spenders; spenders[k] belongs to protocol spenderIds[k].
    constructor(
        address permit2,
        string[] memory names,
        address[] memory targets,
        uint8[] memory targetIds,
        address[] memory spenders,
        uint8[] memory spenderIds
    ) {
        if (permit2.code.length == 0 || names.length == 0 || names.length > 32) revert BadConfig();
        if (targets.length != targetIds.length || spenders.length != spenderIds.length) revert BadConfig();
        PERMIT2 = ISignatureTransfer(permit2);
        for (uint256 i; i < names.length; ++i) protocolNames.push(names[i]);
        for (uint256 j; j < targets.length; ++j) {
            if (targetIds[j] >= names.length || targets[j].code.length == 0 || targets[j] == permit2) revert BadConfig();
            targetProtocol[targets[j]] = targetIds[j] + 1;
        }
        for (uint256 k; k < spenders.length; ++k) {
            if (spenderIds[k] >= names.length || spenders[k].code.length == 0) revert BadConfig();
            spenderProtocol[spenders[k]] = spenderIds[k] + 1;
        }
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    // ─── Policy (set by each user for themselves) ───────────────────────────────────────────────────────────────

    function setLimit(address token, uint128 perAction, uint128 perDay) external {
        _touch();
        limitOf[msg.sender][token] = Limit(perAction, perDay);
        emit LimitSet(msg.sender, token, perAction, perDay);
    }

    function setProtocols(uint32 protocols) external {
        _touch().protocols = protocols;
        emit ProtocolsSet(msg.sender, protocols);
    }

    function setPayee(address payee, bool allowed) external {
        if (payee == address(0) || payee == address(this) || payee == msg.sender) revert BadPayee(payee);
        _touch();
        payeeAllowed[msg.sender][payee] = allowed;
        emit PayeeSet(msg.sender, payee, allowed);
    }

    function setPayeesOnly(bool payeesOnly) external {
        _touch().payeesOnly = payeesOnly;
        emit PayeesOnlySet(msg.sender, payeesOnly);
    }

    function setExpiry(uint64 expiry) external {
        _touch().expiry = expiry;
        emit ExpirySet(msg.sender, expiry);
    }

    function pause() external {
        _touch().paused = true;
        emit PausedSet(msg.sender, true);
    }

    function unpause() external {
        _touch().paused = false;
        emit PausedSet(msg.sender, false);
    }

    /// @notice One transaction to set up (or replace) a whole policy.
    function configure(
        address[] calldata tokens,
        uint128[] calldata perAction,
        uint128[] calldata perDay,
        uint32 protocols,
        bool payeesOnly,
        uint64 expiry
    ) external {
        if (tokens.length != perAction.length || tokens.length != perDay.length) revert BadConfig();
        Policy storage p = _touch();
        p.protocols = protocols;
        p.payeesOnly = payeesOnly;
        p.expiry = expiry;
        p.paused = false;
        for (uint256 i; i < tokens.length; ++i) {
            limitOf[msg.sender][tokens[i]] = Limit(perAction[i], perDay[i]);
            emit LimitSet(msg.sender, tokens[i], perAction[i], perDay[i]);
        }
        emit ProtocolsSet(msg.sender, protocols);
        emit PayeesOnlySet(msg.sender, payeesOnly);
        emit ExpirySet(msg.sender, expiry);
        emit PausedSet(msg.sender, false);
    }

    function _touch() private returns (Policy storage p) {
        p = policyOf[msg.sender];
        p.exists = true;
    }

    function protocolCount() external view returns (uint256) {
        return protocolNames.length;
    }

    /// @notice How much more of `token` `user` can spend through Warden today, and in one action.
    function remaining(address user, address token) external view returns (uint256 action, uint256 today) {
        Limit memory l = limitOf[user][token];
        uint256 spent = spentOn[user][token][block.timestamp / 1 days];
        return (l.perAction, spent >= l.perDay ? 0 : l.perDay - spent);
    }

    // ─── Witness ────────────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The hash of everything the intent does besides its guarantees (approvals and calls).
    function actionsHash(Approval[] calldata approvals, Call[] calldata calls) public pure returns (bytes32) {
        return keccak256(abi.encode(approvals, calls));
    }

    /// @notice The EIP-712 struct hash the user signs as the Permit2 witness.
    function witnessOf(Intent calldata intent) public pure returns (bytes32) {
        bytes32[] memory outHashes = new bytes32[](intent.outs.length);
        for (uint256 i; i < intent.outs.length; ++i) {
            outHashes[i] = keccak256(abi.encode(OUT_TYPEHASH, intent.outs[i].token, intent.outs[i].minDelta));
        }
        bytes32[] memory payHashes = new bytes32[](intent.pays.length);
        for (uint256 i; i < intent.pays.length; ++i) {
            payHashes[i] = keccak256(abi.encode(PAY_TYPEHASH, intent.pays[i].token, intent.pays[i].to, intent.pays[i].amount));
        }
        return keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.user,
                actionsHash(intent.approvals, intent.calls),
                keccak256(abi.encodePacked(outHashes)),
                keccak256(abi.encodePacked(payHashes)),
                intent.deadline,
                intent.planId
            )
        );
    }

    // ─── Execution ──────────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Run an intent the caller signed. Reverts — and nothing moves — unless every guarantee holds.
    /// @param intent What to do and what it must deliver.
    /// @param permit The signed Permit2 batch: exactly the tokens and amounts Warden may pull from the user.
    /// @param signature The user's Permit2 signature over `permit` with `witnessOf(intent)` as the witness.
    function execute(
        Intent calldata intent,
        ISignatureTransfer.PermitBatchTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant {
        address user = intent.user;
        if (msg.sender != user) revert NotIntentUser();
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline);
        // Something must be guaranteed: a minimum the user receives or an exact payment the user signed.
        if (intent.outs.length + intent.pays.length == 0) revert NoGuarantee();
        Policy memory p = policyOf[user];
        if (!p.exists) revert NoPolicy();
        if (p.paused) revert PolicyPaused();
        if (p.expiry != 0 && block.timestamp > p.expiry) revert PolicyExpired(p.expiry);

        // 1. Policy: every input token needs a limit, per action and per day.
        uint256 n = permit.permitted.length;
        ISignatureTransfer.SignatureTransferDetails[] memory details = new ISignatureTransfer.SignatureTransferDetails[](n);
        uint256 day = block.timestamp / 1 days;
        for (uint256 i; i < n; ++i) {
            address token = permit.permitted[i].token;
            uint256 amount = permit.permitted[i].amount;
            Limit memory l = limitOf[user][token];
            if (l.perAction == 0) revert NoLimit(token);
            if (amount > l.perAction) revert OverActionLimit(token, amount, l.perAction);
            uint256 spentToday = spentOn[user][token][day];
            if (spentToday + amount > l.perDay) revert OverDailyLimit(token, spentToday, amount, l.perDay);
            spentOn[user][token][day] = spentToday + amount;
            details[i] = ISignatureTransfer.SignatureTransferDetails(address(this), amount);
            emit Spent(user, token, amount);
        }

        // 2. The user's balances before, for every guaranteed output.
        uint256[] memory before = new uint256[](intent.outs.length);
        for (uint256 i; i < intent.outs.length; ++i) before[i] = IERC20(intent.outs[i].token).balanceOf(user);

        // 3. Pull exactly the signed inputs. Permit2 checks the signature, the nonce, the deadline and the witness.
        bytes32 witness = witnessOf(intent);
        PERMIT2.permitWitnessTransferFrom(permit, details, user, witness, WITNESS_TYPE_STRING, signature);

        // 4. Exact approvals to allowlisted spenders, the calls, then every approval back to zero.
        for (uint256 i; i < intent.approvals.length; ++i) {
            Approval calldata a = intent.approvals[i];
            uint8 id = spenderProtocol[a.spender];
            if (id == 0) revert SpenderNotAllowed(a.spender);
            _requireProtocol(p, id - 1);
            _approve(a.token, a.spender, a.amount);
        }
        for (uint256 i; i < intent.calls.length; ++i) {
            Call calldata c = intent.calls[i];
            uint8 id = targetProtocol[c.target];
            if (id == 0) revert TargetNotAllowed(c.target);
            _requireProtocol(p, id - 1);
            _requireNotTokenMove(c.data);
            (bool ok, bytes memory reason) = c.target.call(c.data);
            if (!ok) revert CallFailed(i, reason);
        }
        for (uint256 i; i < intent.approvals.length; ++i) _approve(intent.approvals[i].token, intent.approvals[i].spender, 0);

        // 5. Payments, exactly as signed.
        for (uint256 i; i < intent.pays.length; ++i) {
            Pay calldata pay = intent.pays[i];
            if (pay.to == address(0) || pay.to == address(this) || pay.to == user) revert BadPayee(pay.to);
            if (p.payeesOnly && !payeeAllowed[user][pay.to]) revert PayeeNotAllowed(pay.to);
            _transfer(pay.token, pay.to, pay.amount);
            emit Paid(user, pay.token, pay.to, pay.amount);
        }

        // 6. Everything Warden still holds of the tokens it touched goes back to the user.
        for (uint256 i; i < n; ++i) _sweep(permit.permitted[i].token, user);
        for (uint256 i; i < intent.outs.length; ++i) _sweep(intent.outs[i].token, user);

        // 7. The guarantees, against the user's real balances.
        for (uint256 i; i < intent.outs.length; ++i) {
            uint256 nowBal = IERC20(intent.outs[i].token).balanceOf(user);
            uint256 delta = nowBal > before[i] ? nowBal - before[i] : 0;
            if (delta < intent.outs[i].minDelta) revert OutBelowMinimum(intent.outs[i].token, intent.outs[i].minDelta, delta);
            emit Delivered(user, intent.outs[i].token, intent.outs[i].minDelta, delta);
        }
        emit Executed(user, intent.planId, witness);
    }

    // ─── Internals ──────────────────────────────────────────────────────────────────────────────────────────────

    function _requireProtocol(Policy memory p, uint8 id) private pure {
        if (p.protocols & (uint32(1) << id) == 0) revert ProtocolNotEnabled(id);
    }

    /// @dev Vault shares are ERC-20 tokens too: a "protocol call" may never move or approve tokens directly.
    /// Moving tokens is Warden's own job (approvals, payments, sweep), always to the user or an allowlisted spender.
    function _requireNotTokenMove(bytes calldata data) private pure {
        if (data.length < 4) revert SelectorNotAllowed(bytes4(0));
        bytes4 s = bytes4(data[:4]);
        if (
            s == 0xa9059cbb // transfer(address,uint256)
                || s == 0x23b872dd // transferFrom(address,address,uint256)
                || s == 0x095ea7b3 // approve(address,uint256)
                || s == 0x39509351 // increaseAllowance(address,uint256)
                || s == 0xd505accf // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
                || s == 0xe3ee160e // transferWithAuthorization(...)
        ) revert SelectorNotAllowed(s);
    }

    function _sweep(address token, address to) private {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal != 0) _transfer(token, to, bal);
    }

    /// @dev Works with tokens that return nothing and with tokens that return a bool.
    function _transfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed(token);
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed(token);
    }
}
