// One Event Contract as a card.
//
// DreamDEX contracts roll on a cadence (1m / 5m / 15m / 1h), so the two facts
// that dominate the card are the countdown and the cadence badge. There is no
// artwork: these markets are machine-generated and the asset ticker is the
// identity, so a picture would be noise.
import Link from "next/link";
import type { EventMarket } from "@/lib/dreamdex";
import { ProbBar } from "./prob-bar";
import { Countdown } from "./countdown";

export function EventCard({ market, prob }: { market: EventMarket; prob: number }) {
    const pct = Math.round(prob * 100);
    return (
        <Link
            href={`/markets/${encodeURIComponent(market.symbol)}`}
            className="group flex flex-col gap-3 rounded-xl border border-border bg-bg-elev p-4 transition-colors hover:border-border-bright hover:bg-bg-hover"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                    <span className="rounded-md bg-bg px-2 py-0.5 font-mono text-[11px] font-medium text-text">
                        {market.asset ?? "—"}
                    </span>
                    {market.interval ? (
                        <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-dim">
                            {market.interval}
                        </span>
                    ) : null}
                </div>
                <Countdown expiry={market.expiry} />
            </div>

            <div className="line-clamp-2 text-[13px] leading-snug text-text">
                {prettyQuestion(market)}
            </div>

            <div className="mt-auto flex flex-col gap-2">
                <ProbBar p={prob} />
                <div className="flex items-center justify-between text-[11px]">
                    <span className="font-mono text-yes">{pct}% YES</span>
                    <span className="text-text-faint">
                        {market.tradeCount > 0
                            ? `${market.volume.toFixed(2)} tUSDC · ${market.tradeCount} trades`
                            : "no trades yet"}
                    </span>
                </div>
            </div>
        </Link>
    );
}

/**
 * The venue's auto-generated questions are machine-shaped ("Pricefeed test:
 * will ETH/USDC's price be at or above 2495.95 at unix time 1788974580?").
 * Rewrite the common template into something a human can read at a glance and
 * fall back to the raw text for anything we don't recognise — never drop
 * information we failed to parse.
 */
export function prettyQuestion(m: EventMarket): string {
    const match = m.question.match(
        /will\s+(\S+?)'s price be at or above ([\d.]+) at unix time \d+/i,
    );
    if (match) {
        const [, pair, level] = match;
        return `${pair.split("/")[0]} ≥ $${Number(level).toLocaleString()}`;
    }
    return m.question.replace(/^Pricefeed test:\s*/i, "");
}
