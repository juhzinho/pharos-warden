// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Warden} from "../src/Warden.sol";

/// @notice Deploys Warden on Pharos Atlantic Testnet (chain 688689). Atlantic has no DEX or lending protocol
/// (the Docs MCP lists none), so this Warden allowlists no protocol at all: it guards payments only — exact
/// payees and amounts, per-day limits, payees-only mode, expiry and pause. Same contract as on Pacific Mainnet.
///   forge script script/DeployAtlantic.s.sol --rpc-url atlantic --private-key $PRIVATE_KEY --broadcast
contract DeployAtlantic is Script {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3; // canonical, listed on Atlantic

    function run() external returns (Warden warden) {
        require(block.chainid == 688689, "not Pharos Atlantic Testnet");
        string[] memory names = new string[](1);
        names[0] = "Payments only (no protocol allowlisted on Atlantic)";
        vm.startBroadcast();
        warden = new Warden(PERMIT2, names, new address[](0), new uint8[](0), new address[](0), new uint8[](0));
        vm.stopBroadcast();
        console2.log("Warden", address(warden));
    }
}
