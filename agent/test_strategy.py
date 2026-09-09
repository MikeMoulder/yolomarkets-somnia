import math, sys
sys.path.insert(0, "/root/YOLO/yolomarkets/agent")
import strategy as S

fails = []
def check(ok, label, detail=""):
    if not ok: fails.append(label)
    print(f"{'  ok ' if ok else 'FAIL'} {label}{' — ' + detail if detail else ''}")

# --- probability_above -----------------------------------------------------
p_atm = S.probability_above(2494.0, 2494.0, 60, 0.6)
check(0.45 < p_atm < 0.5, "at-the-money ~0.5 (slightly under, -sigma^2/2 drag)", f"{p_atm:.4f}")

p_itm = S.probability_above(2500.0, 2494.0, 60, 0.6)
p_otm = S.probability_above(2488.0, 2494.0, 60, 0.6)
check(p_itm > p_atm > p_otm, "monotone in spot", f"{p_otm:.3f} < {p_atm:.3f} < {p_itm:.3f}")

# Deep ITM with little time left -> near certainty
p_deep = S.probability_above(2600.0, 2494.0, 30, 0.6)
check(p_deep > 0.99, "deep ITM near expiry -> ~1", f"{p_deep:.5f}")

# More time = more uncertainty = closer to 0.5 for an ITM strike
p_short = S.probability_above(2500.0, 2494.0, 60, 0.6)
p_long  = S.probability_above(2500.0, 2494.0, 3600, 0.6)
check(abs(p_long - 0.5) < abs(p_short - 0.5), "longer horizon pulls toward 0.5",
      f"60s={p_short:.3f} 1h={p_long:.3f}")

check(S.probability_above(0, 100, 60, 0.6) is None, "rejects zero spot")
check(S.probability_above(100, 100, 0, 0.6) is None, "rejects zero time")

# --- realized_vol ----------------------------------------------------------
check(S.realized_vol([100.0]*3, 60) is None, "too few points -> None")
check(S.realized_vol([100.0]*20, 60) is None, "flat series -> None (never zero vol)")

import random
random.seed(7)
sigma_bar = 0.0008           # per-minute log-return sd
closes, px = [100.0], 100.0
for _ in range(400):
    px *= math.exp(random.gauss(0, sigma_bar)); closes.append(px)
v = S.realized_vol(closes, 60)
expected = sigma_bar * math.sqrt(S.SECONDS_PER_YEAR / 60)
check(v is not None and abs(v - expected) / expected < 0.15,
      "recovers known vol from synthetic GBM", f"got {v:.3f} vs {expected:.3f}")

# Constant-growth series has ZERO return variance, so build one with large
# *varying* returns to actually exercise the ceiling.
random.seed(11)
wild, px2 = [100.0], 100.0
for _ in range(50):
    px2 *= math.exp(random.gauss(0, 0.05)); wild.append(px2)
check(S.realized_vol(wild, 60) == S.MAX_ANNUAL_VOL, "clamps to MAX_ANNUAL_VOL",
      str(S.realized_vol(wild, 60)))
calm, px3 = [100.0], 100.0
for _ in range(50):
    px3 *= math.exp(random.gauss(0, 1e-7)); calm.append(px3)
check(S.realized_vol(calm, 60) == S.MIN_ANNUAL_VOL, "clamps to MIN_ANNUAL_VOL",
      str(S.realized_vol(calm, 60)))

# --- kelly ------------------------------------------------------------------
check(S.kelly_size(0.5, 0.5, 1000) == 0.0, "no edge -> no stake")
check(S.kelly_size(0.3, 0.5, 1000) == 0.0, "negative edge -> no stake")
k = S.kelly_size(0.60, 0.50, 1000)
# full kelly at p=.6, b=1 is 0.2 -> quarter kelly 0.05 -> 50
check(abs(k - 50.0) < 0.01, "quarter-Kelly matches closed form", f"{k}")
cap = S.kelly_size(0.99, 0.10, 1000)
check(cap == 1000 * S.MAX_POSITION_FRACTION, "position cap binds", f"{cap}")

# --- evaluate ---------------------------------------------------------------
# Book is badly mispriced low vs a near-certain model probability -> buy YES
sig = S.evaluate(symbol="ETH-X/tUSDC", question="q", seconds_left=120,
                 best_bid=0.30, best_ask=0.35, bankroll=1000,
                 spot=2600.0, strike=2494.0, annual_vol=0.6)
check(sig.action == "buy_yes", "takes YES when book underprices", sig.reason)
check(sig.tier == "model", "uses the model tier when a feed exists")
check(abs(sig.stake - sig.size_contracts * sig.price) < 1e-6, "size = stake / price")

# Mirror: model says very unlikely, book says likely -> buy NO
sig2 = S.evaluate(symbol="ETH-X/tUSDC", question="q", seconds_left=120,
                  best_bid=0.70, best_ask=0.75, bankroll=1000,
                  spot=2380.0, strike=2494.0, annual_vol=0.6)
check(sig2.action == "buy_no", "takes NO when book overprices", sig2.reason)

# Fair sits inside a tight book -> pass
sig3 = S.evaluate(symbol="ETH-X/tUSDC", question="q", seconds_left=120,
                  best_bid=0.47, best_ask=0.49, bankroll=1000,
                  spot=2494.0, strike=2494.0, annual_vol=0.6)
check(sig3.action == "pass", "passes a fairly priced book", sig3.reason)

# Edge measured against the ask, not the mid: a wide book must not fake an edge
sig4 = S.evaluate(symbol="ETH-X/tUSDC", question="q", seconds_left=120,
                  best_bid=0.30, best_ask=0.62, bankroll=1000,
                  spot=2494.0, strike=2494.0, annual_vol=0.6)
check(sig4.action == "pass", "wide book: mid looks cheap, ask does not", sig4.reason)

check(S.evaluate(symbol="s", question="q", seconds_left=10, best_bid=0.1,
                 best_ask=0.2, bankroll=1000, spot=1, strike=1,
                 annual_vol=0.6).action == "pass", "refuses near-expiry")
check(S.evaluate(symbol="s", question="q", seconds_left=300, best_bid=None,
                 best_ask=None, bankroll=1000, spot=1, strike=1,
                 annual_vol=0.6).action == "pass", "refuses empty book")
n = S.evaluate(symbol="s", question="q", seconds_left=300, best_bid=0.4,
               best_ask=0.45, bankroll=1000, consensus=0.9)
check(n.tier == "narrative" and n.action == "buy_yes", "falls back to narrative tier", n.reason)

# --- quotes -----------------------------------------------------------------
qs = S.make_quotes(fair=0.5, bankroll=1000)
check(len(qs) == 2, "quotes both sides")
check(all(0 < q.price < 1 for q in qs), "quote prices are probabilities")
check(abs((qs[0].price + qs[1].price) - (1 - 2*0.02)) < 1e-9,
      "YES+NO quotes sum to 1 minus the full spread", f"{qs[0].price}+{qs[1].price}")
skewed = S.make_quotes(fair=0.5, bankroll=1000, inventory_skew=1.0)
check(skewed[0].price < qs[0].price, "long inventory shades the YES bid down")



# --- position cap across passes ---------------------------------------------
# The bug this guards: MAX_POSITION_FRACTION capped a single ORDER, not total
# exposure, so a desk running every 45s re-bought the same standing edge on
# every pass. Observed live at 2,913 contracts in one market.
print()
cap = 1000 * S.MAX_POSITION_FRACTION
check(abs(S.kelly_size(0.60, 0.50, 1000, existing_exposure=0) - 50.0) < 1e-9,
      "no existing exposure -> normal quarter-Kelly stake")
check(S.kelly_size(0.99, 0.10, 1000, existing_exposure=0) == cap,
      "per-order cap still binds", str(cap))
check(S.kelly_size(0.99, 0.10, 1000, existing_exposure=cap) == 0.0,
      "at the cap -> refuses to add")
check(S.kelly_size(0.99, 0.10, 1000, existing_exposure=cap * 2) == 0.0,
      "over the cap -> refuses to add")
half = S.kelly_size(0.99, 0.10, 1000, existing_exposure=cap / 2)
check(abs(half - cap / 2) < 1e-9, "half exposed -> only the headroom is offered",
      f"{half} vs headroom {cap/2}")
check(S.kelly_size(0.99, 0.10, 1000, existing_exposure=float("inf")) == 0.0,
      "unknown exposure (inf) -> refuses to open")

capped = S.evaluate(symbol="s", question="q", seconds_left=300, best_bid=0.30,
                    best_ask=0.35, bankroll=1000, spot=2600.0, strike=2494.0,
                    annual_vol=0.6, existing_exposure=cap)
check(capped.action == "pass" and "cap" in capped.reason,
      "evaluate passes on a capped market and says why", capped.reason)

blind = S.evaluate(symbol="s", question="q", seconds_left=300, best_bid=0.30,
                   best_ask=0.35, bankroll=1000, spot=2600.0, strike=2494.0,
                   annual_vol=0.6, existing_exposure=float("inf"))
check(blind.action == "pass", "evaluate refuses to open when exposure is unknown")


# --- volatility sampling must match the horizon -----------------------------
# The bug this guards: volatility was estimated from 60 one-minute candles (a
# one-hour window) and used to price contracts up to 45 days out. Intraday
# variance sits far below multi-day variance, so the estimate came out low, d2
# came out large, and a coin flip priced as a 0.41 edge. The desk went 0 for 3
# on settled positions before this was found.
print()
for tte in (60, 300, 900, 3600):
    r = S.vol_sampling(tte)
    check(r is not None and r[0] == 60, f"{tte}s horizon samples 1m bars", str(r))
check(S.vol_sampling(14400)[0] == 3600, "4h horizon steps up to 1h bars")
check(S.vol_sampling(86400)[0] == 3600, "24h horizon uses 1h bars")
check(S.vol_sampling(45 * 86400)[0] == 86400, "45d horizon steps up to 1d bars")
check(S.vol_sampling(10 * 365 * 86400) is None, "absurd horizon is out of reach")

for tte in (60, 3600, 14400, 86400):
    bar, bars, _ = S.vol_sampling(tte)
    check(bar * bars >= S.MIN_WINDOW_TO_HORIZON * tte,
          f"{tte}s: sampled window covers the horizon",
          f"{bar * bars}s vs {S.MIN_WINDOW_TO_HORIZON * tte}s")
    check(bars <= S.MAX_VOL_BARS, f"{tte}s: bar count fits one request", str(bars))
    check(bars >= S.MIN_VOL_BARS, f"{tte}s: enough bars to estimate", str(bars))

# The request is not the guarantee: a young venue returns fewer bars than asked.
check(not S.vol_window_ok(86400, 51, 45 * 86400),
      "51 daily bars do NOT cover a 45-day horizon (the live case)")
check(S.vol_window_ok(60, 120, 3600), "120 one-minute bars cover a 1h horizon")

print()
print(f"{len(fails)} failed" if fails else "all strategy checks passed")
sys.exit(1 if fails else 0)
