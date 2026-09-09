"""The YOLO desk — one autonomous pass over live DreamDEX Event Contracts.

    perceive -> price -> decide -> execute -> settle -> journal

Usage:
    uv run python desk.py                 # one pass, dry-run (bridge decides)
    uv run python desk.py --watch         # loop forever
    uv run python desk.py --make          # also rest two-sided quotes
    uv run python desk.py --once --json   # machine-readable single pass

The venue owns the markets and the book, so the loop is small and the edge
comes from pricing rather than from supplying the only liquidity.

Nothing in this file signs anything or computes an on-chain quantity - all of
that lives in the TypeScript bridge (see bridge_client.py).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(REPO_ROOT / ".env")

import bridge_client as bridge  # noqa: E402
import strategy as S  # noqa: E402

try:
    from db import insert_journal
except Exception:  # pragma: no cover - the DB is optional for a dry pass
    insert_journal = None  # type: ignore[assignment]

DESK_ADDR = (os.environ.get("SOMNIA_ADDRESS") or "desk").lower()

# How much of the book to look at, and how many markets to consider per pass.
MAX_MARKETS = int(os.environ.get("AGENT_MAX_MARKETS", "40"))
BOOK_DEPTH = int(os.environ.get("AGENT_BOOK_DEPTH", "5"))
VOL_CANDLES = int(os.environ.get("AGENT_VOL_CANDLES", "60"))
POLL_SECONDS = float(os.environ.get("AGENT_POLL_SECONDS", "30"))

# Cap live orders per pass so a mispriced model cannot empty the wallet in one
# sweep. Deliberately small; the desk runs often.
MAX_ORDERS_PER_PASS = int(os.environ.get("AGENT_MAX_ORDERS_PER_PASS", "3"))


# --------------------------------------------------------------------------

@dataclass
class PassResult:
    started_at: str
    bankroll: float
    gas: float
    considered: int
    priced: int
    signals: list[dict] = field(default_factory=list)
    orders: list[dict] = field(default_factory=list)
    redeemed: list[dict] = field(default_factory=list)
    quotes: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def log(msg: str) -> None:
    print(f"[desk] {msg}", flush=True)


# --------------------------------------------------------------------------
# Perceive
# --------------------------------------------------------------------------

class FeedCache:
    """Spot and volatility per asset, fetched once per pass.

    Every contract on an asset shares the same spot and the same realized vol,
    so fetching per market would be N identical round-trips. Cheap, and it also
    guarantees every market in a pass is priced off ONE consistent snapshot —
    otherwise two contracts on the same asset can disagree about spot.
    """

    def __init__(self) -> None:
        self._spot: dict[str, float | None] = {}
        self._vol: dict[str, float | None] = {}

    def spot(self, asset: str) -> float | None:
        if asset not in self._spot:
            try:
                p = bridge.price(asset)
                self._spot[asset] = p.get("ema") or p.get("price")
            except Exception as e:
                log(f"spot({asset}) failed: {e}")
                self._spot[asset] = None
        return self._spot[asset]

    def vol(self, asset: str) -> float | None:
        if asset not in self._vol:
            try:
                rows = bridge.candles(asset, "1m", VOL_CANDLES)
                # OHLCV rows are [ts, open, high, low, close, volume].
                closes = [float(r[4]) for r in rows if len(r) >= 5]
                self._vol[asset] = S.realized_vol(closes, 60.0)
            except Exception as e:
                log(f"vol({asset}) failed: {e}")
                self._vol[asset] = None
        return self._vol[asset]


def strike_for(market: dict, feeds: FeedCache, openings: dict[str, str | None]) -> float | None:
    """The level this contract settles against, or None if unpriceable.

    Two shapes exist. A "fixed" market carries an explicit strike. A
    "reference" market has strike 0 and settles against its own opening price,
    which the venue posts shortly after the round opens - before that it is
    genuinely unpriceable and we skip it rather than guess.

    Both arrive as integers at a scale the venue does not keep consistent, so
    the decoding is inferred against spot (see strategy.infer_level).
    """
    asset = (market.get("asset") or "").upper()
    spot = feeds.spot(asset) if asset else None
    if not spot:
        return None

    raw = market.get("strike")
    if not raw or str(raw) in ("0", ""):
        raw = openings.get(market["marketId"])
    if not raw:
        return None

    level = S.infer_level(raw, spot)
    if level is None:
        log(f"scale: {market.get('symbol')} level {raw} matches no known scale "
            f"near spot {spot:g} - refusing to price")
    return level


# --------------------------------------------------------------------------
# One pass
# --------------------------------------------------------------------------

def run_pass(*, make_markets: bool = False,
             paper_bankroll: float | None = None) -> PassResult:
    status = bridge.status()
    bankroll = float(status.get("collateral") or 0)
    gas = float(status.get("gas") or 0)

    # A zero bankroll makes Kelly return zero for everything, which hides
    # whether the model is finding edges at all. `--paper-bankroll` prices the
    # pass as if we were funded so the decision logic stays observable while
    # the wallet is empty. It cannot cause a trade: with no gas the order loop
    # skips, and the bridge is in dry-run besides.
    if paper_bankroll is not None:
        bankroll = paper_bankroll

    result = PassResult(
        started_at=datetime.now(timezone.utc).isoformat(),
        bankroll=bankroll,
        gas=gas,
        considered=0,
        priced=0,
    )

    if gas <= 0:
        result.notes.append(
            "no STT — the desk can read and reason but cannot place orders")

    # ---- settle first: free up collateral before spending it ---------------
    result.redeemed = claim_settled()

    # What we already hold, keyed by marketId. The position cap is enforced on
    # TOTAL exposure, so a standing edge cannot be re-bought every pass.
    exposure = current_exposure()
    if exposure is None:
        result.notes.append(
            "portfolio unreadable - no new entries this pass (the position cap "
            "cannot be enforced without it)")

    markets = bridge.markets(limit=MAX_MARKETS,
                             min_seconds_left=S.MIN_SECONDS_TO_EXPIRY)
    result.considered = len(markets)
    if not markets:
        result.notes.append("no live markets in range")
        return result

    feeds = FeedCache()

    # Reference markets need their opening tick; batch the lookup.
    ref_ids = [m["marketId"] for m in markets
               if not m.get("strike") or str(m["strike"]) in ("0", "")]
    openings: dict[str, str | None] = {}
    if ref_ids:
        try:
            openings = bridge.opening_prices(ref_ids)
        except Exception as e:
            log(f"opening prices failed: {e}")

    signals: list[S.Signal] = []
    for m in markets:
        asset = (m.get("asset") or "").upper()
        strike = strike_for(m, feeds, openings) if asset else None
        spot = feeds.spot(asset) if asset else None
        vol = feeds.vol(asset) if asset else None

        try:
            b = bridge.book(m["yesSymbol"], BOOK_DEPTH)
        except Exception as e:
            log(f"book({m['symbol']}) failed: {e}")
            continue

        sig = S.evaluate(
            symbol=m["symbol"],
            question=m["question"],
            seconds_left=float(m["secondsLeft"]),
            best_bid=b.get("bestBid"),
            best_ask=b.get("bestAsk"),
            bankroll=bankroll,
            spot=spot,
            strike=strike,
            annual_vol=vol,
            existing_exposure=(exposure.get(m["marketId"], 0.0)
                               if exposure is not None else float("inf")),
        )
        if sig.fair is not None:
            result.priced += 1
        signals.append(sig)
        result.signals.append(signal_row(sig, m))

    # ---- act ---------------------------------------------------------------
    # Best edge first: if the per-pass cap binds, spend it on the strongest
    # signals rather than on whichever market the indexer happened to list.
    actionable = sorted([s for s in signals if s.traded],
                        key=lambda s: s.edge, reverse=True)

    for sig in actionable[:MAX_ORDERS_PER_PASS]:
        if gas <= 0:
            result.notes.append(f"skipped {sig.symbol}: no gas")
            continue
        side = "YES" if sig.action == "buy_yes" else "NO"
        try:
            res = bridge.place_order(
                symbol=sig.symbol, side=side,
                price=sig.price or 0.0, size=sig.size_contracts,
                order_type="limit",
            )
            res["reason"] = sig.reason
            res["edge"] = sig.edge
            result.orders.append(res)
            log(f"{side} {sig.symbol} — {sig.reason}"
                + ("  [DRY]" if res.get("dryRun") else f"  tx {res.get('txHash')}"))
            journal(kind="trade", market=sig.symbol,
                    title=f"Bought {side} on {sig.symbol}",
                    body=sig.reason, meta={"order": res, "inputs": sig.inputs})
        except Exception as e:
            log(f"order failed for {sig.symbol}: {e}")
            result.notes.append(f"order failed {sig.symbol}: {e}")

    # ---- make markets ------------------------------------------------------
    if make_markets and gas > 0:
        result.quotes = rest_quotes(signals, bankroll)

    summarize(result)
    return result


def signal_row(sig: S.Signal, market: dict) -> dict:
    return {
        "symbol": sig.symbol,
        "question": sig.question,
        "action": sig.action,
        "tier": sig.tier,
        "fair": sig.fair,
        "book_mid": sig.book_mid,
        "price": sig.price,
        "edge": round(sig.edge, 4),
        "stake": round(sig.stake, 4),
        "size": round(sig.size_contracts, 4),
        "reason": sig.reason,
        "secondsLeft": market.get("secondsLeft"),
        "interval": market.get("interval"),
    }


def rest_quotes(signals: list[S.Signal], bankroll: float) -> list[dict]:
    """Post-only quotes on the widest books we have a fair value for.

    This is the ecosystem answer rather than the alpha one: DreamDEX's books
    are thin, and a desk that only takes when the book is wrong never fixes
    that. Quotes go on the WIDEST books because that is where the spread pays
    and where a resting order helps a human trader most.
    """
    out: list[dict] = []
    quotable = [s for s in signals
                if s.fair is not None and s.book_mid is not None]
    quotable.sort(key=lambda s: abs((s.price or 0) - (s.book_mid or 0)), reverse=True)

    for sig in quotable[:2]:
        for q in S.make_quotes(fair=sig.fair or 0.5, bankroll=bankroll):
            try:
                res = bridge.place_order(
                    symbol=sig.symbol, side=q.side, price=q.price,
                    size=q.size, order_type="limit", post_only=True,
                )
                res["quote"] = {"side": q.side, "price": q.price, "size": q.size}
                out.append(res)
                log(f"quote {q.side} {q.price} x{q.size} on {sig.symbol}"
                    + ("  [DRY]" if res.get("dryRun") else ""))
            except Exception as e:
                log(f"quote failed on {sig.symbol}: {e}")
    return out


def current_exposure() -> dict[str, float] | None:
    """Marked value of open positions, keyed by marketId. None if unreadable.

    Both sides of a market count toward the same cap: holding YES and NO in one
    contract is still capital committed to it, and netting them here would let
    the cap be walked around by alternating sides.

    Returning None rather than an empty dict matters. An empty dict reads as
    "no exposure anywhere", which would silently disable the position cap at
    exactly the moment we cannot verify it - so the caller opens nothing on a
    pass where this fails.
    """
    try:
        p = bridge.portfolio()
    except Exception as e:
        log(f"exposure read failed: {e}")
        return None

    out: dict[str, float] = {}
    for pos in p.get("open", []):
        mid = pos.get("marketId")
        if not mid:
            continue
        out[mid] = out.get(mid, 0.0) + float(pos.get("value") or 0.0)
    return out


def claim_settled() -> list[dict]:
    """Redeem winning outcome tokens 1:1 for collateral.

    Settlement is a pull on DreamDEX — a won position sits as an unclaimed
    balance until someone redeems it. Doing this FIRST in a pass means the
    collateral is available to trade with in the same pass.
    """
    out: list[dict] = []
    try:
        p = bridge.portfolio()
    except Exception as e:
        log(f"portfolio read failed: {e}")
        return out

    for pos in p.get("settled", []):
        claimable = pos.get("claimable") or 0
        if claimable <= 0:
            continue
        try:
            res = bridge.redeem(market_id=pos["marketId"],
                                outcome_idx=pos["outcomeIndex"],
                                amount=pos["contracts"])
            res["question"] = pos.get("question")
            res["amount"] = claimable
            out.append(res)
            log(f"redeemed {claimable:.3f} on {pos.get('question', '')[:60]}"
                + ("  [DRY]" if res.get("dryRun") else ""))
        except Exception as e:
            log(f"redeem failed for {pos.get('marketId')}: {e}")
    return out


def journal(*, kind: str, body: str, title: str = "",
            market: str | None = None, meta: dict | None = None) -> None:
    """Best-effort narrative write. The journal is never load-bearing."""
    if insert_journal is None:
        return
    try:
        insert_journal(user_addr=DESK_ADDR, trigger="autonomous", kind=kind,
                       market=market, title=title, body=body, meta=meta or {})
    except Exception:
        pass


def summarize(r: PassResult) -> None:
    traded = len(r.orders)
    passed = sum(1 for s in r.signals if s["action"] == "pass")
    line = (f"{r.considered} markets · {r.priced} priced · {traded} orders · "
            f"{passed} passes · {len(r.redeemed)} redeemed · "
            f"bankroll {r.bankroll:.2f} tUSDC")
    log(line)
    for note in r.notes:
        log(f"note: {note}")
    if traded or r.redeemed:
        journal(kind="reflection", title="Pass summary", body=line,
                meta={"orders": r.orders, "redeemed": r.redeemed})


# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="YOLO desk — DreamDEX Event Contracts")
    ap.add_argument("--watch", action="store_true", help="loop forever")
    ap.add_argument("--make", action="store_true", help="also rest two-sided quotes")
    ap.add_argument("--json", action="store_true", help="print the pass as JSON")
    ap.add_argument("--interval", type=float, default=POLL_SECONDS)
    ap.add_argument("--paper-bankroll", type=float, default=None,
                    help="price the pass against this bankroll instead of the "
                         "wallet's (observability while unfunded; never trades)")
    args = ap.parse_args()

    try:
        h = bridge.health()
    except Exception as e:
        print(f"bridge is not reachable: {e}", file=sys.stderr)
        print("start it with:  cd web && npm run bridge", file=sys.stderr)
        return 1

    log(f"bridge ok — chain {h.get('chain')} · "
        f"{'DRY-RUN' if h.get('dryRun') else 'LIVE'} · {h.get('address')}")

    while True:
        try:
            res = run_pass(make_markets=args.make,
                           paper_bankroll=args.paper_bankroll)
            if args.json:
                print(json.dumps(asdict(res), indent=1, default=str))
        except Exception as e:
            log(f"pass failed: {e}")
        if not args.watch:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
