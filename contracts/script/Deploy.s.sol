// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Warden} from "../src/Warden.sol";
import {PacificConfig} from "./PacificConfig.sol";

/// @notice Deploys Warden on Pharos Pacific Mainnet with the fixed protocol allowlist (the SkillEngine
/// "Deploy contract" flow: forge script + --private-key from the environment, never from code).
///   forge script script/Deploy.s.sol --rpc-url pacific --private-key $PRIVATE_KEY --broadcast
contract Deploy is Script, PacificConfig {
    function run() external returns (Warden warden) {
        require(block.chainid == 1672, "not Pharos Pacific Mainnet");
        vm.startBroadcast();
        warden = deploy();
        vm.stopBroadcast();
        console2.log("Warden", address(warden));
    }
}
