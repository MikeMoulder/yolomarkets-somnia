// The read path over DreamDEX Event Contracts.
//
// The venue owns the catalog and the SDK's indexer serves it in one GraphQL
// round-trip, so there is no per-market chain fan-out here and no local cache
// to keep coherent.
//
// House rule: every call out of this module is wrapped in a deadline by its
// caller (see `lib/with-deadline.ts`). A hung indexer must degrade to an empty
// list, never to a page that streams forever - during SSR that failure mode is
// invisible, because the shell has already been sent.
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import { getLoadedExchange, getExchange } from "./somnia";

/**
 * One binary Event Contract, flattened for the UI.
 *
 * DreamDEX markets are *symbol*-keyed (`ETH-249595-09SEP26-1723/tUSDC`), not
 * address-keyed — a market has a pool address AND a market address AND a 32-byte
 * marketId, and they are three different things. The symbol is what the unified
 * API takes, so it is our primary key everywhere in the app.
 */
export type EventMarket = {
    /** 32-byte market id — the key for on-chain reads and redemption. */
    marketId: `0x${string}`;
    /** Unified market symbol, e.g. `ETH-249595-09SEP26-1723/tUSDC`. */
    symbol: string;
    /** Outcome symbols. Up and Down share ONE book; Down price = 1 − Up price. */
    yesSymbol: string;
    noSymbol: string;

    question: string;
    asset: string | null;
    /** Strike in price-feed units, or null for "reference" (vs open) markets. */
    strike: string | null;
    /** "1m", "15m", "1h" … — the series cadence. */
    interval: string | null;
    intervalSec: number | null;

    tradingStart: number;
    expiry: number;
    /** Seconds until expiry. Negative once expired. */
    secondsLeft: number;

    status: string;
    resolved: boolean;
    voided: boolean;
    finalized: boolean;
    /** 0 = YES won, 1 = NO won, null while unresolved. */
    winningOutcome: number | null;

    poolAddress: `0x${string}`;
    marketAddress: `0x${string}`;
    venueId: string;

    /** Last traded YES probability in (0,1), or null if never traded. */
    lastPrice: number | null;
    /** Cumulative quote volume in tUSDC. */
    volume: number;
    tradeCount: number;
};

/** One side of the book: `[price, size]`, best first. */
export type BookLevel = [price: number, size: number];

export type Book = {
    symbol: string;
    bids: BookLevel[];
    asks: BookLevel[];
    bestBid: number | null;
    bestAsk: number | null;
    /** Book mid, or null when either side is empty. */
    mid: number | null;
    /** Ask − bid, or null when either side is empty. */
    spread: number | null;
};

const QUOTE_DECIMALS = 6;

function num(v: string | number | null | undefined): number {
    if (v === null || v === undefined) return 0;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * The indexer returns 18-dec fixed-point strings for prices even though the
 * collateral is 6-dec: a YES probability of 0.62 arrives as
 * "620000000000000000". Dividing by 1e18 is right for prices; volumes are in
 * quote token units and use the quote decimals.
 */
function priceToProb(v: string | null | undefined): number | null {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v) / 1e18;
    return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

function toEventMarket(row: BinaryMarket, nowSec: number): EventMarket {
    const r = row as unknown as Record<string, string | number | boolean | null>;
    const expiry = num(r.expiry as string);
    const symbol = binarySymbol(r);
    return {
        marketId: (r.marketId ?? r.id) as `0x${string}`,
        symbol,
        yesSymbol: `${symbol}#YES`,
        noSymbol: `${symbol}#NO`,
        question: (r.question as string) ?? "Untitled market",
        asset: (r.asset as string) ?? null,
        strike: (r.strike as string) ?? null,
        interval: (r.interval as string) ?? null,
        intervalSec: r.intervalSec ? num(r.intervalSec as string) : null,
        tradingStart: num(r.tradingStart as string),
        expiry,
        secondsLeft: expiry - nowSec,
        status: (r.status as string) ?? "Unknown",
        resolved: r.winningOutcome !== null && r.winningOutcome !== undefined,
        voided: Boolean(r.voided),
        finalized: Boolean(r.finalized),
        winningOutcome:
            r.winningOutcome === null || r.winningOutcome === undefined
                ? null
                : Number(r.winningOutcome),
        poolAddress: r.poolAddress as `0x${string}`,
        marketAddress: r.marketAddress as `0x${string}`,
        venueId: (r.venueId as string) ?? "",
        lastPrice: priceToProb(r.lastPrice as string),
        volume: num(r.cumulativeQuoteVolume as string) / 10 ** QUOTE_DECIMALS,
        tradeCount: num(r.tradeCount as string),
    };
}

/**
 * The indexer row carries no `symbol`, only the parts the SDK composes one
 * from, so we resolve it through the loaded market map when we can and fall
 * back to the marketId. Callers that need a *tradable* symbol should prefer
 * `listEventMarkets`, which always resolves through the map.
 */
function binarySymbol(r: Record<string, unknown>): string {
    const id = (r.marketId ?? r.id) as string;
    const cached = symbolByMarketId.get(id.toLowerCase());
    return cached ?? id;
}

const symbolByMarketId = new Map<string, string>();

/**
 * List binary Event Contracts.
 *
 * `loadMarkets()` is what populates the id→symbol map, so it runs first even
 * when we then read the richer rows off the indexer directly.
 */
export async function listEventMarkets(opts?: {
    limit?: number;
    /** Include markets whose expiry has passed. Default false. */
    includeExpired?: boolean;
    /** Drop markets with less than this many seconds left. Default 0. */
    minSecondsLeft?: number;
    asset?: string;
    venueId?: string;
    search?: string;
    orderBy?: "newest" | "closingSoon" | "volume" | "tradeCount";
}): Promise<EventMarket[]> {
    let ex = await getLoadedExchange();
    indexSymbols(ex);

    const nowSec = Math.floor(Date.now() / 1000);
    const limit = opts?.limit ?? 100;
    const minLeft = opts?.minSecondsLeft ?? 0;

    // The indexer applies `limit` BEFORE we filter on time-to-expiry, so asking
    // for exactly N and then dropping the ones about to expire can return zero.
    // Over-fetch, then trim after filtering.
    const query = {
        limit: opts?.includeExpired ? limit : limit * 2 + 20,
        asset: opts?.asset,
        venueId: opts?.venueId,
        search: opts?.search,
        orderBy: opts?.orderBy ?? ("closingSoon" as const),
        nowSec,
    };

    let rows = await ex.client.listLiveBinaryMarkets(query);
    let mapped = rows.map((r) => toEventMarket(r, nowSec));

    // A market minted since the last `loadMarkets()` has no symbol yet, and a
    // market without a symbol cannot be linked to or traded. One forced reload
    // fixes it; anything still unresolved after that is dropped rather than
    // rendered as a dead link.
    if (mapped.some((m) => !m.symbol.includes("/"))) {
        ex = await getLoadedExchange({ force: true });
        indexSymbols(ex);
        rows = await ex.client.listLiveBinaryMarkets(query);
        mapped = rows.map((r) => toEventMarket(r, nowSec));
    }

    return mapped
        .filter((m) => m.symbol.includes("/"))
        .filter((m) => (opts?.includeExpired ? true : m.secondsLeft > minLeft))
        .slice(0, limit);
}

/** Refresh the marketId → tradable-symbol map from the unified layer. */
function indexSymbols(ex: Awaited<ReturnType<typeof getLoadedExchange>>): void {
    for (const m of Object.values(ex.markets)) {
        if (m.type !== "binary") continue;
        symbolByMarketId.set(String(m.id).toLowerCase(), m.symbol);
    }
}

/** Markets that have already expired — settled or awaiting settlement. */
export async function listPastEventMarkets(limit = 50): Promise<EventMarket[]> {
    const ex = await getLoadedExchange();
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = await ex.client.listPastBinaryMarkets({ limit, nowSec });
    return rows.map((r) => toEventMarket(r, nowSec));
}

/** One market by unified symbol. */
export async function getEventMarket(symbol: string): Promise<EventMarket | null> {
    const ex = await getLoadedExchange();
    const unified = ex.markets[symbol];
    if (!unified || unified.type !== "binary") return null;
    const nowSec = Math.floor(Date.now() / 1000);
    symbolByMarketId.set(String(unified.id).toLowerCase(), unified.symbol);
    return toEventMarket(unified.info as BinaryMarket, nowSec);
}

/**
 * The order book for one outcome.
 *
 * Pass the YES symbol: Up and Down trade on a single book and the NO view is
 * the same data mirrored (`price → 1 − price`, bids ↔ asks), so fetching both
 * sides separately would double the work for no new information.
 */
export async function getBook(outcomeSymbol: string, depth = 10): Promise<Book> {
    const ex = await getLoadedExchange();
    const raw = await ex.fetchOrderBook(outcomeSymbol, depth);
    const bids = (raw.bids ?? []).map(([p, s]) => [Number(p), Number(s)] as BookLevel);
    const asks = (raw.asks ?? []).map(([p, s]) => [Number(p), Number(s)] as BookLevel);
    const bestBid = bids[0]?.[0] ?? null;
    const bestAsk = asks[0]?.[0] ?? null;
    return {
        symbol: outcomeSymbol,
        bids,
        asks,
        bestBid,
        bestAsk,
        mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
        spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
    };
}

/**
 * The YES probability we display: book mid when both sides quote, else the last
 * trade, else 0.5. Never invent a number from one side of an empty book — a
 * lone resting bid at 0.02 is not a 2% probability.
 */
export function displayProbability(market: EventMarket, book?: Book | null): number {
    if (book?.mid !== null && book?.mid !== undefined) return book.mid;
    if (market.lastPrice !== null) return market.lastPrice;
    return 0.5;
}

/** Venue-level tick/lot constraints for a pool, straight off chain. */
export async function getBookParams(pool: `0x${string}`) {
    const ex = getExchange();
    return ex.client.getBinaryBookParams(pool);
}
