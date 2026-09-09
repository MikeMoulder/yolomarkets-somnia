"use client";

// Live book + ticket for one Event Contract.
//
// The book comes from `useLiveBinaryOrderBook`, which materialises resting
// orders from chain logs over the SDK's WebSocket — it updates on the block,
// not on a timer, so there is no polling here. The server-rendered book is
// handed in as `initialBook` purely so the first paint isn't empty.
import { useMemo } from "react";
import { useLiveBinaryOrderBook } from "@somnia-chain/markets-sdk/react";
import type { EventMarket, Book, BookLevel } from "@/lib/dreamdex";
import { TradeTicket } from "@/components/trade-ticket";
import { ProbBar } from "@/components/prob-bar";
import { Countdown } from "@/components/countdown";
import { COLLATERAL_DECIMALS } from "@/lib/somnia";

/** Book prices are 18-dec fixed point; sizes are raw collateral units. */
const PRICE_SCALE = 1e18;

export function MarketPanel({
    market,
    initialBook,
    initialProb,
}: {
    market: EventMarket;
    initialBook: Book | null;
    initialProb: number;
}) {
    const live = useLiveBinaryOrderBook(market.poolAddress, 10);

    const book = useMemo<Book | null>(() => {
        const bids = toLevels(live?.yesBids);
        const asks = toLevels(live?.yesAsks);
        // The live store starts empty and fills in on the first block it sees;
        // until then the SSR snapshot is the better answer.
        if (!bids.length && !asks.length) return initialBook;
        const bestBid = bids[0]?.[0] ?? null;
        const bestAsk = asks[0]?.[0] ?? null;
        return {
            symbol: market.yesSymbol,
            bids,
            asks,
            bestBid,
            bestAsk,
            mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
            spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
        };
    }, [live, initialBook, market.yesSymbol]);

    const prob = book?.mid ?? initialProb;

    return (
        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
            <div className="flex flex-col gap-4">
                <div className="rounded-xl border border-border bg-bg-elev p-4">
                    <div className="mb-3 flex items-end justify-between">
                        <div>
                            <div className="font-mono text-[28px] leading-none text-text">
                                {Math.round(prob * 100)}
                                <span className="text-[16px] text-text-dim">%</span>
                            </div>
                            <div className="mt-1 text-[11px] text-text-faint">YES probability</div>
                        </div>
                        <div className="text-right">
                            <Countdown expiry={market.expiry} className="!text-[16px]" />
                            <div className="mt-1 text-[11px] text-text-faint">until settlement</div>
                        </div>
                    </div>
                    <ProbBar p={prob} />
                    <div className="mt-3 flex items-center gap-5 text-[11px]">
                        <Metric label="Best bid" value={fmt(book?.bestBid)} tone="yes" />
                        <Metric label="Best ask" value={fmt(book?.bestAsk)} tone="no" />
                        <Metric
                            label="Spread"
                            value={book?.spread !== null && book?.spread !== undefined
                                ? `${(book.spread * 100).toFixed(1)} pts`
                                : "—"}
                        />
                    </div>
                </div>

                <OrderBook book={book} />
            </div>

            <div className="lg:sticky lg:top-20 lg:self-start">
                <TradeTicket market={market} book={book} />
            </div>
        </div>
    );
}

function OrderBook({ book }: { book: Book | null }) {
    const asks = (book?.asks ?? []).slice(0, 8).reverse();
    const bids = (book?.bids ?? []).slice(0, 8);
    const max = Math.max(
        ...[...asks, ...bids].map(([, s]) => s),
        1,
    );

    return (
        <div className="rounded-xl border border-border bg-bg-elev p-4">
            <div className="mb-3 flex items-center justify-between">
                <span className="text-[13px] font-medium text-text">Order book</span>
                <span className="flex items-center gap-1.5 text-[10px] text-text-faint">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
                    live
                </span>
            </div>

            <div className="mb-1.5 grid grid-cols-3 text-[10px] text-text-faint">
                <span>Price</span>
                <span className="text-right">Size</span>
                <span className="text-right">Total</span>
            </div>

            {asks.length === 0 && bids.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-text-dim">
                    No resting orders. This book is empty — the agent quotes into exactly this.
                </div>
            ) : (
                <div className="flex flex-col gap-0.5">
                    {asks.map(([p, s], i) => (
                        <Level key={`a${i}`} price={p} size={s} max={max} tone="no" />
                    ))}
                    <div className="my-1.5 border-t border-border" />
                    {bids.map(([p, s], i) => (
                        <Level key={`b${i}`} price={p} size={s} max={max} tone="yes" />
                    ))}
                </div>
            )}
        </div>
    );
}

function Level({
    price,
    size,
    max,
    tone,
}: {
    price: number;
    size: number;
    max: number;
    tone: "yes" | "no";
}) {
    return (
        <div className="relative grid grid-cols-3 px-1 py-0.5 font-mono text-[11px]">
            <div
                className={`absolute inset-y-0 right-0 ${tone === "yes" ? "bg-yes/10" : "bg-no/10"}`}
                style={{ width: `${Math.min(100, (size / max) * 100)}%` }}
            />
            <span className={`relative ${tone === "yes" ? "text-yes" : "text-no"}`}>
                {price.toFixed(3)}
            </span>
            <span className="relative text-right text-text-dim">{size.toFixed(2)}</span>
            <span className="relative text-right text-text-faint">
                {(price * size).toFixed(2)}
            </span>
        </div>
    );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "yes" | "no" }) {
    return (
        <div>
            <div className="text-text-faint">{label}</div>
            <div
                className={`font-mono text-[13px] ${tone === "yes" ? "text-yes" : tone === "no" ? "text-no" : "text-text"}`}
            >
                {value}
            </div>
        </div>
    );
}

function toLevels(levels: readonly { price: bigint; quantity: bigint }[] | undefined): BookLevel[] {
    if (!levels?.length) return [];
    return levels.map((l) => [
        Number(l.price) / PRICE_SCALE,
        Number(l.quantity) / 10 ** COLLATERAL_DECIMALS,
    ]);
}

function fmt(n: number | null | undefined): string {
    return n === null || n === undefined ? "—" : n.toFixed(3);
}
