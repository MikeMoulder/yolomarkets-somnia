// A wallet's Event Contract portfolio.
//
// The SDK's indexer answers positions, resting orders and fills in ONE call,
// so this module is mostly shaping: scaling raw balances, mirroring the YES
// book price onto NO positions, and splitting open from settled.
import type { Address } from "viem";
import { getExchange, COLLATERAL_DECIMALS } from "./somnia";

export type Position = {
    marketId: string;
    symbolish: string;
    question: string;
    asset: string;
    /** 0 = YES, 1 = NO. */
    outcomeIndex: number;
    side: "YES" | "NO";
    /** Contracts held. Each pays 1 tUSDC if this side wins. */
    contracts: number;
    /** Current mark for this side in (0,1), or null if the market never traded. */
    mark: number | null;
    /** contracts × mark, or null when unmarked. */
    value: number | null;
    expiry: number;
    status: string;
    resolved: boolean;
    voided: boolean;
    won: boolean | null;
    /** Payout claimable now: contracts if won, else 0. Null while unresolved. */
    claimable: number | null;
    marketAddress: string;
    poolAddress: string;
};

export type PortfolioView = {
    account: string;
    open: Position[];
    settled: Position[];
    openOrders: number;
    /** Sum of marked value across open positions. */
    openValue: number;
    /** Sum of claimable payouts on settled winners. */
    claimable: number;
};

function scale(raw: string | null | undefined, decimals: number): number {
    if (!raw) return 0;
    const n = Number(raw) / 10 ** decimals;
    return Number.isFinite(n) ? n : 0;
}

/** Prices arrive as 18-dec fixed point regardless of collateral decimals. */
function prob(raw: string | null | undefined): number | null {
    if (!raw) return null;
    const n = Number(raw) / 1e18;
    return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

export async function getPortfolio(account: Address): Promise<PortfolioView> {
    const ex = getExchange();
    const p = await ex.client.getPortfolio(account);
    const nowSec = Math.floor(Date.now() / 1000);

    const positions: Position[] = p.positions
        .map((row) => {
            const m = row.market;
            const contracts = scale(row.balance, COLLATERAL_DECIMALS);
            const yesMark = prob(m.lastPrice);
            const isYes = row.outcomeIndex === 0;
            // The book quotes YES; the NO mark is its mirror.
            const mark = yesMark === null ? null : isYes ? yesMark : 1 - yesMark;
            const resolved =
                m.winningOutcome !== null && m.winningOutcome !== undefined;
            const won = resolved ? m.winningOutcome === row.outcomeIndex : null;

            return {
                marketId: m.id,
                symbolish: `${m.asset ?? "?"} · ${m.interval ?? ""}`.trim(),
                question: m.question,
                asset: m.asset ?? "—",
                outcomeIndex: row.outcomeIndex,
                side: isYes ? ("YES" as const) : ("NO" as const),
                contracts,
                mark,
                value: mark === null ? null : contracts * mark,
                expiry: Number(m.expiry) || 0,
                status: m.status,
                resolved,
                voided: Boolean(m.voided),
                // A voided market returns collateral rather than paying a side.
                won: m.voided ? null : won,
                claimable: m.voided ? contracts : resolved ? (won ? contracts : 0) : null,
                marketAddress: m.marketAddress,
                poolAddress: m.poolAddress,
            };
        })
        .filter((row) => row.contracts > 0);

    const settled = positions.filter((r) => r.resolved || r.voided || r.expiry <= nowSec);
    const open = positions.filter((r) => !settled.includes(r));

    return {
        account,
        open,
        settled,
        openOrders: p.openOrders.length,
        openValue: open.reduce((a, r) => a + (r.value ?? 0), 0),
        claimable: settled.reduce((a, r) => a + (r.claimable ?? 0), 0),
    };
}
