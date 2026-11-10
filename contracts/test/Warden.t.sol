// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Warden, ISignatureTransfer} from "../src/Warden.sol";
import {PacificConfig} from "../script/PacificConfig.sol";

interface IERC20Full {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IVault {
    function previewDeposit(uint256 assets) external view returns (uint256);
    function deposit(uint256 assets, address onBehalf) external returns (uint256);
}

interface IRouteProxy {
    function mixSwap(
        address fromToken,
        address toToken,
        uint256 fromTokenAmount,
        uint256 expReturnAmount,
        uint256 minReturnAmount,
        address[] memory mixAdapters,
        address[] memory mixPairs,
        address[] memory assetTo,
        uint256 directions,
        bytes[] memory moreInfos,
        bytes memory feeData,
        uint256 deadLine
    ) external payable returns (uint256);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
}

/// @notice Every test runs against a fork of Pharos Pacific Mainnet: the real Permit2, USDC, WPROS, FaroSwap,
/// Morpho vaults and Avalon pool. Only the test user's balances are written into the fork.
contract WardenTest is Test, PacificConfig {
    Warden warden;
    uint256 userKey = 0xA11CE;
    address user;
    address payee = address(0xBEEF);
    uint256 nonce;

    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    function setUp() public {
        vm.createSelectFork("pacific");
        warden = deploy();
        user = vm.addr(userKey);
        // 1,000 USDC: FiatToken keeps balances in slot 9 (the top bit is the blacklist flag, left clear).
        vm.store(USDC, keccak256(abi.encode(user, uint256(9))), bytes32(uint256(1_000e6)));
        assertEq(IERC20Full(USDC).balanceOf(user), 1_000e6);
        deal(WPROS, user, 100 ether);
        vm.startPrank(user);
        IERC20Full(USDC).approve(PERMIT2, type(uint256).max);
        IERC20Full(WPROS).approve(PERMIT2, type(uint256).max);
        vm.stopPrank();
    }

    // ─── helpers ────────────────────────────────────────────────────────────────────────────────────────────────

    function _policy(uint128 perAction, uint128 perDay) internal {
        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = WPROS;
        uint128[] memory pa = new uint128[](2);
        uint128[] memory pd = new uint128[](2);
        pa[0] = perAction;
        pd[0] = perDay;
        pa[1] = 50 ether;
        pd[1] = 100 ether;
        vm.prank(user);
        warden.configure(tokens, pa, pd, uint32(0xF), false, 0);
    }

    function _intent() internal view returns (Warden.Intent memory it) {
        it.user = user;
        it.deadline = block.timestamp + 600;
        it.planId = keccak256("test-plan");
    }

    function _permit(address token, uint256 amount) internal returns (ISignatureTransfer.PermitBatchTransferFrom memory p) {
        p.permitted = new ISignatureTransfer.TokenPermissions[](1);
        p.permitted[0] = ISignatureTransfer.TokenPermissions(token, amount);
        p.nonce = ++nonce;
        p.deadline = block.timestamp + 600;
    }

    function _sign(ISignatureTransfer.PermitBatchTransferFrom memory p, bytes32 witness, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        bytes32[] memory hashes = new bytes32[](p.permitted.length);
        for (uint256 i; i < p.permitted.length; ++i) {
            hashes[i] = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted[i].token, p.permitted[i].amount));
        }
        bytes32 typehash = keccak256(
            abi.encodePacked(
                "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,",
                warden.WITNESS_TYPE_STRING()
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(typehash, keccak256(abi.encodePacked(hashes)), address(warden), p.nonce, p.deadline, witness));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _mixSwap(address from, address to, uint256 amount, uint256 expReturn, uint256 minReturn, uint256 direction)
        internal
        view
        returns (bytes memory)
    {
        address[] memory adapters = new address[](1);
        adapters[0] = FAROSWAP_ADAPTER;
        address[] memory pairs = new address[](1);
        pairs[0] = FAROSWAP_POOL;
        address[] memory assetTo = new address[](2);
        assetTo[0] = FAROSWAP_ADAPTER;
        assetTo[1] = FAROSWAP_ROUTE_PROXY;
        address tokenIn = direction == 0 ? WPROS : USDC;
        address tokenOut = direction == 0 ? USDC : WPROS;
        bytes[] memory infos = new bytes[](1);
        infos[0] = abi.encode(uint256(0), abi.encode(tokenIn, tokenOut, uint24(100)));
        return abi.encodeCall(
            IRouteProxy.mixSwap,
            (from, to, amount, expReturn, minReturn, adapters, pairs, assetTo, direction, infos, abi.encode(address(0), uint256(0)), block.timestamp + 600)
        );
    }

    /// @dev The exact output of a 20 USDC → WPROS swap right now, by running it from a funded account and reverting.
    function _quoteUsdcToWpros(uint256 amount) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        address q = address(0xC0FFEE);
        vm.store(USDC, keccak256(abi.encode(q, uint256(9))), bytes32(amount));
        vm.startPrank(q);
        IERC20Full(USDC).approve(FAROSWAP_DODO_APPROVE, amount);
        (bool ok, bytes memory ret) = FAROSWAP_ROUTE_PROXY.call(_mixSwap(USDC, WPROS, amount, 1e30, 1, 1));
        vm.stopPrank();
        require(ok, "quote failed");
        out = abi.decode(ret, (uint256));
        vm.revertToState(snap);
    }

    function _swapIntent(uint256 amount, uint256 expReturn, uint256 minOut) internal view returns (Warden.Intent memory it) {
        it = _intent();
        it.approvals = new Warden.Approval[](1);
        it.approvals[0] = Warden.Approval(USDC, FAROSWAP_DODO_APPROVE, amount);
        it.calls = new Warden.Call[](1);
        it.calls[0] = Warden.Call(FAROSWAP_ROUTE_PROXY, _mixSwap(USDC, WPROS, amount, expReturn, 1, 1));
        it.outs = new Warden.Out[](1);
        it.outs[0] = Warden.Out(WPROS, minOut);
    }

    function _run(Warden.Intent memory it, ISignatureTransfer.PermitBatchTransferFrom memory p) internal {
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.prank(user);
        warden.execute(it, p, sig);
    }

    function _assertWardenEmpty() internal view {
        assertEq(IERC20Full(USDC).balanceOf(address(warden)), 0, "warden holds USDC");
        assertEq(IERC20Full(WPROS).balanceOf(address(warden)), 0, "warden holds WPROS");
        assertEq(IERC20Full(USDC).allowance(address(warden), FAROSWAP_DODO_APPROVE), 0, "approval left");
    }

    // ─── deployment ─────────────────────────────────────────────────────────────────────────────────────────────

    function test_allowlistIsFixedAtDeployment() public view {
        assertEq(warden.protocolCount(), 4);
        assertEq(warden.protocolNames(0), "FaroSwap");
        assertEq(warden.targetProtocol(FAROSWAP_ROUTE_PROXY), 1);
        assertEq(warden.spenderProtocol(FAROSWAP_DODO_APPROVE), 1);
        assertEq(warden.targetProtocol(MORPHO_ROCKAWAYX), 2);
        assertEq(warden.targetProtocol(MORPHO_SHARPBYTE), 3);
        assertEq(warden.targetProtocol(AVALON_POOL), 4);
        assertEq(warden.targetProtocol(USDC), 0);
        assertEq(warden.targetProtocol(PERMIT2), 0);
    }

    // ─── happy paths ────────────────────────────────────────────────────────────────────────────────────────────

    function test_swapUsdcToWprosDeliversAtLeastTheSignedMinimum() public {
        _policy(100e6, 300e6);
        uint256 quote = _quoteUsdcToWpros(20e6);
        uint256 minOut = quote * 9950 / 10000;
        uint256 wBefore = IERC20Full(WPROS).balanceOf(user);
        uint256 uBefore = IERC20Full(USDC).balanceOf(user);
        _run(_swapIntent(20e6, quote, minOut), _permit(USDC, 20e6));
        assertGe(IERC20Full(WPROS).balanceOf(user) - wBefore, minOut);
        assertEq(uBefore - IERC20Full(USDC).balanceOf(user), 20e6);
        _assertWardenEmpty();
        (, uint256 today) = warden.remaining(user, USDC);
        assertEq(today, 280e6);
    }

    function test_depositIntoMorphoVaultSharesGoToTheUser() public {
        _policy(100e6, 300e6);
        uint256 shares = IVault(MORPHO_ROCKAWAYX).previewDeposit(50e6);
        Warden.Intent memory it = _intent();
        it.approvals = new Warden.Approval[](1);
        it.approvals[0] = Warden.Approval(USDC, MORPHO_ROCKAWAYX, 50e6);
        it.calls = new Warden.Call[](1);
        it.calls[0] = Warden.Call(MORPHO_ROCKAWAYX, abi.encodeCall(IVault.deposit, (50e6, user)));
        it.outs = new Warden.Out[](1);
        it.outs[0] = Warden.Out(MORPHO_ROCKAWAYX, shares * 9999 / 10000);
        uint256 before = IERC20Full(MORPHO_ROCKAWAYX).balanceOf(user);
        _run(it, _permit(USDC, 50e6));
        assertGe(IERC20Full(MORPHO_ROCKAWAYX).balanceOf(user) - before, shares * 9999 / 10000);
        assertEq(IERC20Full(MORPHO_ROCKAWAYX).allowance(address(warden), MORPHO_ROCKAWAYX), 0);
        _assertWardenEmpty();
    }

    function test_supplyToAvalonATokensGoToTheUser() public {
        _policy(100e6, 300e6);
        Warden.Intent memory it = _intent();
        it.approvals = new Warden.Approval[](1);
        it.approvals[0] = Warden.Approval(USDC, AVALON_POOL, 30e6);
        it.calls = new Warden.Call[](1);
        it.calls[0] = Warden.Call(AVALON_POOL, abi.encodeCall(IAavePool.supply, (USDC, 30e6, user, 0)));
        it.outs = new Warden.Out[](1);
        it.outs[0] = Warden.Out(AVALON_AUSDC, 30e6 - 1);
        uint256 before = IERC20Full(AVALON_AUSDC).balanceOf(user);
        _run(it, _permit(USDC, 30e6));
        assertGe(IERC20Full(AVALON_AUSDC).balanceOf(user) - before, 30e6 - 1);
        _assertWardenEmpty();
    }

    function test_paymentPaysExactlyAndReturnsTheRest() public {
        _policy(100e6, 300e6);
        Warden.Intent memory it = _intent();
        it.pays = new Warden.Pay[](1);
        it.pays[0] = Warden.Pay(USDC, payee, 7e6);
        uint256 before = IERC20Full(USDC).balanceOf(user);
        _run(it, _permit(USDC, 10e6)); // 10 pulled, 7 paid, 3 back
        assertEq(IERC20Full(USDC).balanceOf(payee), 7e6);
        assertEq(before - IERC20Full(USDC).balanceOf(user), 7e6);
        _assertWardenEmpty();
    }

    // ─── guarantees ─────────────────────────────────────────────────────────────────────────────────────────────

    function test_revertsWhenTheSwapDeliversLessThanSigned() public {
        _policy(100e6, 300e6);
        uint256 quote = _quoteUsdcToWpros(20e6);
        Warden.Intent memory it = _swapIntent(20e6, quote, quote * 2); // asks for twice the market
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 20e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        uint256 before = IERC20Full(USDC).balanceOf(user);
        vm.prank(user);
        vm.expectPartialRevert(Warden.OutBelowMinimum.selector);
        warden.execute(it, p, sig);
        assertEq(IERC20Full(USDC).balanceOf(user), before, "nothing moved");
    }

    function test_outputSentToSomeoneElseFailsTheGuarantee() public {
        _policy(100e6, 300e6);
        Warden.Intent memory it = _intent();
        it.approvals = new Warden.Approval[](1);
        it.approvals[0] = Warden.Approval(USDC, MORPHO_ROCKAWAYX, 50e6);
        it.calls = new Warden.Call[](1);
        it.calls[0] = Warden.Call(MORPHO_ROCKAWAYX, abi.encodeCall(IVault.deposit, (50e6, address(0xBAD))));
        it.outs = new Warden.Out[](1);
        it.outs[0] = Warden.Out(MORPHO_ROCKAWAYX, 1);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 50e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Warden.OutBelowMinimum.selector, MORPHO_ROCKAWAYX, 1, 0));
        warden.execute(it, p, sig);
    }

    function test_changingTheGuaranteeAfterSigningInvalidatesTheSignature() public {
        _policy(100e6, 300e6);
        uint256 quote = _quoteUsdcToWpros(20e6);
        Warden.Intent memory it = _swapIntent(20e6, quote, quote * 9950 / 10000);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 20e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        it.outs[0].minDelta = 1; // a frontend lowering the minimum after the user signed
        vm.prank(user);
        vm.expectRevert(); // Permit2 InvalidSigner
        warden.execute(it, p, sig);
    }

    function test_aSignatureCannotBeReplayed() public {
        _policy(100e6, 300e6);
        Warden.Intent memory it = _intent();
        it.pays = new Warden.Pay[](1);
        it.pays[0] = Warden.Pay(USDC, payee, 1e6);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 1e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.startPrank(user);
        warden.execute(it, p, sig);
        vm.expectRevert(); // Permit2 InvalidNonce
        warden.execute(it, p, sig);
        vm.stopPrank();
    }

    function test_onlyTheSignerCanRunTheirIntent() public {
        _policy(100e6, 300e6);
        Warden.Intent memory it = _intent();
        it.pays = new Warden.Pay[](1);
        it.pays[0] = Warden.Pay(USDC, payee, 1e6);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 1e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.prank(payee);
        vm.expectRevert(Warden.NotIntentUser.selector);
        warden.execute(it, p, sig);
    }

    function test_anIntentMustGuaranteeSomething() public {
        _policy(100e6, 300e6);
        Warden.Intent memory it = _intent();
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 1e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.prank(user);
        vm.expectRevert(Warden.NoGuarantee.selector);
        warden.execute(it, p, sig);
    }

    function test_expiredIntentIsRefused() public {
        _policy(100e6, 300e6);
        Warden.Intent memory it = _intent();
        it.pays = new Warden.Pay[](1);
        it.pays[0] = Warden.Pay(USDC, payee, 1e6);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 1e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.warp(it.deadline + 1);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Warden.IntentExpired.selector, it.deadline));
        warden.execute(it, p, sig);
    }

    // ─── policy ─────────────────────────────────────────────────────────────────────────────────────────────────

    function _pay1() internal returns (Warden.Intent memory it, ISignatureTransfer.PermitBatchTransferFrom memory p, bytes memory sig) {
        it = _intent();
        it.pays = new Warden.Pay[](1);
        it.pays[0] = Warden.Pay(USDC, payee, 1e6);
        p = _permit(USDC, 1e6);
        sig = _sign(p, warden.witnessOf(it), userKey);
    }

    function test_noPolicyNoSpending() public {
        (Warden.Intent memory it, ISignatureTransfer.PermitBatchTransferFrom memory p, bytes memory sig) = _pay1();
        vm.prank(user);
        vm.expectRevert(Warden.NoPolicy.selector);
        warden.execute(it, p, sig);
    }

    function test_aTokenWithoutALimitCannotBeSpent() public {
        vm.prank(user);
        warden.setProtocols(0xF);
        (Warden.Intent memory it, ISignatureTransfer.PermitBatchTransferFrom memory p, bytes memory sig) = _pay1();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Warden.NoLimit.selector, USDC));
        warden.execute(it, p, sig);
    }

    function test_perActionLimit() public {
        _policy(10e6, 300e6);
        Warden.Intent memory it = _intent();
        it.pays = new Warden.Pay[](1);
        it.pays[0] = Warden.Pay(USDC, payee, 11e6);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 11e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Warden.OverActionLimit.selector, USDC, 11e6, 10e6));
        warden.execute(it, p, sig);
    }

    function test_dailyLimitAcrossActionsAndResetNextDay() public {
        _policy(10e6, 15e6);
        Warden.Intent memory it = _intent();
        it.pays = new Warden.Pay[](1);
        it.pays[0] = Warden.Pay(USDC, payee, 10e6);
        _run(it, _permit(USDC, 10e6));
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 10e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Warden.OverDailyLimit.selector, USDC, 10e6, 10e6, 15e6));
        warden.execute(it, p, sig);
        vm.warp(block.timestamp + 1 days);
        it.deadline = block.timestamp + 600;
        p = _permit(USDC, 10e6);
        p.deadline = block.timestamp + 600;
        _run(it, p);
        assertEq(IERC20Full(USDC).balanceOf(payee), 20e6);
    }

    function test_pausedPolicyBlocksEverything() public {
        _policy(100e6, 300e6);
        vm.prank(user);
        warden.pause();
        (Warden.Intent memory it, ISignatureTransfer.PermitBatchTransferFrom memory p, bytes memory sig) = _pay1();
        vm.prank(user);
        vm.expectRevert(Warden.PolicyPaused.selector);
        warden.execute(it, p, sig);
    }

    function test_expiredPolicyBlocksEverything() public {
        _policy(100e6, 300e6);
        vm.prank(user);
        warden.setExpiry(uint64(block.timestamp + 10));
        vm.warp(block.timestamp + 11);
        (Warden.Intent memory it, ISignatureTransfer.PermitBatchTransferFrom memory p, bytes memory sig) = _pay1();
        vm.prank(user);
        vm.expectPartialRevert(Warden.PolicyExpired.selector);
        warden.execute(it, p, sig);
    }

    function test_payeesOnlyRequiresAnApprovedPayee() public {
        _policy(100e6, 300e6);
        vm.prank(user);
        warden.setPayeesOnly(true);
        (Warden.Intent memory it, ISignatureTransfer.PermitBatchTransferFrom memory p, bytes memory sig) = _pay1();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Warden.PayeeNotAllowed.selector, payee));
        warden.execute(it, p, sig);
        vm.prank(user);
        warden.setPayee(payee, true);
        (it, p, sig) = _pay1();
        vm.prank(user);
        warden.execute(it, p, sig);
        assertEq(IERC20Full(USDC).balanceOf(payee), 1e6);
    }

    function test_protocolMustBeEnabledByTheUser() public {
        _policy(100e6, 300e6);
        vm.prank(user);
        warden.setProtocols(0x1); // FaroSwap only
        Warden.Intent memory it = _intent();
        it.approvals = new Warden.Approval[](1);
        it.approvals[0] = Warden.Approval(USDC, AVALON_POOL, 30e6);
        it.calls = new Warden.Call[](1);
        it.calls[0] = Warden.Call(AVALON_POOL, abi.encodeCall(IAavePool.supply, (USDC, 30e6, user, 0)));
        it.outs = new Warden.Out[](1);
        it.outs[0] = Warden.Out(AVALON_AUSDC, 1);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 30e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Warden.ProtocolNotEnabled.selector, uint8(3)));
        warden.execute(it, p, sig);
    }

    // ─── allowlist ──────────────────────────────────────────────────────────────────────────────────────────────

    function test_unknownTargetIsRefused() public {
        _policy(100e6, 300e6);
        Warden.Intent memory it = _intent();
        it.calls = new Warden.Call[](1);
        it.calls[0] = Warden.Call(USDC, abi.encodeCall(IERC20Full.transfer, (address(0xBAD), 1e6)));
        it.outs = new Warden.Out[](1);
        it.outs[0] = Warden.Out(USDC, 0);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 1e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Warden.TargetNotAllowed.selector, USDC));
        warden.execute(it, p, sig);
    }

    function test_unknownSpenderIsRefused() public {
        _policy(100e6, 300e6);
        Warden.Intent memory it = _intent();
        it.approvals = new Warden.Approval[](1);
        it.approvals[0] = Warden.Approval(USDC, address(0xBAD), 1e6);
        it.outs = new Warden.Out[](1);
        it.outs[0] = Warden.Out(USDC, 0);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 1e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Warden.SpenderNotAllowed.selector, address(0xBAD)));
        warden.execute(it, p, sig);
    }

    function test_aProtocolCallCannotMoveTokensDirectly() public {
        _policy(100e6, 300e6);
        // vault shares are an ERC-20: "calling the vault" with transfer() must be refused
        Warden.Intent memory it = _intent();
        it.calls = new Warden.Call[](1);
        it.calls[0] = Warden.Call(MORPHO_ROCKAWAYX, abi.encodeCall(IERC20Full.transfer, (address(0xBAD), 1)));
        it.outs = new Warden.Out[](1);
        it.outs[0] = Warden.Out(USDC, 0);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 1e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Warden.SelectorNotAllowed.selector, bytes4(0xa9059cbb)));
        warden.execute(it, p, sig);
    }

    function test_paymentToSelfOrWardenIsRefused() public {
        _policy(100e6, 300e6);
        Warden.Intent memory it = _intent();
        it.pays = new Warden.Pay[](1);
        it.pays[0] = Warden.Pay(USDC, address(warden), 1e6);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 1e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Warden.BadPayee.selector, address(warden)));
        warden.execute(it, p, sig);
    }

    function test_aFailingProtocolCallRevertsEverythingWithItsReason() public {
        _policy(100e6, 300e6);
        Warden.Intent memory it = _intent();
        it.approvals = new Warden.Approval[](1);
        it.approvals[0] = Warden.Approval(USDC, MORPHO_ROCKAWAYX, 1e6);
        it.calls = new Warden.Call[](1);
        it.calls[0] = Warden.Call(MORPHO_ROCKAWAYX, abi.encodeCall(IVault.deposit, (5e6, user))); // more than approved
        it.outs = new Warden.Out[](1);
        it.outs[0] = Warden.Out(MORPHO_ROCKAWAYX, 1);
        ISignatureTransfer.PermitBatchTransferFrom memory p = _permit(USDC, 1e6);
        bytes memory sig = _sign(p, warden.witnessOf(it), userKey);
        uint256 before = IERC20Full(USDC).balanceOf(user);
        vm.prank(user);
        vm.expectPartialRevert(Warden.CallFailed.selector);
        warden.execute(it, p, sig);
        assertEq(IERC20Full(USDC).balanceOf(user), before);
    }
}
