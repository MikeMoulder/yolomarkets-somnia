import { listEventMarkets, displayProbability, type EventMarket } from "@/lib/dreamdex";
import { withDeadline, SSR_CRITICAL_DEADLINE_MS } from "@/lib/with-deadline";
import { EventCard } from "@/components/event-card";
import { SearchInput } from "@/components/search-input";
import Link from "next/link";

// Markets roll every minute, so nothing here is cacheable.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ q?: string; asset?: string }>;

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
    const sp = await searchParams;
    const q = (sp.q ?? "").trim().toLowerCase();
    const asset = (sp.asset ?? "").trim().toUpperCase();

    // Deadlined: a hung indexer must render an empty catalog, never a page that
    // streams forever. During SSR that failure is invisible - the shell has
    // already been sent, so it looks like a hosting problem, not a data one.
    const markets = await withDeadline(
        listEventMarkets({ limit: 100, minSecondsLeft: 15 }),
        SSR_CRITICAL_DEADLINE_MS,
        "listEventMarkets",
        [] as EventMarket[],
    );

    const assets = [...new Set(markets.map((m) => m.asset).filter(Boolean))] as string[];

    const filtered = markets.filter((m) => {
        if (asset && m.asset?.toUpperCase() !== asset) return false;
        if (q && !m.question.toLowerCase().includes(q) && !m.symbol.toLowerCase().includes(q))
            return false;
        return true;
    });

    const totalVolume = markets.reduce((a, m) => a + m.volume, 0);
    const totalTrades = markets.reduce((a, m) => a + m.tradeCount, 0);

    return (
        <div className="mx-auto max-w-[1440px] px-6 py-8">
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h1 className="text-[22px] font-semibold tracking-tight text-text">
                        Event Contracts
                    </h1>
                    <p className="mt-1 text-[13px] text-text-dim">
                        Binary markets on DreamDEX, settling every few minutes on Somnia.{" "}
                        <Link href="/agent" className="text-accent hover:underline">
                            Let the agent trade them →
                        </Link>
                    </p>
                </div>
                <div className="flex items-center gap-5 text-[12px]">
                    <Stat label="Live" value={String(markets.length)} />
                    <Stat label="Volume" value={`${totalVolume.toFixed(0)} tUSDC`} />
                    <Stat label="Trades" value={String(totalTrades)} />
                </div>
            </div>

            <div className="mb-6 flex flex-wrap items-center gap-3">
                <SearchInput />
                <div className="flex flex-wrap gap-1.5">
                    <AssetChip label="All" href="/" active={!asset} />
                    {assets.map((a) => (
                        <AssetChip
                            key={a}
                            label={a}
                            href={`/?asset=${encodeURIComponent(a)}`}
                            active={asset === a.toUpperCase()}
                        />
                    ))}
                </div>
            </div>

            {filtered.length === 0 ? (
                <div className="rounded-xl border border-border bg-bg-elev px-6 py-16 text-center">
                    <div className="text-[14px] text-text">
                        {markets.length === 0 ? "No live markets right now" : "Nothing matches"}
                    </div>
                    <div className="mt-1 text-[12px] text-text-dim">
                        {markets.length === 0
                            ? "The venue rolls new contracts continuously — check back in a moment."
                            : "Try a different asset or search."}
                    </div>
                </div>
            ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {filtered.map((m) => (
                        <EventCard key={m.symbol} market={m} prob={displayProbability(m)} />
                    ))}
                </div>
            )}
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col">
            <span className="text-text-faint">{label}</span>
            <span className="font-mono text-[14px] text-text">{value}</span>
        </div>
    );
}

function AssetChip({ label, href, active }: { label: string; href: string; active: boolean }) {
    return (
        <Link
            href={href}
            className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${active
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-text-dim hover:border-border-bright hover:text-text"
                }`}
        >
            {label}
        </Link>
    );
}
