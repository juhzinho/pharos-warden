// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISignatureTransfer} from "../Warden.sol";

/// @notice NEVER DEPLOYED. A stand-in for Permit2 used only inside `eth_call` state overrides, so the agent can
/// dry-run the exact `Warden.execute` transaction before the user signs anything: it moves the permitted tokens like
/// Permit2 would, but does not check the signature (there is none yet). Everything else — Warden's policy checks,
/// the protocol calls, the guarantees — runs for real against live Pacific state.
contract SimPermit2 {
    function permitWitnessTransferFrom(
        ISignatureTransfer.PermitBatchTransferFrom calldata permit,
        ISignatureTransfer.SignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes32,
        string calldata,
        bytes calldata
    ) external {
        require(block.timestamp <= permit.deadline, "SimPermit2: expired");
        for (uint256 i; i < permit.permitted.length; ++i) {
            require(transferDetails[i].requestedAmount <= permit.permitted[i].amount, "SimPermit2: too much");
            (bool ok, bytes memory ret) = permit.permitted[i].token.call(
                abi.encodeWithSelector(0x23b872dd, owner, transferDetails[i].to, transferDetails[i].requestedAmount)
            );
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "SimPermit2: transferFrom failed");
        }
    }
}
