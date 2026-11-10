// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IBalance {
    function balanceOf(address) external view returns (uint256);
}

/// @notice NEVER DEPLOYED. Placed, through an `eth_call` state override, as the code of the USER's own address, so a
/// dry run can call `Warden.execute` as the user (msg.sender == intent.user) and report exactly what the user's
/// balances would do. Together with SimPermit2 this dry-runs the real transaction before anything is signed.
contract SimRunner {
    struct Result {
        bool ok;
        bytes revertData;
        uint256[] before;
        uint256[] afterwards;
        uint256 gasUsed;
    }

    function run(address warden, bytes calldata executeCalldata, address[] calldata tokens) external returns (Result memory r) {
        r.before = new uint256[](tokens.length);
        r.afterwards = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) r.before[i] = IBalance(tokens[i]).balanceOf(address(this));
        uint256 g = gasleft();
        (r.ok, r.revertData) = warden.call(executeCalldata);
        r.gasUsed = g - gasleft();
        for (uint256 i; i < tokens.length; ++i) r.afterwards[i] = IBalance(tokens[i]).balanceOf(address(this));
    }
}
