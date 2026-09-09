// The one place that knows what network we are on.
//
// Somnia Shannon testnet (chain 50312) hosts DreamDEX Event Contracts: the
// venue owns the markets, the CLOB and the oracle. We deploy nothing, so the
// SDK's baked-in `SOMNIA_TESTNET_ADDRESSES` is the whole deployment manifest.
//
// The SDK needs FOUR things that must agree with each other: an indexer URL, a
// viem chain, a WebSocket RPC, and the address book. Mixing a testnet indexer
// with mainnet addresses fails silently (empty market list), so they are set
// together here and nowhere else.
import {
    SomniaMarkets,
    SOMNIA_TESTNET_ADDRESSES,
    SOMNIA_TESTNET_PRICE_FEED,
    type SomniaMarketsConfig,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import type { Chain, WalletClient } from "viem";

// The SDK ships a frozen `.d.ts` for its chain definitions, generated against a
// viem whose `prepareTransactionRequest` had a different generic instantiation
// than the viem we resolve (2.50.x). The runtime object is a perfectly valid
// viem chain — only the declared type disagrees — so the cast is the whole fix.
// Re-check on SDK upgrades; drop it once the shapes line up.
export const somniaChain = somniaShannon as unknown as Chain;
export const ADDRESSES = SOMNIA_TESTNET_ADDRESSES;

/** tUSDC on Shannon. 6 decimals — the SDK's trader default, but be explicit. */
export const COLLATERAL_DECIMALS = 6;
export const COLLATERAL_ADDRESS = SOMNIA_TESTNET_ADDRESSES.collateral;

export const INDEXER_URL =
    process.env.NEXT_PUBLIC_SOMNIA_INDEXER_URL ??
    process.env.SOMNIA_INDEXER_URL ??
    "https://dev.smk.somnia.host/v1/graphql";

export const WS_RPC_URL =
    process.env.NEXT_PUBLIC_SOMNIA_WS_RPC_URL ??
    process.env.SOMNIA_WS_RPC_URL ??
    "wss://api.infra.testnet.somnia.network/ws";

export const HTTP_RPC_URL =
    process.env.NEXT_PUBLIC_SOMNIA_RPC_URL ??
    process.env.SOMNIA_RPC_URL ??
    "https://api.infra.testnet.somnia.network";

export const EXPLORER_URL = "https://shannon-explorer.somnia.network";

export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (addr: string) => `${EXPLORER_URL}/address/${addr}`;

const baseConfig = {
    indexerUrl: INDEXER_URL,
    chain: somniaChain,
    wsRpcUrl: WS_RPC_URL,
    addresses: ADDRESSES,
    // The oracle's own EMA price feed. This is not decoration: every binary
    // here settles on it, so spot-vs-strike is the market's actual generating
    // process — reading it is what lets us price a contract analytically
    // instead of guessing. Price reads throw NotConfiguredError without it.
    priceFeed: SOMNIA_TESTNET_PRICE_FEED,
} satisfies SomniaMarketsConfig;

// A read-only exchange holds no key and opens its WebSocket lazily, so one
// instance can serve every render. Two exchanges never share watch state or
// sockets (SDK guarantee), which is exactly why we do NOT want a new one per
// request — that would open a socket per request.
let readOnly: SomniaMarkets | null = null;
let readOnlyLoaded: Promise<void> | null = null;
let loadedAt = 0;

/**
 * How long a loaded market map stays fresh.
 *
 * This is NOT a performance knob — it is correctness. DreamDEX rolls new
 * contracts on a 1-minute cadence, and `loadMarkets()` is what maps a marketId
 * to the tradable symbol every unified call needs. Memoise it forever (the
 * obvious thing) and markets minted after boot resolve to no symbol at all:
 * they render, they link, and the link 404s. Keep this well under the shortest
 * series interval.
 */
const MARKETS_TTL_MS = Number(process.env.SOMNIA_MARKETS_TTL_MS ?? 20_000);

/** The shared read-only exchange. Safe on the server and in the browser. */
export function getExchange(): SomniaMarkets {
    if (!readOnly) readOnly = new SomniaMarkets(baseConfig);
    return readOnly;
}

/**
 * The read-only exchange with `loadMarkets()` already awaited.
 *
 * `loadMarkets` populates `exchange.markets` / `exchange.symbols`; every unified
 * call (`fetchOrderBook`, `createOrder`) resolves symbols through that map, so
 * calling them before it resolves throws. The promise is memoised rather than
 * the result: concurrent callers on a cold server share one load instead of
 * stampeding the indexer.
 */
export async function getLoadedExchange(opts?: { force?: boolean }): Promise<SomniaMarkets> {
    const ex = getExchange();
    const stale = Date.now() - loadedAt > MARKETS_TTL_MS;
    if (opts?.force || stale) readOnlyLoaded = null;

    if (!readOnlyLoaded) {
        readOnlyLoaded = ex.loadMarkets().then(
            () => {
                loadedAt = Date.now();
            },
            (err) => {
                // Let the next caller retry instead of caching a failure forever.
                readOnlyLoaded = null;
                throw err;
            },
        );
    }
    await readOnlyLoaded;
    return ex;
}

/** Force the next `getLoadedExchange()` to re-read the market list. */
export function invalidateMarkets(): void {
    readOnlyLoaded = null;
    loadedAt = 0;
}

/**
 * A writing exchange bound to a browser wallet. Built per connected account —
 * the signer is part of construction, not a setter.
 */
export function getWalletExchange(walletClient: WalletClient): SomniaMarkets {
    return new SomniaMarkets({
        ...baseConfig,
        walletClient,
        decimals: COLLATERAL_DECIMALS,
    } as SomniaMarketsConfig);
}

/**
 * A writing exchange bound to a raw key. Server/bridge only — never import this
 * from a client component, or the key ships to the browser.
 */
export function getSignerExchange(privateKey: `0x${string}`): SomniaMarkets {
    return new SomniaMarkets({
        ...baseConfig,
        privateKey,
        decimals: COLLATERAL_DECIMALS,
    } as SomniaMarketsConfig);
}
