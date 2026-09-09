import type { Metadata } from "next";
import { LegalPage } from "../legal-page";

export const metadata: Metadata = { title: "Attribution" };

export default function AttributionPage() {
    return (
        <LegalPage
            eyebrow="Legal · attribution"
            title="Data and software attribution"
            summary="The current app depends on external protocols, datasets, and open-source libraries. This page provides a lightweight attribution surface so the footer links resolve cleanly during development."
            sections={[
                {
                    heading: "Protocols and data",
                    body: [
                        "YOLO Markets runs on Somnia Shannon testnet and trades DreamDEX Event Contracts, which settle in tUSDC. Market data, order books and settlement come from the DreamDEX venue via @somnia-chain/markets-sdk.",
                        "Explorer links point to the Somnia Shannon explorer. Test collateral (tUSDC) is minted from the venue faucet; gas (STT) comes from the Somnia testnet faucet.",
                    ],
                },
                {
                    heading: "Software",
                    body: [
                        "The web app is built with Next.js, React, wagmi, viem, and TanStack Query. The contract system uses Solidity, Foundry, OpenZeppelin contracts, and PRBMath.",
                        "Where third-party dependencies impose license or attribution requirements, those obligations should be finalized before mainnet or broader public release.",
                    ],
                },
            ]}
        />
    );
}
