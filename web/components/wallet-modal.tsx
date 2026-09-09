"use client";

// Connect sheet: injected and WalletConnect connectors, de-duplicated by name.
import { createContext, useContext, useState, type ReactNode } from "react";
import { useConnect, useAccount } from "wagmi";

type WalletModalCtx = { openWalletModal: () => void; closeWalletModal: () => void };

const Ctx = createContext<WalletModalCtx>({
    openWalletModal: () => { },
    closeWalletModal: () => { },
});

export function useWalletModal() {
    return useContext(Ctx);
}

export function WalletModalProvider({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false);
    return (
        <Ctx.Provider
            value={{ openWalletModal: () => setOpen(true), closeWalletModal: () => setOpen(false) }}
        >
            {children}
            {open ? <WalletModal onClose={() => setOpen(false)} /> : null}
        </Ctx.Provider>
    );
}

function WalletModal({ onClose }: { onClose: () => void }) {
    const { connectors, connectAsync, isPending } = useConnect();
    const { isConnected } = useAccount();
    const [error, setError] = useState<string | null>(null);

    if (isConnected) onClose();

    // De-duplicate connectors by name: multiple injected providers register
    // under the same label and render as identical rows otherwise.
    const seen = new Set<string>();
    const list = connectors.filter((c) => {
        if (seen.has(c.name)) return false;
        seen.add(c.name);
        return true;
    });

    return (
        <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={onClose}
        >
            <div
                className="w-full max-w-sm rounded-2xl border border-border bg-bg-elev p-5 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mb-1 text-[15px] font-semibold text-text">Connect wallet</div>
                <div className="mb-4 text-[12px] text-text-dim">
                    Somnia Shannon testnet · gas is STT, collateral is tUSDC
                </div>

                <div className="flex flex-col gap-2">
                    {list.map((c) => (
                        <button
                            key={c.uid}
                            disabled={isPending}
                            onClick={async () => {
                                setError(null);
                                try {
                                    // connectAsync, not connect — the sync mutate fn
                                    // swallows rejections and the sheet just sits there.
                                    await connectAsync({ connector: c });
                                    onClose();
                                } catch (err) {
                                    setError(err instanceof Error ? err.message : "Connection failed");
                                }
                            }}
                            className="flex items-center justify-between rounded-xl border border-border bg-bg px-4 py-3 text-[13px] text-text hover:border-border-bright hover:bg-bg-hover disabled:opacity-50 transition-colors"
                        >
                            <span>{c.name}</span>
                            <span className="text-text-faint">→</span>
                        </button>
                    ))}
                    {list.length === 0 ? (
                        <div className="rounded-xl border border-border bg-bg px-4 py-3 text-[13px] text-text-dim">
                            No wallet detected. Install MetaMask or another EVM wallet.
                        </div>
                    ) : null}
                </div>

                {error ? <div className="mt-3 text-[12px] text-no">{error}</div> : null}
            </div>
        </div>
    );
}
