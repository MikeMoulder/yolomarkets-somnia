// Portfolio read. Server-side so the indexer client (and its WebSocket) stays
// a single shared instance instead of one per browser tab.
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { getPortfolio } from "@/lib/portfolio";
import { withDeadline, SSR_DEADLINE_MS } from "@/lib/with-deadline";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const user = new URL(req.url).searchParams.get("user");
    if (!user) return new NextResponse("missing ?user", { status: 400 });
    if (!isAddress(user)) return new NextResponse("invalid address", { status: 400 });

    const view = await withDeadline(
        getPortfolio(user),
        SSR_DEADLINE_MS,
        "getPortfolio",
        null,
    );
    if (!view) return new NextResponse("portfolio read timed out", { status: 504 });
    return NextResponse.json(view);
}
