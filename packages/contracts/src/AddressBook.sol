// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Direcciones canónicas en Robinhood Chain MAINNET (chain ID 4663).
/// Verificadas on-chain / Blockscout el 2026-07-19 (Fase 0.4). Ver docs/SPEC.md §3.
/// ⚠ EXISTEN TOKENS IMPOSTORES en la chain (p. ej. un "NVIDIA • Robinhood Token" falso en
/// 0x4658...A492 y un "Global Dollar" falso en 0x1383...B1ca con ~14k holders).
/// Jamás resolver direcciones por nombre/símbolo — solo desde este AddressBook.
library AddressBook {
    // --- Stablecoin ---
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 decimales (verificado on-chain)

    // --- Stock Tokens (BeaconProxy → impl "Stock" 0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2) ---
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d; // ~14.0k holders
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC; // ~21.0k holders
    address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9; // ~19.9k holders
    address internal constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74; // ~11.8k holders
    address internal constant SPY  = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C; // ~5.9k holders

    // --- Access controls RHJ (blacklist default-allow + pausas) ---
    // Obtenido del puntero on-chain: TSLA.ACCESS_CONTROLLED_REGISTRY() == esta dirección (verificado).
    address internal constant ACCESS_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;

    // --- Feeds Chainlink (EACAggregatorProxy, 8 dec, heartbeat 86400s, deviation 0.5%, 24/5) ---
    // Fuente: docs.chain.link RDD para robinhood-mainnet. maxStaleness por activo = 86400 + margen.
    address internal constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address internal constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;
    address internal constant MSFT_FEED = 0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E;
    address internal constant SPY_FEED  = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address internal constant USDG_FEED = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2; // USDG/USD — resuelve SPEC §5.5
    // ⚠ NO existe L2 Sequencer Uptime Feed en esta chain (Chainlink no la lista) — SPEC §5.2.3.

    // --- Uniswap (deployment dedicado, registro oficial deployments/4663.md, verificado en Blockscout) ---
    address internal constant UNI_V3_FACTORY   = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant UNI_SWAP_ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant UNI_QUOTER_V2    = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;
    address internal constant UNI_UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant UNI_V4_POOL_MANAGER  = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant UNI_V4_QUOTER    = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;

    // --- 0x (settlers ROTAN en cada redeploy: resolver en runtime vía ownerOf(2/3) en el deployer) ---
    address internal constant ZEROX_DEPLOYER = 0x00000000000004533Fe15556B1E086BB1A72cEae;
    address internal constant ZEROX_ALLOWANCE_HOLDER = 0x0000000000001fF3684f28c67538d4D072C22734;

    // --- Infra chain ---
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant L2_MULTICALL = 0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1;
}
