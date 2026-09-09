import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getEventMarket, getBook, displayProbability, type Book } from "@/lib/dreamdex";
import { withDeadline, SSR_DEADLINE_MS, SSR_CRITICAL_DEADLINE_MS } from "@/lib/with-deadline";
import { prettyQuestion } from "@/components/event-card";
import { MarketPanel } from "./market-panel";
import { addressUrl } from "@/lib/somnia";

export const dynamic = "force-dynamic";

type Params = Promise<{ symbol: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { symbol } = await params;
    const market = await withDeadline(
        getEventMarket(decodeURIComponent(symbol)),
        SSR_DEADLINE_MS,
        "getEventMarket:meta",
        null,
    );
    if (!market) return { title: "Market · YOLO Markets" };
    return {
        title: `${prettyQuestion(market)} · YOLO Markets`,
        description: market.question,
    };
}

export default async function MarketPage({ params }: { params: Params }) {
    const { symbol: raw } = await params;
    const symbol = decodeURIComponent(raw);

    const market = await withDeadline(
        getEventMarket(symbol),
        SSR_CRITICAL_DEADLINE_MS,
        "getEventMarket",
        null,
    );
    if (!market) notFound();

    const book = await withDeadline(
        getBook(market.yesSymbol, 10),
        SSR_DEADLINE_MS,
        "getBook",
        null as Book | null,
    );

    return (
        <div className="mx-auto max-w-[1100px] px-6 py-8">
            <div className="mb-6">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="rounded-md bg-bg-elev px-2 py-0.5 font-mono text-text">
                        {market.asset ?? "—"}
                    </span>
                    {market.interval ? (
                        <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-text-dim">
                            {market.interval}
                        </span>
                    ) : null}
                    <span
                        className={`rounded-md px-1.5 py-0.5 font-mono ${market.status === "Trading" ? "text-live" : "text-text-dim"
                            }`}
                    >
                        {market.status}
                    </span>
                </div>

                <h1 className="text-[20px] font-semibold leading-snug tracking-tight text-text">
                    {prettyQuestion(market)}
                </h1>
                <p className="mt-1.5 text-[12px] text-text-dim">{market.question}</p>

                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-text-faint">
                    <span className="font-mono">{market.symbol}</span>
                    <a
                        href={addressUrl(market.marketAddress)}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-text-dim"
                    >
                        market contract ↗
                    </a>
                    <a
                        href={addressUrl(market.poolAddress)}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-text-dim"
                    >
                        order book pool ↗
                    </a>
                    <span>
                        {market.tradeCount} trades · {market.volume.toFixed(2)} tUSDC
                    </span>
                </div>
            </div>

            <MarketPanel
                market={market}
                initialBook={book}
                initialProb={displayProbability(market, book)}
            />
        </div>
    );
}
