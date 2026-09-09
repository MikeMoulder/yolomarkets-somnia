"use client";

// The trade ticket for one Event Contract.
//
// The design bet: users size a binary in MONEY THEY CAN LOSE, not in contracts.
// On a binary at price p, buying q contracts costs q·p and either returns q or
// zero — so "max loss" IS the cost, and size falls out as risk/p. That inverts
// the usual order form (enter size, discover cost) into the one question a
// retail user can actually answer, and it makes the downside literally
// un-exceedable rather than a warning in small print.
import { useMemo, useState } from "react";
import { useWalletClient } from "wagmi";
import type { EventMarket, Book } from "@/lib/dreamdex";
import { getWalletExchange, txUrl } from "@/lib/somnia";
import { useActiveWallet } from "@/lib/use-active-wallet";
import { useWalletModal } from "./wallet-modal";

type Side = "YES" | "NO";
type Mode = "market" | "limit";

const PRESETS = [1, 5, 25, 100];

export function TradeTicket({
    market,
    book,
    onFilled,
}: {
    market: EventMarket;
    /** YES-side book. The NO view is this data mirrored (price → 1 − price). */
    book: Book | null;
    onFilled?: () => void;
}) {
    const { data: walletClient } = useWalletClient();
    const { isConnected, wrongChain, needsGas, collateral, refetchCollateral } = useActiveWallet();
    const { openWalletModal } = useWalletModal();

    const [side, setSide] = useState<Side>("YES");
    const [mode, setMode] = useState<Mode>("market");
    const [risk, setRisk] = useState("5");
    const [limitPrice, setLimitPrice] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<{ hash?: string; filled: number; price: number } | null>(null);

    // The price this side would pay to cross now. YES lifts the YES ask; NO is
    // the mirror of the YES bid, because Up and Down share one book.
    const marketPrice = useMemo(() => {
        if (!book) return null;
        if (side === "YES") return book.bestAsk;
        return book.bestBid === null ? null : 1 - book.bestBid;
    }, [book, side]);

    const price = mode === "limit" ? Number(limitPrice) || null : marketPrice;
    const riskNum = Number(risk) || 0;

    // size = risk / price. Contracts pay 1 tUSDC each if they win.
    const size = price && price > 0 && price < 1 ? riskNum / price : 0;
    const payout = size;
    const multiple = price && price > 0 ? 1 / price : 0;

    const expired = market.secondsLeft <= 0;
    const balance = collateral ? Number(collateral.formatted) : 0;
    const overBalance = riskNum > balance;

    const blocker =
        expired ? "Market expired"
            : !isConnected ? null
                : wrongChain ? "Wrong network"
                    : needsGas ? "No STT for gas"
                        : !price ? "No liquidity on this side"
                            : riskNum <= 0 ? "Enter an amount"
                                : overBalance ? "Not enough tUSDC"
                                    : size < 0.001 ? "Below minimum size"
                                        : null;

    async function submit() {
        if (!walletClient || !price) return;
        setBusy(true);
        setError(null);
        setDone(null);
        try {
            const ex = getWalletExchange(walletClient);
            await ex.loadMarkets();

            // Both sides are BUYs of the respective outcome token — there is no
            // "sell YES to go short", you buy NO. The venue mints the pair from
            // combined collateral when the two sides cross.
            const symbol = side === "YES" ? market.yesSymbol : market.noSymbol;

            const order = await ex.createOrder(
                symbol,
                mode,
                "buy",
                roundSize(size),
                mode === "limit" ? price : undefined,
            );

            setDone({
                hash: (order as unknown as { txHash?: string }).txHash,
                filled: Number(order.filled ?? 0),
                price: Number(order.price ?? price),
            });
            refetchCollateral();
            onFilled?.();
        } catch (err) {
            setError(humanError(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="rounded-xl border border-border bg-bg-elev p-4">
            <div className="mb-3 grid grid-cols-2 gap-2">
                {(["YES", "NO"] as const).map((s) => (
                    <button
                        key={s}
                        onClick={() => setSide(s)}
                        className={`rounded-lg border px-3 py-2.5 text-[13px] font-medium transition-colors ${side === s
                            ? s === "YES"
                                ? "border-yes bg-yes/15 text-yes"
                                : "border-no bg-no/15 text-no"
                            : "border-border bg-bg text-text-dim hover:border-border-bright"
                            }`}
                    >
                        {s}
                        <span className="ml-2 font-mono text-[11px] opacity-70">
                            {sidePrice(book, s)}
                        </span>
                    </button>
                ))}
            </div>

            <div className="mb-3 flex gap-1 rounded-lg border border-border bg-bg p-0.5">
                {(["market", "limit"] as const).map((m) => (
                    <button
                        key={m}
                        onClick={() => setMode(m)}
                        className={`flex-1 rounded-md px-2 py-1 text-[12px] capitalize transition-colors ${mode === m ? "bg-bg-elev text-text" : "text-text-faint hover:text-text-dim"
                            }`}
                    >
                        {m}
                    </button>
                ))}
            </div>

            {mode === "limit" ? (
                <label className="mb-3 block">
                    <span className="mb-1 block text-[11px] text-text-faint">
                        Limit price (probability)
                    </span>
                    <input
                        value={limitPrice}
                        onChange={(e) => setLimitPrice(e.target.value)}
                        inputMode="decimal"
                        placeholder="0.45"
                        className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[13px] text-text outline-none focus:border-border-bright"
                    />
                </label>
            ) : null}

            <label className="mb-2 block">
                <span className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-text-faint">Max loss</span>
                    <span className="text-text-faint">
                        balance {collateral?.formatted ?? "—"} tUSDC
                    </span>
                </span>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 focus-within:border-border-bright">
                    <span className="text-text-faint">$</span>
                    <input
                        value={risk}
                        onChange={(e) => setRisk(e.target.value)}
                        inputMode="decimal"
                        className="w-full bg-transparent font-mono text-[15px] text-text outline-none"
                    />
                    <span className="text-[11px] text-text-faint">tUSDC</span>
                </div>
            </label>

            <div className="mb-3 flex gap-1.5">
                {PRESETS.map((p) => (
                    <button
                        key={p}
                        onClick={() => setRisk(String(p))}
                        className="flex-1 rounded-md border border-border bg-bg py-1 text-[11px] text-text-dim hover:border-border-bright hover:text-text"
                    >
                        ${p}
                    </button>
                ))}
            </div>

            <div className="mb-3 space-y-1.5 rounded-lg border border-border bg-bg px-3 py-2.5 text-[12px]">
                <Row label="Price" value={price ? price.toFixed(3) : "—"} />
                <Row label="Contracts" value={size ? size.toFixed(3) : "—"} />
                <Row
                    label="Payout if right"
                    value={payout ? `$${payout.toFixed(2)}` : "—"}
                    accent={side === "YES" ? "yes" : "no"}
                />
                <Row label="Max loss" value={riskNum ? `$${riskNum.toFixed(2)}` : "—"} />
                <Row label="Return" value={multiple ? `${multiple.toFixed(2)}x` : "—"} />
            </div>

            {!isConnected ? (
                <button
                    onClick={openWalletModal}
                    className="w-full rounded-lg bg-accent py-2.5 text-[13px] font-medium text-black hover:bg-accent-dim"
                >
                    Connect wallet
                </button>
            ) : (
                <button
                    onClick={submit}
                    disabled={Boolean(blocker) || busy}
                    className={`w-full rounded-lg py-2.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${side === "YES" ? "bg-yes text-black hover:bg-yes-dim" : "bg-no text-black hover:bg-no-dim"
                        }`}
                >
                    {busy ? "Placing…" : blocker ?? `Buy ${side} · $${riskNum.toFixed(2)}`}
                </button>
            )}

            {error ? (
                <div className="mt-3 rounded-lg border border-no/30 bg-no/10 px-3 py-2 text-[11px] text-no">
                    {error}
                </div>
            ) : null}

            {done ? (
                <div className="mt-3 rounded-lg border border-yes/30 bg-yes/10 px-3 py-2 text-[11px] text-yes">
                    Filled {done.filled.toFixed(3)} contracts at {done.price.toFixed(3)}
                    {done.hash ? (
                        <>
                            {" · "}
                            <a href={txUrl(done.hash)} target="_blank" rel="noreferrer" className="underline">
                                tx ↗
                            </a>
                        </>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function Row({
    label,
    value,
    accent,
}: {
    label: string;
    value: string;
    accent?: "yes" | "no";
}) {
    return (
        <div className="flex items-center justify-between">
            <span className="text-text-faint">{label}</span>
            <span
                className={`font-mono ${accent === "yes" ? "text-yes" : accent === "no" ? "text-no" : "text-text"}`}
            >
                {value}
            </span>
        </div>
    );
}

function sidePrice(book: Book | null, side: Side): string {
    if (!book) return "—";
    const p = side === "YES" ? book.bestAsk : book.bestBid === null ? null : 1 - book.bestBid;
    return p === null ? "—" : p.toFixed(2);
}

/** Venue lot size is 0.001 contracts; round DOWN so we never exceed max loss. */
function roundSize(n: number): number {
    return Math.floor(n * 1000) / 1000;
}

function humanError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/user rejected|denied/i.test(msg)) return "You rejected the transaction.";
    if (/insufficient funds/i.test(msg)) return "Not enough STT for gas.";
    if (/allowance|transfer amount exceeds/i.test(msg)) return "Not enough tUSDC.";
    return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}
