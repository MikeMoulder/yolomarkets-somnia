-- The desk's narrative store. Two tables, neither on the trading path:
-- positions, orders and balances live on chain and are read through the SDK
-- indexer, so an absent database costs you the feed and nothing else.

CREATE TABLE IF NOT EXISTS agent_decisions (
    id                  BIGSERIAL PRIMARY KEY,
    ts                  TIMESTAMPTZ NOT NULL,
    market              TEXT        NOT NULL,
    question            TEXT        NOT NULL,
    category            TEXT        NOT NULL,
    market_prob         NUMERIC     NOT NULL,
    polymarket_prob     NUMERIC,
    polymarket_slug     TEXT,
    ai_prob             NUMERIC     NOT NULL,
    ai_confidence       NUMERIC     NOT NULL,
    edge_pts            NUMERIC     NOT NULL,
    kelly_fraction      NUMERIC     NOT NULL,
    bankroll_usdc       NUMERIC     NOT NULL,
    action              TEXT        NOT NULL,
    pass_reason         TEXT,
    shares              BIGINT      NOT NULL DEFAULT 0,
    cost_usdc           NUMERIC     NOT NULL DEFAULT 0,
    max_cost_usdc       NUMERIC     NOT NULL DEFAULT 0,
    tx_hash             TEXT,
    paper               BOOLEAN     NOT NULL DEFAULT TRUE,
    reasoning           TEXT        NOT NULL DEFAULT '',
    watch_for           JSONB       NOT NULL DEFAULT '[]'::jsonb,
    time_sensitivity    TEXT        NOT NULL DEFAULT 'low',
    user_addr           TEXT,
    agent_addr          TEXT,
    news_summary        TEXT        NOT NULL DEFAULT '',
    tool_trace          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    brain_model         TEXT,
    brain_iterations    INTEGER,
    prompt_hash         TEXT,
    tools_called        JSONB       NOT NULL DEFAULT '[]'::jsonb,
    external_odds_snapshot JSONB    NOT NULL DEFAULT '{}'::jsonb,
    policy_snapshot     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    platform_fee_usdc   NUMERIC     NOT NULL DEFAULT 0,
    notification_status TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_ts     ON agent_decisions (ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_market ON agent_decisions (market);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_user   ON agent_decisions (user_addr, ts DESC);

-- The agent's first-person account of what it did, written by the reflect step
-- and by chat.
CREATE TABLE IF NOT EXISTS agent_journal (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_addr   TEXT        NOT NULL,
    trigger     TEXT        NOT NULL,          -- autonomous | chat | trade | reflect
    kind        TEXT        NOT NULL DEFAULT 'note',
    market      TEXT,
    title       TEXT        NOT NULL DEFAULT '',
    body        TEXT        NOT NULL,
    meta        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    decision_id BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_journal_ts      ON agent_journal (ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_journal_user_ts ON agent_journal (user_addr, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_journal_market  ON agent_journal (market);
