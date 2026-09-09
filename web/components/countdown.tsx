"use client";

// Live countdown to expiry.
//
// These contracts settle in minutes, so a server-rendered "in 4 minutes" is
// stale before the user finishes reading it. Ticks locally once a second and
// renders nothing until mounted, so SSR and the first client render agree.
import { useEffect, useState } from "react";

export function Countdown({ expiry, className = "" }: { expiry: number; className?: string }) {
    const [now, setNow] = useState<number | null>(null);

    useEffect(() => {
        setNow(Math.floor(Date.now() / 1000));
        const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
        return () => clearInterval(t);
    }, []);

    if (now === null) {
        return <span className={`font-mono text-[11px] text-text-faint ${className}`}>··:··</span>;
    }

    const left = expiry - now;
    if (left <= 0) {
        return <span className={`font-mono text-[11px] text-text-faint ${className}`}>expired</span>;
    }

    const urgent = left < 60;
    return (
        <span
            className={`font-mono text-[11px] tabular-nums ${urgent ? "text-warn" : "text-text-dim"} ${className}`}
        >
            {formatLeft(left)}
        </span>
    );
}

function formatLeft(sec: number): string {
    if (sec < 3600) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${String(s).padStart(2, "0")}`;
    }
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
}
