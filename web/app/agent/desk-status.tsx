"use client";

// Live desk vitals: is the runner up, what is it holding, what is it quoting.
// Polls the agent service through our own proxy so the browser never needs a
// direct route to the runner.
import { useEffect, useState } from "react";

type Status = {
    online: boolean;
    address?: string;
    gas?: string;
    collateral?: string;
    openOrders?: number;
    positions?: number;
    lastRunAt?: string | null;
    mode?: string;
};

export function AgentDeskStatus() {
    const [s, setS] = useState<Status | null>(null);

    useEffect(() => {
        let alive = true;
        const load = async () => {
            try {
                const res = await fetch("/api/agent/status");
                const json = (await res.json()) as Status;
                if (alive) setS(json);
            } catch {
                if (alive) setS({ online: false });
            }
        };
        void load();
        const t = setInterval(load, 15_000);
        return () => {
            alive = false;
            clearInterval(t);
        };
    }, []);

    const online = s?.online ?? false;

    return (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-border bg-bg-elev px-4 py-3">
            <div className="flex items-center gap-2">
                <span
                    className={`h-2 w-2 rounded-full ${online ? "animate-pulse bg-live" : "bg-text-faint"}`}
                />
                <span className="text-[13px] text-text">{online ? "Running" : "Offline"}</span>
                {s?.mode ? (
                    <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-text-dim">
                        {s.mode}
                    </span>
                ) : null}
            </div>
            <Vital label="tUSDC" value={s?.collateral ?? "—"} />
            <Vital label="STT" value={s?.gas ?? "—"} />
            <Vital label="Positions" value={s?.positions?.toString() ?? "—"} />
            <Vital label="Resting orders" value={s?.openOrders?.toString() ?? "—"} />
            <Vital
                label="Last pass"
                value={s?.lastRunAt ? new Date(s.lastRunAt).toLocaleTimeString() : "—"}
            />
        </div>
    );
}

function Vital({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-text-faint">{label}</span>
            <span className="font-mono text-[13px] text-text">{value}</span>
        </div>
    );
}
