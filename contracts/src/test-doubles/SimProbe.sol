// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice NEVER DEPLOYED. Placed, through an `eth_call` state override, as the code of the USER's own address, so any
/// transaction a dApp asks the user to send (target, calldata, value) runs as the user (msg.sender == user) against
/// live state, and the probe reports what it would do to the user: native and token balances, and allowances, before
/// and after. Nothing is written: it only ever runs inside an eth_call. Used by the agent's `check_transaction`.
contract SimProbe {
    struct Result {
        bool ok;
        bytes revertData;
        uint256 nativeBefore;
        uint256 nativeAfter;
        uint256[] before;
        uint256[] afterwards;
        uint256[] allowanceBefore;
        uint256[] allowanceAfter;
        uint256 gasUsed;
    }

    /// @param tokens balances to watch; @param allowTokens / allowSpenders allowance pairs to watch (same length).
    function probe(
        address target,
        bytes calldata data,
        uint256 value,
        address[] calldata tokens,
        address[] calldata allowTokens,
        address[] calldata allowSpenders
    ) external returns (Result memory r) {
        r.before = _balances(tokens);
        r.allowanceBefore = _allowances(allowTokens, allowSpenders);
        r.nativeBefore = address(this).balance;
        uint256 g = gasleft();
        (r.ok, r.revertData) = target.call{value: value}(data);
        r.gasUsed = g - gasleft();
        r.nativeAfter = address(this).balance;
        r.afterwards = _balances(tokens);
        r.allowanceAfter = _allowances(allowTokens, allowSpenders);
    }

    function _balances(address[] calldata tokens) internal view returns (uint256[] memory out) {
        out = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) out[i] = _read(tokens[i], abi.encodeWithSelector(0x70a08231, address(this)));
    }

    function _allowances(address[] calldata tokens, address[] calldata spenders) internal view returns (uint256[] memory out) {
        out = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) out[i] = _read(tokens[i], abi.encodeWithSelector(0xdd62ed3e, address(this), spenders[i]));
    }

    /// A uint256 view that may not exist on the target: 0 when it fails or returns nothing.
    function _read(address t, bytes memory call) internal view returns (uint256 v) {
        (bool ok, bytes memory ret) = t.staticcall(call);
        if (ok && ret.length >= 32) v = abi.decode(ret, (uint256));
    }

    receive() external payable {}
}
