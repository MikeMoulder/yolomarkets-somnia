// The execution bridge: TypeScript owns the wallet, Python owns the brain.
//
// WHY THIS EXISTS. The DreamDEX SDK is TypeScript-only and does the parts that
// are genuinely hard to redo: tick/lot quantization against live venue params,
// order signing, the reactive order book, and one-round-trip confirms via
// realtime_sendRawTransaction. Reimplementing that in web3.py is how a 60-hour
// project fails. So the agent's reasoning stays in Python and every chain write
// goes through this process.
//
// It is deliberately a plain node:http server, not Express — one dependency
// fewer, and the surface is six routes.
//
// SAFETY. Quantization happens HERE, never in Python: a price float off the
// wire is snapped to the venue's tick and a size to its lot before it can reach
// the chain. `DRY_RUN=1` (the default) makes every write a no-op that still
// returns the shape a real fill would, so the agent loop can be exercised end
// to end without spending gas.
import "./load-env";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPublicClient, http, formatUnits } from "viem";
import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import {
    getSignerExchange,
    somniaChain,
    HTTP_RPC_URL,
    COLLATERAL_ADDRESS,
    COLLATERAL_DECIMALS,
    txUrl,
} from "../lib/somnia";
import { listEventMarkets, getBook, type EventMarket } from "../lib/dreamdex";
import { getPortfolio } from "../lib/portfolio";

const PORT = Number(process.env.BRIDGE_PORT ?? 8090);
const SECRET = process.env.AGENT_BRIDGE_SECRET ?? "";
const DRY_RUN = process.env.BRIDGE_DRY_RUN !== "0";
const PK = process.env.SOMNIA_PRIVATE_KEY as `0x${string}` | undefined;

const balanceOfAbi = [
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
] as const;

const pub = createPublicClient({ chain: somniaChain, transport: http(HTTP_RPC_URL) });

let exchange: SomniaMarkets | null = null;
let lastLoad = 0;

/**
 * The signing exchange, with its market map kept fresh.
 *
 * Same trap as the web tier: contracts roll every minute, and an order against
 * a symbol the map has never seen throws. 20s is well inside the shortest
 * series interval.
 */
async function ex(): Promise<SomniaMarkets> {
    if (!PK) throw new Error("SOMNIA_PRIVATE_KEY is not set — the bridge cannot sign");
    if (!exchange) exchange = getSignerExchange(PK);
    if (Date.now() - lastLoad > 20_000) {
        await exchange.loadMarkets();
        lastLoad = Date.now();
    }
    return exchange;
}

// ---------------------------------------------------------------------------
// Quantization — the one thing Python is never allowed to do itself.
// ---------------------------------------------------------------------------

const bookParamsCache = new Map<string, { tickSize: bigint; lotSize: bigint; minQuantity: bigint }>();

async function bookParams(pool: `0x${string}`) {
    const key = pool.toLowerCase();
    const hit = bookParamsCache.get(key);
    if (hit) return hit;
    const e = await ex();
    const params = await e.client.getBinaryBookParams(pool);
    bookParamsCache.set(key, params);
    return params;
}

/**
 * Snap a probability to the venue tick and a size to the venue lot.
 *
 * Both round in the direction that cannot cost the caller more than they asked
 * for: price down for a buy, size down always. Rounding a size UP would let a
 * "max loss $5" order spend $5.01, which is the one promise the UI makes.
 */
function quantize(
    price: number,
    size: number,
    params: { tickSize: bigint; lotSize: bigint; minQuantity: bigint },
) {
    const ONE = 10n ** BigInt(COLLATERAL_DECIMALS);
    const rawPrice = BigInt(Math.floor(price * Number(ONE)));
    const rawSize = BigInt(Math.floor(size * Number(ONE)));

    const snappedPrice = (rawPrice / params.tickSize) * params.tickSize;
    const snappedSize = (rawSize / params.lotSize) * params.lotSize;

    return {
        price: Number(snappedPrice) / Number(ONE),
        size: Number(snappedSize) / Number(ONE),
        belowMin: snappedSize < params.minQuantity,
        rawSize: snappedSize,
    };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type Handler = (body: Record<string, unknown>, url: URL) => Promise<unknown>;

const routes: Record<string, Handler> = {
    "GET /health": async () => {
        const address = PK ? (await ex()).walletAddress : null;
        return { ok: true, dryRun: DRY_RUN, address, chain: somniaChain.id };
    },

    "GET /status": async () => {
        if (!PK) return { online: true, dryRun: DRY_RUN, address: null };
        const e = await ex();
        const address = e.walletAddress as `0x${string}`;
        const [stt, tusdc, portfolio] = await Promise.all([
            pub.getBalance({ address }),
            pub.readContract({
                address: COLLATERAL_ADDRESS as `0x${string}`,
                abi: balanceOfAbi,
                functionName: "balanceOf",
                args: [address],
            }),
            getPortfolio(address).catch(() => null),
        ]);
        return {
            online: true,
            mode: DRY_RUN ? "dry-run" : "live",
            address,
            gas: Number(formatUnits(stt, 18)).toFixed(4),
            collateral: Number(formatUnits(tusdc as bigint, COLLATERAL_DECIMALS)).toFixed(2),
            positions: portfolio?.open.length ?? 0,
            openOrders: portfolio?.openOrders ?? 0,
        };
    },

    "GET /markets": async (_b, url) => {
        const limit = Number(url.searchParams.get("limit") ?? 60);
        const minLeft = Number(url.searchParams.get("minSecondsLeft") ?? 60);
        const markets = await listEventMarkets({ limit, minSecondsLeft: minLeft });
        return { markets };
    },

    "GET /book": async (_b, url) => {
        const symbol = url.searchParams.get("symbol");
        if (!symbol) throw new BadRequest("missing ?symbol");
        const depth = Number(url.searchParams.get("depth") ?? 10);
        return await getBook(symbol, depth);
    },

    // The oracle price feed every binary here settles on. Reading it is what
    // lets the agent price a contract from spot-vs-strike instead of guessing.
    "GET /price": async (_b, url) => {
        const asset = url.searchParams.get("asset");
        if (!asset) throw new BadRequest("missing ?asset");
        const e = await ex();
        const p = await e.fetchPrice(asset.toUpperCase());
        if (!p) return { asset, price: null };
        return { asset: p.symbol, price: p.price, ema: (p.info as { ema?: number }).ema ?? p.price, timestamp: p.timestamp };
    },

    // OHLCV of the settlement feed — the input to realized volatility.
    "GET /candles": async (_b, url) => {
        const asset = url.searchParams.get("asset");
        if (!asset) throw new BadRequest("missing ?asset");
        const timeframe = url.searchParams.get("timeframe") ?? "1m";
        const limit = Number(url.searchParams.get("limit") ?? 60);
        const e = await ex();
        const rows = await e.fetchPriceOHLCV(asset.toUpperCase(), timeframe, undefined, limit);
        return { asset: asset.toUpperCase(), timeframe, candles: rows };
    },

    // "Reference" markets (strike 0, e.g. "closes at or above its opening
    // price") only become priceable once the venue posts the opening tick.
    "GET /opening": async (_b, url) => {
        const ids = (url.searchParams.get("marketIds") ?? "").split(",").filter(Boolean);
        if (!ids.length) throw new BadRequest("missing ?marketIds");
        const e = await ex();
        return { opening: await e.client.getOpeningPrices(ids) };
    },

    "GET /portfolio": async (_b, url) => {
        const account = url.searchParams.get("user") ?? (PK ? (await ex()).walletAddress : null);
        if (!account) throw new BadRequest("missing ?user");
        return await getPortfolio(account as `0x${string}`);
    },

    "POST /order": async (body) => {
        const symbol = str(body.symbol, "symbol");
        const side = str(body.side, "side");           // "YES" | "NO"
        const type = (body.type as string) ?? "limit"; // "limit" | "market"
        const price = num(body.price, "price");
        const size = num(body.size, "size");
        const postOnly = Boolean(body.postOnly);

        const e = await ex();
        const market = e.markets[symbol];
        if (!market) throw new BadRequest(`unknown market ${symbol}`);
        const outcome = side === "YES" ? `${symbol}#YES` : `${symbol}#NO`;

        const pool = (market.info as { poolAddress: string }).poolAddress as `0x${string}`;
        const q = quantize(price, size, await bookParams(pool));
        if (q.belowMin) {
            // Report numbers only — `q.rawSize` is a bigint and JSON.stringify
            // throws on those, which would turn a clean rejection into a 500.
            return {
                ok: false,
                reason: "below venue minimum quantity",
                quantized: { price: q.price, size: q.size },
            };
        }

        if (DRY_RUN) {
            return {
                ok: true,
                dryRun: true,
                symbol: outcome,
                side,
                price: q.price,
                size: q.size,
                filled: 0,
                note: "BRIDGE_DRY_RUN=1 — nothing was signed",
            };
        }

        const order = await e.createOrder(
            outcome,
            type as "limit" | "market",
            "buy",
            q.size,
            type === "limit" ? q.price : undefined,
            postOnly ? { postOnly: true } : undefined,
        );
        const hash = (order as unknown as { txHash?: string }).txHash;
        return {
            ok: true,
            dryRun: false,
            symbol: outcome,
            side,
            orderId: String(order.id ?? ""),
            price: Number(order.price ?? q.price),
            size: q.size,
            filled: Number(order.filled ?? 0),
            status: order.status,
            txHash: hash,
            explorer: hash ? txUrl(hash) : null,
        };
    },

    "POST /cancel": async (body) => {
        const id = str(body.id, "id");
        const symbol = str(body.symbol, "symbol");
        if (DRY_RUN) return { ok: true, dryRun: true, id };
        const e = await ex();
        await e.cancelOrder(id, symbol);
        return { ok: true, dryRun: false, id };
    },

    "POST /redeem": async (body) => {
        const marketId = str(body.marketId, "marketId") as `0x${string}`;
        const outcomeIdx = num(body.outcomeIdx, "outcomeIdx") === 0 ? 0 : 1;
        const amount = num(body.amount, "amount");
        if (DRY_RUN) return { ok: true, dryRun: true, marketId, amount };
        const e = await ex();
        const onchain = await e.client.getMarketOnchain(marketId);
        const res = await e.trader.redeem({
            marketId,
            market: onchain.marketAddress,
            outcomeToken: onchain.outcomeToken,
            outcomeIdx,
            amount: BigInt(Math.round(amount * 10 ** COLLATERAL_DECIMALS)),
        });
        return { ok: true, dryRun: false, txHash: res.hash, explorer: txUrl(res.hash) };
    },

    // Testnet convenience: mint collateral to the desk. Gas (STT) still has to
    // come from the faucet — the two tokens are unrelated.
    "POST /faucet": async () => {
        if (DRY_RUN) return { ok: true, dryRun: true };
        const e = await ex();
        const res = await e.trader.faucet();
        return { ok: true, txHash: res.hash, explorer: txUrl(res.hash) };
    },
};

// ---------------------------------------------------------------------------

class BadRequest extends Error { }

function str(v: unknown, name: string): string {
    if (typeof v !== "string" || !v) throw new BadRequest(`missing ${name}`);
    return v;
}

function num(v: unknown, name: string): number {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new BadRequest(`missing or invalid ${name}`);
    return n;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    } catch {
        throw new BadRequest("body is not valid JSON");
    }
}

function send(res: ServerResponse, status: number, payload: unknown) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const key = `${req.method} ${url.pathname}`;

    // Shared-secret auth. The bridge signs transactions, so it binds to
    // localhost and still refuses unauthenticated callers.
    if (SECRET && url.pathname !== "/health") {
        if (req.headers["x-bridge-secret"] !== SECRET) {
            return send(res, 401, { error: "unauthorized" });
        }
    }

    const handler = routes[key];
    if (!handler) return send(res, 404, { error: `no route ${key}` });

    try {
        const body = req.method === "POST" ? await readBody(req) : {};
        send(res, 200, await handler(body, url));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = err instanceof BadRequest ? 400 : 500;
        if (status === 500) console.error(`[bridge] ${key} failed:`, err);
        send(res, status, { error: msg });
    }
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`[bridge] listening on 127.0.0.1:${PORT}`);
    console.log(`[bridge] chain ${somniaChain.id}  mode ${DRY_RUN ? "DRY-RUN" : "LIVE"}`);
    if (!PK) console.warn("[bridge] SOMNIA_PRIVATE_KEY unset — reads only");
    if (!SECRET) console.warn("[bridge] AGENT_BRIDGE_SECRET unset — no auth");
});
