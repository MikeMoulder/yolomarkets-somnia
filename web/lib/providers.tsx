"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "./wagmi";
import { WalletModalProvider } from "@/components/wallet-modal";
import { SomniaMarketsProvider } from "@somnia-chain/markets-sdk/react";
import { getExchange } from "./somnia";

export function Providers({ children }: { children: ReactNode }) {
    const [qc] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        staleTime: 30_000,
                        refetchOnWindowFocus: false,
                    },
                },
            }),
    );
    return (
        <WagmiProvider config={wagmiConfig}>
            <QueryClientProvider client={qc}>
                {/* The SDK client behind every use*Live* hook. It materialises the
                    resting order book from chain logs over one WebSocket, so the
                    UI updates on the block rather than on a timer — there is no
                    polling anywhere in this app. */}
                <SomniaMarketsProvider client={getExchange().client}>
                    <WalletModalProvider>{children}</WalletModalProvider>
                </SomniaMarketsProvider>
            </QueryClientProvider>
        </WagmiProvider>
    );
}
