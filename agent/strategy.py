"""Fair value and sizing for DreamDEX Event Contracts.

WHY THIS IS NOT THE PLAN'S STRATEGY. The original plan priced every contract as
a blend of Polymarket consensus and news sentiment. That is the right model for
*editorial* markets ("will the Fed cut in March"), and it is the wrong model
here: DreamDEX's live corpus is almost entirely price-feed contracts —

    "will ETH/USDC's price be at or above 2495.95 at unix time 1788974580?"

— settling in 1 to 15 minutes off an oracle whose current value we can simply
read. For those, fair value is not a matter of opinion. Spot, strike and time
to expiry determine it, and the only estimated input is volatility, which we
measure from the same feed that will settle the contract.

So the engine is a two-tier thing:

  * PRICEABLE markets (a strike and a live feed)  -> analytic, Tier "model".
  * EVERYTHING ELSE (no feed, editorial wording)  -> the LLM/consensus blend
    from the original plan, Tier "narrative".

The analytic tier is the one that trades: it is defensible, it is fast enough
for a 60-second contract, and it does not burn an LLM call per market.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from typing import Literal, Sequence

# --------------------------------------------------------------------------
# Tunables
# --------------------------------------------------------------------------

# Minimum edge (in probability points, 0-1) before we act. The venue books are
# wide — 3 to 5 points is common — so this is not a small threshold in practice.
EDGE_THRESHOLD = float(os.environ.get("AGENT_EDGE_THRESHOLD", "0.04"))

# Fraction of full Kelly. Quarter-Kelly is the standard conservatism factor:
# full Kelly maximises log growth but has brutal drawdowns, and our probability
# estimate has real error in it.
KELLY_FRACTION = float(os.environ.get("AGENT_KELLY_FRACTION", "0.25"))

# Never put more than this share of the bankroll into one contract, whatever
# Kelly says. Binaries can gap to zero.
MAX_POSITION_FRACTION = float(os.environ.get("AGENT_MAX_POSITION_FRACTION", "0.10"))

# Below this many seconds to expiry we stop opening: the order might not fill
# before settlement, and vol estimates degrade at very short horizons.
MIN_SECONDS_TO_EXPIRY = int(os.environ.get("AGENT_MIN_TTE_SECONDS", "45"))

# Volatility floor/ceiling as annualised decimals. Guards against a flat feed
# (which would make every contract look like a certainty) and against a single
# bad tick blowing the estimate up.
MIN_ANNUAL_VOL = float(os.environ.get("AGENT_MIN_ANNUAL_VOL", "0.20"))
MAX_ANNUAL_VOL = float(os.environ.get("AGENT_MAX_ANNUAL_VOL", "3.00"))

SECONDS_PER_YEAR = 365.0 * 24 * 3600

Action = Literal["buy_yes", "buy_no", "pass"]
Tier = Literal["model", "narrative"]


# --------------------------------------------------------------------------
# Math
# --------------------------------------------------------------------------

def _norm_cdf(x: float) -> float:
    """Standard normal CDF via erf — no scipy dependency for one function."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def realized_vol(closes: Sequence[float], seconds_per_bar: float) -> float | None:
    """Annualised volatility from a series of closes.

    Uses log returns and the usual sqrt-of-time scaling. Returns None when
    there is not enough data to say anything — a caller must treat that as
    "cannot price", never as "zero volatility", because a zero-vol binary
    prices as a 0/1 certainty and would size maximally into noise.
    """
    if len(closes) < 5:
        return None

    rets: list[float] = []
    for prev, cur in zip(closes, closes[1:]):
        if prev > 0 and cur > 0:
            rets.append(math.log(cur / prev))
    if len(rets) < 4:
        return None

    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    sigma_per_bar = math.sqrt(var)
    if sigma_per_bar <= 0:
        return None

    bars_per_year = SECONDS_PER_YEAR / seconds_per_bar
    annual = sigma_per_bar * math.sqrt(bars_per_year)
    return max(MIN_ANNUAL_VOL, min(MAX_ANNUAL_VOL, annual))


def probability_above(spot: float, strike: float, seconds_left: float,
                      annual_vol: float) -> float | None:
    """P(S_T >= K) under driftless geometric Brownian motion.

    Driftless is deliberate. Over a 60-second horizon any realistic drift is
    swamped by volatility, and estimating it from 60 minutes of testnet ticks
    would add far more error than it removes.
    """
    if spot <= 0 or strike <= 0 or seconds_left <= 0 or annual_vol <= 0:
        return None

    tau = seconds_left / SECONDS_PER_YEAR
    sigma_sqrt_tau = annual_vol * math.sqrt(tau)
    if sigma_sqrt_tau <= 0:
        return None

    # d2 of Black-Scholes with zero rate: the risk-neutral probability of
    # finishing in the money.
    d2 = (math.log(spot / strike) - 0.5 * sigma_sqrt_tau ** 2) / sigma_sqrt_tau
    return _norm_cdf(d2)


def blend_narrative(consensus: float | None, sentiment: float | None) -> float | None:
    """The original plan's model, kept for markets with no price feed.

    80% cross-venue consensus, 20% news sentiment mapped from [-1,1] to [0,1].
    """
    if consensus is None and sentiment is None:
        return None
    if consensus is None:
        return max(0.01, min(0.99, 0.5 + 0.5 * (sentiment or 0.0)))
    if sentiment is None:
        return max(0.01, min(0.99, consensus))
    fair = 0.80 * consensus + 0.20 * (0.5 + 0.5 * sentiment)
    return max(0.01, min(0.99, fair))


def kelly_size(p_win: float, price: float, bankroll: float) -> float:
    """Fractional-Kelly stake in collateral units.

    On a binary bought at `price`, a winning contract returns 1, so the net
    odds are b = (1 - price) / price and the Kelly fraction is (p*b - q)/b.
    """
    if not (0.0 < price < 1.0) or bankroll <= 0:
        return 0.0

    b = (1.0 - price) / price
    q = 1.0 - p_win
    f = (p_win * b - q) / b
    if f <= 0:
        return 0.0

    stake = bankroll * f * KELLY_FRACTION
    return max(0.0, min(stake, bankroll * MAX_POSITION_FRACTION))


# --------------------------------------------------------------------------
# Decision
# --------------------------------------------------------------------------

@dataclass
class Signal:
    action: Action
    symbol: str
    question: str
    tier: Tier
    fair: float | None
    book_mid: float | None
    # The price this side would actually pay, off the live book.
    price: float | None
    edge: float
    size_contracts: float
    stake: float
    reason: str
    inputs: dict = field(default_factory=dict)

    @property
    def traded(self) -> bool:
        return self.action != "pass"


def evaluate(
    *,
    symbol: str,
    question: str,
    seconds_left: float,
    best_bid: float | None,
    best_ask: float | None,
    bankroll: float,
    spot: float | None = None,
    strike: float | None = None,
    annual_vol: float | None = None,
    consensus: float | None = None,
    sentiment: float | None = None,
) -> Signal:
    """Price one contract and decide.

    `best_bid`/`best_ask` are the YES side of the book. Buying NO means lifting
    the mirror of the YES bid, because Up and Down share one book and a NO ask
    is 1 minus a YES bid.
    """
    inputs = {
        "seconds_left": seconds_left,
        "best_bid": best_bid,
        "best_ask": best_ask,
        "spot": spot,
        "strike": strike,
        "annual_vol": annual_vol,
        "consensus": consensus,
        "sentiment": sentiment,
    }

    def nope(reason: str, tier: Tier = "model", fair: float | None = None) -> Signal:
        mid = (best_bid + best_ask) / 2 if best_bid is not None and best_ask is not None else None
        return Signal("pass", symbol, question, tier, fair, mid, None, 0.0, 0.0, 0.0,
                      reason, inputs)

    if seconds_left < MIN_SECONDS_TO_EXPIRY:
        return nope(f"only {seconds_left:.0f}s to expiry (floor {MIN_SECONDS_TO_EXPIRY}s)")

    # ---- fair value ------------------------------------------------------
    tier: Tier = "model"
    if spot is not None and strike is not None and strike > 0 and annual_vol:
        fair = probability_above(spot, strike, seconds_left, annual_vol)
        if fair is None:
            return nope("model inputs present but degenerate")
    else:
        tier = "narrative"
        fair = blend_narrative(consensus, sentiment)
        if fair is None:
            return nope("no price feed and no consensus — cannot price", tier)

    # ---- edge against the live book --------------------------------------
    if best_bid is None and best_ask is None:
        return nope("empty book — nothing to trade against", tier, fair)

    mid = (best_bid + best_ask) / 2 if best_bid is not None and best_ask is not None else None

    # Compare against the price we would PAY, not the mid. Paying the ask and
    # measuring edge from the mid is how a backtest prints profit that a live
    # book never pays out.
    yes_cost = best_ask
    no_cost = None if best_bid is None else 1.0 - best_bid

    yes_edge = (fair - yes_cost) if yes_cost is not None else -1.0
    no_edge = ((1.0 - fair) - no_cost) if no_cost is not None else -1.0

    if yes_edge >= no_edge and yes_edge > EDGE_THRESHOLD and yes_cost is not None:
        stake = kelly_size(fair, yes_cost, bankroll)
        if stake <= 0:
            return nope("edge present but Kelly says zero", tier, fair)
        return Signal(
            "buy_yes", symbol, question, tier, fair, mid, yes_cost, yes_edge,
            stake / yes_cost, stake,
            f"fair {fair:.3f} vs ask {yes_cost:.3f} — {yes_edge * 100:.1f}pt edge on YES "
            f"({'model' if tier == 'model' else 'narrative'})",
            inputs,
        )

    if no_edge > EDGE_THRESHOLD and no_cost is not None:
        stake = kelly_size(1.0 - fair, no_cost, bankroll)
        if stake <= 0:
            return nope("edge present but Kelly says zero", tier, fair)
        return Signal(
            "buy_no", symbol, question, tier, fair, mid, no_cost, no_edge,
            stake / no_cost, stake,
            f"fair {fair:.3f} vs NO ask {no_cost:.3f} — {no_edge * 100:.1f}pt edge on NO "
            f"({'model' if tier == 'model' else 'narrative'})",
            inputs,
        )

    best = max(yes_edge, no_edge)
    return nope(f"no edge — best {best * 100:.1f}pts vs {EDGE_THRESHOLD * 100:.1f}pt threshold",
                tier, fair)


# --------------------------------------------------------------------------
# Market making
# --------------------------------------------------------------------------

@dataclass
class Quote:
    side: Literal["YES", "NO"]
    price: float
    size: float


def make_quotes(
    *,
    fair: float,
    bankroll: float,
    half_spread: float = 0.02,
    size_fraction: float = 0.02,
    inventory_skew: float = 0.0,
) -> list[Quote]:
    """Two-sided post-only quotes around fair value.

    This is the liquidity answer to DreamDEX's cold-start problem: rather than
    only taking when the book is wrong, the desk rests bids on both sides and
    earns the spread. `inventory_skew` in [-1, 1] shades quotes away from the
    side we are already long, so the book does not fill us into a one-way book.
    """
    centre = min(0.95, max(0.05, fair - inventory_skew * half_spread))
    yes_px = round(max(0.01, centre - half_spread), 3)
    no_px = round(max(0.01, (1.0 - centre) - half_spread), 3)

    stake = bankroll * size_fraction
    quotes: list[Quote] = []
    if yes_px > 0:
        quotes.append(Quote("YES", yes_px, round(stake / yes_px, 3)))
    if no_px > 0:
        quotes.append(Quote("NO", no_px, round(stake / no_px, 3)))
    return quotes
