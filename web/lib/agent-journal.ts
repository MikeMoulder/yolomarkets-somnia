// The agent's first-person journal — written by the reflect pass and by chat.
// Chain-agnostic, so it survived the Somnia migration untouched at the schema
// level; this accessor is new only because the old UI read it inline.
import { desc } from "drizzle-orm";
import { db } from "./db";
import { agentJournal } from "./db/schema";

export type JournalEntry = {
    id: number;
    ts: string;
    trigger: string;
    kind: string;
    market: string | null;
    title: string;
    body: string;
};

export async function readJournal(limit = 20): Promise<JournalEntry[]> {
    try {
        const rows = await db
            .select()
            .from(agentJournal)
            .orderBy(desc(agentJournal.ts))
            .limit(limit);
        return rows.map((r) => ({
            id: r.id,
            ts: r.ts.toISOString(),
            trigger: r.trigger,
            kind: r.kind,
            market: r.market,
            title: r.title,
            body: r.body,
        }));
    } catch {
        // The journal is decoration, never load-bearing — a cold DB must not
        // take the agent page down with it.
        return [];
    }
}
