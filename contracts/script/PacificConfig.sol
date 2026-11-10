// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Warden} from "../src/Warden.sol";

/// @notice Pharos Pacific Mainnet (chain 1672) addresses Warden is deployed against. Each one was checked on chain
/// (see docs/ADDRESSES.md): tokens from the official token registry; FaroSwap's DODORouteProxy, its UniV3 adapter,
/// the 0.01% WPROS/USDC pool and DODOApprove (read from the proxy); the two Morpho Vault V2 USDC vaults
/// (asset() = USDC); the Avalon (Aave V3) pool and its aToken (POOL() = the pool); Faroo's stPROS liquid-staking vault
/// (ERC-4626, asset() = WPROS).
abstract contract PacificConfig {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant USDC = 0xC879C018dB60520F4355C26eD1a6D572cdAC1815;
    address internal constant WPROS = 0x52C48d4213107b20bC583832b0d951FB9CA8F0B0;

    address internal constant FAROSWAP_ROUTE_PROXY = 0xA5cA5Fbe34e444F366B373170541ec6902b0F75c;
    address internal constant FAROSWAP_DODO_APPROVE = 0xBF105f4ffBD3825f5433d074008B9A76237d849c;
    address internal constant FAROSWAP_ADAPTER = 0x4fD44181839D24e7C8f4D1B9288379109Ec25FAE;
    address internal constant FAROSWAP_POOL = 0x912c9aDe24D44d8922f0866D8Dcb079f1363f647;

    address internal constant MORPHO_ROCKAWAYX = 0x047cD0a91E9B92ED979189a6C8A120bf280f02E5;
    address internal constant MORPHO_SHARPBYTE = 0x15c25ED222fc498f672af5c3adb5ED0a96E1AFf1;

    address internal constant AVALON_POOL = 0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa;
    address internal constant AVALON_AUSDC = 0xE2ec2F3933aD2f83DE9a9dDa844558354384e87D;

    address internal constant FAROO_STPROS = 0x6b0A44c64190279f7034b77c13a566E914FE5Ec4;

    /// FaroSwap V3 NonfungiblePositionManager ("Uniswap V3 Positions NFT-V1"; factory() = the FaroSwap V3 factory).
    address internal constant FAROSWAP_NPM = 0xc0479219f4FebA5A668cFF71BF96f4FFE124c3ab;

    /// @notice The fixed allowlist: 0 FaroSwap, 1 Morpho RockawayX USDC, 2 Morpho SharpByte USDC, 3 Avalon USDC,
    /// 4 Faroo stPROS (staking WPROS; its unstake is a 7-day request, so it is not a Warden action), 5 FaroSwap V3
    /// liquidity (mint a position NFT straight to the user; removing it is the NFT owner's own transaction).
    function deploy() internal returns (Warden) {
        string[] memory names = new string[](6);
        names[0] = "FaroSwap";
        names[1] = "Morpho RockawayX USDC";
        names[2] = "Morpho SharpByte USDC";
        names[3] = "Avalon USDC";
        names[4] = "Faroo stPROS";
        names[5] = "FaroSwap V3 liquidity";
        address[] memory targets = new address[](6);
        uint8[] memory targetIds = new uint8[](6);
        targets[0] = FAROSWAP_ROUTE_PROXY;
        targets[1] = MORPHO_ROCKAWAYX;
        targets[2] = MORPHO_SHARPBYTE;
        targets[3] = AVALON_POOL;
        targets[4] = FAROO_STPROS;
        targets[5] = FAROSWAP_NPM;
        targetIds[0] = 0;
        targetIds[1] = 1;
        targetIds[2] = 2;
        targetIds[3] = 3;
        targetIds[4] = 4;
        targetIds[5] = 5;
        address[] memory spenders = new address[](6);
        uint8[] memory spenderIds = new uint8[](6);
        spenders[0] = FAROSWAP_DODO_APPROVE;
        spenders[1] = MORPHO_ROCKAWAYX;
        spenders[2] = MORPHO_SHARPBYTE;
        spenders[3] = AVALON_POOL;
        spenders[4] = FAROO_STPROS;
        spenders[5] = FAROSWAP_NPM;
        spenderIds[0] = 0;
        spenderIds[1] = 1;
        spenderIds[2] = 2;
        spenderIds[3] = 3;
        spenderIds[4] = 4;
        spenderIds[5] = 5;
        return new Warden(PERMIT2, names, targets, targetIds, spenders, spenderIds);
    }
}
