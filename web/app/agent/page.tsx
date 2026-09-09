import Link from "next/link";
import { readDecisions, type AgentDecision } from "@/lib/agent-decisions";
import { readJournal, type JournalEntry } from "@/lib/agent-journal";
import { withDeadline, SSR_DEADLINE_MS } from "@/lib/with-deadline";
import { addressUrl, txUrl } from "@/lib/somnia";
import { AgentDeskStatus } from "./desk-status";

export const dynamic = "force-dynamic";

const DESK_ADDRESS = process.env.NEXT_PUBLIC_AGENT_ADDRESS ?? "";

export default async function AgentPage() {
    const [feed, journal] = await Promise.all([
        withDeadline(readDecisions(40), SSR_DEADLINE_MS, "readDecisions", null),
        withDeadline(readJournal(20), SSR_DEADLINE_MS, "readJournal", [] as JournalEntry[]),
    ]);

    const decisions = feed?.decisions ?? [];
    const traded = decisions.filter((d) => d.action !== "pass");

    return (
        <div className="mx-auto max-w-[1100px] px-6 py-8">
            <div className="mb-6">
                <h1 className="text-[22px] font-semibold tracking-tight text-text">The desk</h1>
                <p className="mt-1 max-w-2xl text-[13px] text-text-dim">
                    An autonomous agent trading DreamDEX Event Contracts on Somnia. It reads the
                    book, prices a fair value against cross-venue consensus and live news, quotes
                    or takes when there is an edge, and redeems on settlement — narrating every
                    step. Ask it anything with the chat bubble.
                </p>
                {DESK_ADDRESS ? (
                    <a
                        href={addressUrl(DESK_ADDRESS)}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block font-mono text-[11px] text-text-faint hover:text-text-dim"
                    >
                        {DESK_ADDRESS} ↗
                    </a>
                ) : null}
            </div>

            <AgentDeskStatus />

            <div className="mt-6 grid gap-4 lg:grid-cols-[1.15fr_1fr]">
                <Panel
                    title="Decisions"
                    subtitle={`${traded.length} trades · ${decisions.length - traded.length} passes`}
                >
                    {decisions.length === 0 ? (
                        <Muted>
                            No decisions logged yet. Start the agent runner to populate this feed.
                        </Muted>
                    ) : (
                        decisions.slice(0, 20).map((d, i) => <DecisionRow key={i} d={d} />)
                    )}
                </Panel>

                <Panel title="Journal" subtitle="the agent in its own words">
                    {journal.length === 0 ? (
                        <Muted>Nothing written yet.</Muted>
                    ) : (
                        journal.map((j) => <JournalRow key={j.id} entry={j} />)
                    )}
                </Panel>
            </div>

            <p className="mt-6 text-[11px] text-text-faint">
                Testnet only. Positions settle in tUSDC and have no monetary value.{" "}
                <Link href="/legal/risk" className="hover:text-text-dim">
                    Risk notice
                </Link>
            </p>
        </div>
    );
}

function DecisionRow({ d }: { d: AgentDecision }) {
    const traded = d.action !== "pass";
    const side = d.action === "buy_yes" ? "YES" : d.action === "buy_no" ? "NO" : null;
    return (
        <div className="border-b border-border px-4 py-3 last:border-0">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-text">{d.question}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-text-faint">
                        <span>book {(d.market_prob * 100).toFixed(0)}%</span>
                        <span className="text-accent">fair {(d.ai_prob * 100).toFixed(0)}%</span>
                        <span className={d.edge_pts >= 0 ? "text-yes" : "text-no"}>
                            edge {d.edge_pts >= 0 ? "+" : ""}
                            {d.edge_pts.toFixed(1)}pts
                        </span>
                        <span>conf {(d.ai_confidence * 100).toFixed(0)}%</span>
                    </div>
                </div>
                {side ? (
                    <span
                        className={`shrink-0 rounded-md px-2 py-0.5 font-mono text-[11px] ${side === "YES" ? "bg-yes/15 text-yes" : "bg-no/15 text-no"
                            }`}
                    >
                        {side} ${d.cost_usdc.toFixed(2)}
                    </span>
                ) : (
                    <span className="shrink-0 rounded-md bg-bg px-2 py-0.5 font-mono text-[11px] text-text-faint">
                        pass
                    </span>
                )}
            </div>

            {d.reasoning ? (
                <p className="mt-2 line-clamp-2 text-[12px] leading-snug text-text-dim">
                    {d.reasoning}
                </p>
            ) : null}

            {traded && d.tx_hash ? (
                <a
                    href={txUrl(d.tx_hash)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-block font-mono text-[10px] text-accent hover:underline"
                >
                    tx ↗
                </a>
            ) : null}
        </div>
    );
}

function JournalRow({ entry }: { entry: JournalEntry }) {
    return (
        <div className="border-b border-border px-4 py-3 last:border-0">
            <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-text-faint">
                <span className="rounded bg-bg px-1.5 py-0.5">{entry.kind}</span>
                <span>{new Date(entry.ts).toLocaleTimeString()}</span>
            </div>
            {entry.title ? (
                <div className="text-[12.5px] font-medium text-text">{entry.title}</div>
            ) : null}
            <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-snug text-text-dim">
                {entry.body.length > 400 ? `${entry.body.slice(0, 400)}…` : entry.body}
            </p>
        </div>
    );
}

function Panel({
    title,
    subtitle,
    children,
}: {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
}) {
    return (
        <div>
            <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[13px] font-medium text-text">{title}</span>
                {subtitle ? <span className="text-[11px] text-text-faint">{subtitle}</span> : null}
            </div>
            <div className="max-h-[640px] overflow-y-auto rounded-xl border border-border bg-bg-elev">
                {children}
            </div>
        </div>
    );
}

function Muted({ children }: { children: React.ReactNode }) {
    return <div className="px-4 py-10 text-center text-[12px] text-text-dim">{children}</div>;
}
