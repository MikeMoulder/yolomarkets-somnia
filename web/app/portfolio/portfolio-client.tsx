"use client";

// Positions, marks and claimable payouts for the connected wallet.
//
// Settlement on DreamDEX is a pull: winning outcome tokens are redeemed 1:1 for
// collateral via `trader.redeem`, so a settled winner sits here as a claim
// until the user (or the agent) takes it.
import { useCallback, useEffect, useState } from "react";
import { useWalletClient } from "wagmi";
import Link from "next/link";
import { useActiveWallet } from "@/lib/use-active-wallet";
import { useWalletModal } from "@/components/wallet-modal";
import type { PortfolioView, Position } from "@/lib/portfolio";
import { getWalletExchange, txUrl } from "@/lib/somnia";
import { Countdown } from "@/components/countdown";

export function PortfolioClient() {
    const { address, isConnected, collateral } = useActiveWallet();
    const { openWalletModal } = useWalletModal();
    const { data: walletClient } = useWalletClient();

    const [data, setData] = useState<PortfolioView | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [claiming, setClaiming] = useState<string | null>(null);
    const [claimed, setClaimed] = useState<Record<string, string>>({});

    const load = useCallback(async () => {
        if (!address) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/portfolio?user=${address}`);
            if (!res.ok) throw new Error(await res.text());
            setData((await res.json()) as PortfolioView);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load portfolio");
        } finally {
            setLoading(false);
        }
    }, [address]);

    useEffect(() => {
        void load();
        const t = setInterval(() => void load(), 30_000);
        return () => clearInterval(t);
    }, [load]);

    async function claim(pos: Position) {
        if (!walletClient) return;
        setClaiming(pos.marketId);
        setError(null);
        try {
            const ex = getWalletExchange(walletClient);
            const onchain = await ex.client.getMarketOnchain(pos.marketId as `0x${string}`);
            const res = await ex.trader.redeem({
                marketId: pos.marketId as `0x${string}`,
                market: onchain.marketAddress,
                outcomeToken: onchain.outcomeToken,
                outcomeIdx: pos.outcomeIndex === 0 ? 0 : 1,
                amount: BigInt(Math.round(pos.contracts * 1e6)),
            });
            setClaimed((c) => ({ ...c, [pos.marketId]: res.hash }));
            void load();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Redeem failed");
        } finally {
            setClaiming(null);
        }
    }

    if (!isConnected) {
        return (
            <Empty
                title="Connect your wallet"
                body="Your Event Contract positions and claimable payouts appear here."
                action={
                    <button
                        onClick={openWalletModal}
                        className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-black hover:bg-accent-dim"
                    >
                        Connect wallet
                    </button>
                }
            />
        );
    }

    return (
        <div className="mx-auto max-w-[1000px] px-6 py-8">
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
                <h1 className="text-[22px] font-semibold tracking-tight text-text">Portfolio</h1>
                <div className="flex items-center gap-5 text-[12px]">
                    <Stat label="Balance" value={`${collateral?.formatted ?? "—"} tUSDC`} />
                    <Stat label="Open value" value={`$${(data?.openValue ?? 0).toFixed(2)}`} />
                    <Stat
                        label="Claimable"
                        value={`$${(data?.claimable ?? 0).toFixed(2)}`}
                        tone={data?.claimable ? "yes" : undefined}
                    />
                    <Stat label="Open orders" value={String(data?.openOrders ?? 0)} />
                </div>
            </div>

            {error ? (
                <div className="mb-4 rounded-lg border border-no/30 bg-no/10 px-3 py-2 text-[12px] text-no">
                    {error}
                </div>
            ) : null}

            <Section title="Open positions">
                {data?.open.length ? (
                    data.open.map((p) => <Row key={`${p.marketId}-${p.outcomeIndex}`} pos={p} />)
                ) : (
                    <Muted>
                        {loading ? "Loading…" : "No open positions."}{" "}
                        <Link href="/" className="text-accent hover:underline">
                            Browse markets →
                        </Link>
                    </Muted>
                )}
            </Section>

            <Section title="Settled">
                {data?.settled.length ? (
                    data.settled.map((p) => (
                        <Row
                            key={`${p.marketId}-${p.outcomeIndex}`}
                            pos={p}
                            onClaim={
                                p.claimable && p.claimable > 0 && !claimed[p.marketId]
                                    ? () => claim(p)
                                    : undefined
                            }
                            claiming={claiming === p.marketId}
                            claimedTx={claimed[p.marketId]}
                        />
                    ))
                ) : (
                    <Muted>{loading ? "Loading…" : "Nothing settled yet."}</Muted>
                )}
            </Section>
        </div>
    );
}

function Row({
    pos,
    onClaim,
    claiming,
    claimedTx,
}: {
    pos: Position;
    onClaim?: () => void;
    claiming?: boolean;
    claimedTx?: string;
}) {
    const settled = pos.resolved || pos.voided;
    return (
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-0">
            <span
                className={`rounded-md px-2 py-0.5 font-mono text-[11px] ${pos.side === "YES" ? "bg-yes/15 text-yes" : "bg-no/15 text-no"
                    }`}
            >
                {pos.side}
            </span>

            <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-text">{pos.question}</div>
                <div className="mt-0.5 flex items-center gap-3 text-[11px] text-text-faint">
                    <span className="font-mono">{pos.asset}</span>
                    {settled ? null : <Countdown expiry={pos.expiry} />}
                    <span>{pos.contracts.toFixed(3)} contracts</span>
                </div>
            </div>

            <div className="text-right">
                {settled ? (
                    <div
                        className={`font-mono text-[13px] ${pos.voided ? "text-text-dim" : pos.won ? "text-yes" : "text-no"
                            }`}
                    >
                        {pos.voided ? "voided" : pos.won ? `+$${(pos.claimable ?? 0).toFixed(2)}` : "$0.00"}
                    </div>
                ) : (
                    <>
                        <div className="font-mono text-[13px] text-text">
                            ${(pos.value ?? 0).toFixed(2)}
                        </div>
                        <div className="text-[11px] text-text-faint">
                            @ {pos.mark !== null ? pos.mark.toFixed(3) : "—"}
                        </div>
                    </>
                )}
            </div>

            {claimedTx ? (
                <a
                    href={txUrl(claimedTx)}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-border px-3 py-1.5 text-[12px] text-text-dim hover:text-text"
                >
                    claimed ↗
                </a>
            ) : onClaim ? (
                <button
                    onClick={onClaim}
                    disabled={claiming}
                    className="rounded-lg bg-yes px-3 py-1.5 text-[12px] font-medium text-black hover:bg-yes-dim disabled:opacity-50"
                >
                    {claiming ? "Claiming…" : "Claim"}
                </button>
            ) : null}
        </div>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="mb-6">
            <div className="mb-2 text-[13px] font-medium text-text">{title}</div>
            <div className="rounded-xl border border-border bg-bg-elev">{children}</div>
        </div>
    );
}

function Muted({ children }: { children: React.ReactNode }) {
    return <div className="px-4 py-8 text-center text-[12px] text-text-dim">{children}</div>;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "yes" }) {
    return (
        <div className="flex flex-col">
            <span className="text-text-faint">{label}</span>
            <span className={`font-mono text-[14px] ${tone === "yes" ? "text-yes" : "text-text"}`}>
                {value}
            </span>
        </div>
    );
}

function Empty({
    title,
    body,
    action,
}: {
    title: string;
    body: string;
    action: React.ReactNode;
}) {
    return (
        <div className="mx-auto max-w-[1000px] px-6 py-24 text-center">
            <div className="text-[16px] text-text">{title}</div>
            <div className="mt-1 mb-5 text-[13px] text-text-dim">{body}</div>
            {action}
        </div>
    );
}
