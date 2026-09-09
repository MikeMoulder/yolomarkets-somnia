// Desk vitals, proxied from the execution bridge.
//
// The browser never talks to the bridge directly: the bridge holds the desk's
// signing key and binds to localhost. This route is the only way out.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const BRIDGE_URL = process.env.AGENT_BRIDGE_URL ?? "http://127.0.0.1:8091";
const BRIDGE_SECRET = process.env.AGENT_BRIDGE_SECRET ?? "";

export async function GET() {
    try {
        const res = await fetch(`${BRIDGE_URL}/status`, {
            headers: BRIDGE_SECRET ? { "x-bridge-secret": BRIDGE_SECRET } : {},
            // The bridge is local, so a short deadline is generous. Without one
            // a wedged bridge would hang this route and the panel with it.
            signal: AbortSignal.timeout(5_000),
            cache: "no-store",
        });
        if (!res.ok) return NextResponse.json({ online: false });
        return NextResponse.json(await res.json());
    } catch {
        // Offline is a normal state (the runner may simply not be up), not an
        // error worth a 500 — the panel renders "Offline" and moves on.
        return NextResponse.json({ online: false });
    }
}
