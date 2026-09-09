// Runs once when a Next.js server instance boots. Pre-warms the SDK's market
// map so the first request doesn't pay for `loadMarkets()`. Fire-and-forget —
// server readiness is never delayed, and a cold indexer must not crash startup.
export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    const { getLoadedExchange } = await import("@/lib/somnia");
    void getLoadedExchange().catch(() => { });
}
