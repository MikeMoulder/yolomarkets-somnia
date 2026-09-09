import sys, os
sys.path.insert(0,"/root/YOLO/yolomarkets/agent")
from dotenv import load_dotenv; load_dotenv("/root/YOLO/yolomarkets/.env")
import bridge_client as b, strategy as S
from desk import FeedCache, strike_for

ms = b.markets(limit=20, min_seconds_left=45)
feeds = FeedCache()
ref = [m["marketId"] for m in ms if not m.get("strike") or str(m["strike"]) in ("0","")]
op = b.opening_prices(ref) if ref else {}
print("assets:", sorted({m.get('asset') for m in ms}))
for a in ("BTC","ETH"):
    print(f"{a}: spot={feeds.spot(a)} vol={feeds.vol(a)}")
print()
for m in ms[:8]:
    a=(m.get("asset") or "").upper()
    k=strike_for(m,feeds,op); s=feeds.spot(a); v=feeds.vol(a)
    bk=b.book(m["yesSymbol"],3)
    p = S.probability_above(s,k,m["secondsLeft"],v) if (s and k and v) else None
    print(f"{m['symbol'][:34]:34} raw_strike={str(m.get('strike'))[:12]:12} K={k} S={s} tte={m['secondsLeft']:4} fair={p} bid={bk.get('bestBid')} ask={bk.get('bestAsk')}")
    print(f"    q: {m['question'][:100]}")
