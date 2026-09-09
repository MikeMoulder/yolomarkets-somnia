/**
 * Drizzle schema. Two tables, both narrative rather than load-bearing: the
 * desk records what it decided and why, and the app renders it.
 *
 * Nothing here is on the trading path. Positions, orders and balances all live
 * on chain and are read through the SDK indexer, so a cold or absent database
 * costs you the feed and nothing else.
 *
 * The Python side reads the same database via psycopg (agent/db.py), so column
 * names are snake_case.
 */
import {
    pgTable,
    text,
    bigint,
    numeric,
    boolean,
    timestamp,
    jsonb,
    bigserial,
    integer,
    index,
} from "drizzle-orm/pg-core";

// One entry in the model's tool-use trace, stored on each decision row: what it
// called, with what, what came back, and how long it took. Rendered on /agent
// so a reader can replay how a decision was reached.
export type ToolTraceEntry = {
    iteration: number;
    name: string;
    input: Record<string, unknown>;
    result: unknown;
    is_error: boolean;
    elapsed_ms: number;
};

export const agentDecisions = pgTable(
    "agent_decisions",
    {
        id: bigserial("id", { mode: "number" }).primaryKey(),
        ts: timestamp("ts", { withTimezone: true }).notNull(),
        market: text("market").notNull(),
        question: text("question").notNull(),
        category: text("category").notNull(),
        marketProb: numeric("market_prob").notNull(),
        polymarketProb: numeric("polymarket_prob"),
        polymarketSlug: text("polymarket_slug"),
        aiProb: numeric("ai_prob").notNull(),
        aiConfidence: numeric("ai_confidence").notNull(),
        edgePts: numeric("edge_pts").notNull(),
        kellyFraction: numeric("kelly_fraction").notNull(),
        bankrollUsdc: numeric("bankroll_usdc").notNull(),
        action: text("action").notNull(),       // pass | buy_yes | buy_no
        passReason: text("pass_reason"),
        shares: bigint("shares", { mode: "number" }).notNull(),  // 6-dec int
        costUsdc: numeric("cost_usdc").notNull(),
        maxCostUsdc: numeric("max_cost_usdc").notNull(),
        txHash: text("tx_hash"),
        paper: boolean("paper").notNull(),
        reasoning: text("reasoning").notNull(),
        watchFor: jsonb("watch_for").$type<string[]>().notNull(),
        timeSensitivity: text("time_sensitivity").notNull(),
        userAddr: text("user_addr"),          // null = dev/legacy
        agentAddr: text("agent_addr"),
        // Phase 5 — populated only when the Claude tool-use brain produced
        // this decision. Drives the judge-replayable trace on /agent.
        newsSummary: text("news_summary").notNull().default(""),
        toolTrace: jsonb("tool_trace")
            .$type<ToolTraceEntry[]>()
            .notNull()
            .default([]),
        brainModel: text("brain_model"),
        brainIterations: integer("brain_iterations"),
        promptHash: text("prompt_hash"),
        toolsCalled: jsonb("tools_called").$type<string[]>().notNull().default([]),
        externalOddsSnapshot: jsonb("external_odds_snapshot")
            .$type<Record<string, unknown>>()
            .notNull()
            .default({}),
        policySnapshot: jsonb("policy_snapshot")
            .$type<Record<string, unknown>>()
            .notNull()
            .default({}),
        platformFeeUsdc: numeric("platform_fee_usdc").notNull().default("0"),
        notificationStatus: text("notification_status"),
    },
    (t) => [
        index("idx_agent_decisions_user_ts").on(t.userAddr, t.ts),
        index("idx_agent_decisions_ts").on(t.ts),
        index("idx_agent_decisions_market").on(t.market),
    ],
);


// ── Agent memory & narrative (Agent v2 · M1) ──────────────────────────────
// Written by the Python agent core; read by the web /agent feed + chat. The
// journal is additive to agent_decisions (which the deterministic risk gate
// still reads for spend/trade counts).

export const agentJournal = pgTable(
    "agent_journal",
    {
        id: bigserial("id", { mode: "number" }).primaryKey(),
        ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
        userAddr: text("user_addr").notNull(),
        trigger: text("trigger").notNull(),      // autonomous | chat | trade | reflect
        kind: text("kind").notNull().default("note"),  // plan|decision|reflection|trade|message|note
        market: text("market"),
        title: text("title").notNull().default(""),
        body: text("body").notNull(),
        meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
        decisionId: bigint("decision_id", { mode: "number" }),  // loose link to agent_decisions.id
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
        index("idx_agent_journal_user_ts").on(t.userAddr, t.ts),
        index("idx_agent_journal_ts").on(t.ts),
        index("idx_agent_journal_market").on(t.market),
    ],
);

export type AgentDecisionRow = typeof agentDecisions.$inferSelect;
export type NewAgentDecisionRow = typeof agentDecisions.$inferInsert;
export type AgentJournalRow = typeof agentJournal.$inferSelect;
