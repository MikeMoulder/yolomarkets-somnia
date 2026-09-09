// Somnia / DreamDEX connectivity smoke test.
//
//   npm run somnia:smoke          read-only checks
//   npm run somnia:smoke -- --fund   also mint tUSDC from the faucet (needs STT gas)
//
// Run this before blaming application code for an empty market list: it proves
// the chain, the indexer and the address book agree, and prints what a live
// Event Contract actually looks like.
import "./load-env";
import { createPublicClient, http, formatUnits } from "viem";
import { getLoadedExchange, getSignerExchange, somniaChain, HTTP_RPC_URL, INDEXER_URL, COLLATERAL_ADDRESS, COLLATERAL_DECIMALS, txUrl } from "../lib/somnia";
import { listEventMarkets, getBook, getBookParams } from "../lib/dreamdex";

const erc20BalanceAbi = [
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
] as const;

async function main() {
    const wantFund = process.argv.includes("--fund");
    let failures = 0;
    const check = (ok: boolean, label: string, detail = "") => {
        if (!ok) failures++;
        console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
    };

    console.log(`chain    ${somniaChain.name} (${somniaChain.id})`);
    console.log(`rpc      ${HTTP_RPC_URL}`);
    console.log(`indexer  ${INDEXER_URL}\n`);

    const pub = createPublicClient({ chain: somniaChain, transport: http(HTTP_RPC_URL) });
    const chainId = await pub.getChainId();
    check(chainId === 50312, "chain id is 50312", String(chainId));

    const block = await pub.getBlockNumber();
    check(block > 0n, "rpc serves blocks", `#${block}`);

    // --- indexer + market discovery -----------------------------------------
    const ex = await getLoadedExchange();
    check(ex.symbols.length > 0, "loadMarkets() returns symbols", `${ex.symbols.length} symbols`);

    const markets = await listEventMarkets({ limit: 50 });
    check(markets.length > 0, "live binary Event Contracts found", `${markets.length} live`);
    if (!markets.length) {
        console.log("\nNo live markets — the venue may be between rolls. Retry in a minute.");
        process.exit(failures ? 1 : 0);
    }

    const symbolsResolved = markets.filter((m) => m.symbol.includes("/")).length;
    check(symbolsResolved === markets.length, "every market resolved a tradable symbol",
        `${symbolsResolved}/${markets.length}`);

    const m = markets[0];
    console.log("\nnearest expiry:");
    console.log(`  ${m.question}`);
    console.log(`  symbol   ${m.symbol}`);
    console.log(`  outcomes ${m.yesSymbol} | ${m.noSymbol}`);
    console.log(`  interval ${m.interval ?? "?"}  expires in ${m.secondsLeft}s  status ${m.status}`);
    console.log(`  volume   ${m.volume} tUSDC over ${m.tradeCount} trades  last ${m.lastPrice ?? "—"}`);
    console.log(`  pool     ${m.poolAddress}`);

    check(m.expiry > 0 && m.secondsLeft > 0, "expiry parses and is in the future");
    check(m.lastPrice === null || (m.lastPrice > 0 && m.lastPrice < 1),
        "lastPrice is a probability in (0,1)", String(m.lastPrice));

    // --- book + venue params -------------------------------------------------
    const params = await getBookParams(m.poolAddress);
    console.log(`\nbook params: tick ${params.tickSize} lot ${params.lotSize} minQty ${params.minQuantity}`);
    check(params.tickSize > 0n && params.lotSize > 0n, "venue exposes tick/lot sizes");

    const book = await getBook(m.yesSymbol, 5);
    console.log(`book ${m.yesSymbol}: ${book.bids.length} bids / ${book.asks.length} asks`);
    if (book.bids.length) console.log(`  best bid ${book.bids[0][0]} x ${book.bids[0][1]}`);
    if (book.asks.length) console.log(`  best ask ${book.asks[0][0]} x ${book.asks[0][1]}`);
    check(Array.isArray(book.bids) && Array.isArray(book.asks), "order book fetches");
    const pricesSane = [...book.bids, ...book.asks].every(([p]) => p > 0 && p < 1);
    check(pricesSane, "all book prices are probabilities in (0,1)");

    // --- signer ---------------------------------------------------------------
    const pk = process.env.SOMNIA_PRIVATE_KEY as `0x${string}` | undefined;
    if (!pk) {
        console.log("\nSOMNIA_PRIVATE_KEY not set — skipping wallet checks.");
    } else {
        const signer = getSignerExchange(pk);
        const addr = signer.walletAddress as `0x${string}`;
        const stt = await pub.getBalance({ address: addr });
        const tusdc = await pub.readContract({
            address: COLLATERAL_ADDRESS as `0x${string}`,
            abi: erc20BalanceAbi,
            functionName: "balanceOf",
            args: [addr],
        });
        console.log(`\nsigner   ${addr}`);
        console.log(`  STT    ${formatUnits(stt, 18)}`);
        console.log(`  tUSDC  ${formatUnits(tusdc, COLLATERAL_DECIMALS)}`);
        check(stt > 0n, "signer has STT for gas",
            stt > 0n ? "" : "fund it — nothing on-chain works without gas");

        if (wantFund && stt > 0n) {
            console.log("\nminting tUSDC from the faucet…");
            const res = await signer.trader.faucet();
            console.log(`  tx ${txUrl(res.hash)}`);
            const after = await pub.readContract({
                address: COLLATERAL_ADDRESS as `0x${string}`,
                abi: erc20BalanceAbi,
                functionName: "balanceOf",
                args: [addr],
            });
            check(after > tusdc, "faucet increased tUSDC balance",
                `${formatUnits(tusdc, 6)} -> ${formatUnits(after, 6)}`);
        }
    }

    console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
}

main().catch((err) => {
    console.error("\nsmoke test threw:", err);
    process.exit(1);
});
