"use client";

// Header wallet control: connect, or show address + the two balances.
//
// It surfaces "needs STT" prominently because on Somnia gas and collateral are
// different tokens — a wallet full of tUSDC still cannot place an order, and
// the failure otherwise shows up as an opaque rejected transaction.
import { useState } from "react";
import { useAccount, useDisconnect, useSwitchChain } from "wagmi";
import { useWalletModal } from "./wallet-modal";
import { useActiveWallet } from "@/lib/use-active-wallet";
import { somniaChain, addressUrl } from "@/lib/somnia";
import { shortAddr } from "@/lib/format";

export function WalletButton() {
    const { openWalletModal } = useWalletModal();
    const { disconnect } = useDisconnect();
    const { switchChain } = useSwitchChain();
    const { isConnected } = useAccount();
    const { address, gas, collateral, wrongChain, needsGas } = useActiveWallet();
    const [open, setOpen] = useState(false);

    if (!isConnected || !address) {
        return (
            <button
                onClick={openWalletModal}
                className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-black hover:bg-accent-dim transition-colors"
            >
                Connect
            </button>
        );
    }

    if (wrongChain) {
        return (
            <button
                onClick={() => switchChain({ chainId: somniaChain.id })}
                className="rounded-full bg-warn px-4 py-1.5 text-[13px] font-medium text-black"
            >
                Switch to Somnia
            </button>
        );
    }

    return (
        <div className="relative">
            <button
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-2 rounded-full border border-border bg-bg-elev px-3 py-1.5 text-[13px] text-text hover:border-border-bright transition-colors"
            >
                {needsGas ? <span className="h-1.5 w-1.5 rounded-full bg-warn" /> : null}
                <span className="font-mono">{shortAddr(address)}</span>
                <span className="text-text-dim">{collateral?.formatted ?? "—"} tUSDC</span>
            </button>

            {open ? (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                    <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-bg-elev p-3 shadow-2xl">
                        <div className="mb-2 font-mono text-[12px] text-text-dim break-all">{address}</div>

                        <div className="mb-3 space-y-1 text-[12px]">
                            <Row label="tUSDC (collateral)" value={collateral?.formatted ?? "—"} />
                            <Row label="STT (gas)" value={gas?.formatted ?? "—"} />
                        </div>

                        {needsGas ? (
                            <div className="mb-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] text-warn">
                                No STT — you can browse but not trade. Get testnet gas from the
                                Somnia faucet.
                            </div>
                        ) : null}

                        <a
                            href={addressUrl(address)}
                            target="_blank"
                            rel="noreferrer"
                            className="block rounded-lg px-2 py-1.5 text-[12px] text-text-dim hover:bg-bg-hover hover:text-text"
                        >
                            View on explorer ↗
                        </a>
                        <button
                            onClick={() => {
                                disconnect();
                                setOpen(false);
                            }}
                            className="mt-1 block w-full rounded-lg px-2 py-1.5 text-left text-[12px] text-no hover:bg-bg-hover"
                        >
                            Disconnect
                        </button>
                    </div>
                </>
            ) : null}
        </div>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between">
            <span className="text-text-faint">{label}</span>
            <span className="font-mono text-text">{value}</span>
        </div>
    );
}
