# YOLO Markets

**An autonomous trading desk for [DreamDEX](https://docs.dreamdex.io/developers/event-contracts) Event Contracts on Somnia.**

Built for the Somnia × DreamDEX Event Contracts Hackathon.

---

## The problem

Open DreamDEX right now and you will find something like this:

```
ETH ≥ $2,495.95   ·   expires in 47 seconds
best bid 0.008          best ask 0.057
```

A **4.9-point spread** on a contract that settles in under a minute.

DreamDEX's live corpus is almost entirely **sub-hour, price-feed-settled
binaries** rolling on a 1m/5m/15m/1h cadence. That is a market structure no
human can trade: by the time you have read the question, checked the price of
ETH, worked out what 0.057 implies, and clicked, the contract has settled. So
the books stay thin, the spreads stay wide, and the odds lag the feed the
contract will actually settle on.

This is not a liquidity-mining problem. It is a **latency-of-judgement**
problem - and that is what an agent is for.

## The solution

YOLO Markets is a desk that trades these contracts the way a market maker
would, and explains itself the way a person would.

1. **It prices analytically, not by vibes.** Every one of these contracts
   settles on an oracle price feed *whose current value we can read*. So fair
   value is not a matter of opinion - spot, strike and time to expiry determine
   it. The only estimated input is volatility, and we measure that from the very
   same feed that will settle the contract.
2. **It takes the book when the book is wrong**, sized by quarter-Kelly against
   the price it would actually pay.
3. **It quotes both sides when the book is thin**, resting post-only orders to
   supply the liquidity the venue lacks.
4. **It redeems on settlement**, because payout on DreamDEX is a pull.
5. **It narrates all of it** - every decision, taken or passed, with the numbers
   that drove it.

And for humans there is a terminal where the only thing you have to decide is
**how much you are willing to lose**.

---

## What is actually built

| | |
| --- | --- |
| **Catalog** | Live Event Contracts with cadence badges and countdowns |
| **Market view** | Resting order book streamed from chain logs - no polling anywhere |
| **Trade ticket** | Sized in **max loss**; size, payout and return are derived |
| **Portfolio** | Positions, marks and one-click redemption of settled winners |
| **The desk** | Autonomous pricing, taking, quoting, settling - with a journal |
| **Copilot chat** | Ask the agent anything; it proposes orders you sign yourself |

### The Max Loss ticket

Every other prediction-market UI asks "how many shares?" - a question retail
users cannot answer, because shares only mean something after you have done the
payout arithmetic.

On a binary at price `p`, buying `q` contracts costs `q·p` and returns either
`q` or zero. So **max loss *is* the cost**, and size falls out as `risk / p`.
Inverting the order form makes the downside literally un-exceedable rather than
a warning in small print - and the bridge rounds size *down* to the venue lot,
so a "$5 max loss" order can never spend $5.01.

---

## Verified on-chain

Every claim below is a transaction on Somnia Shannon, not a screenshot.

| What | Transaction |
| --- | --- |
| Collateral minted from the venue faucet | [`0x6dab7cea`](https://shannon-explorer.somnia.network/tx/0x6dab7cea47b93dd56dfbf00e19a5e5c2debe1c9b95c9bbe0dde0372821e87092) |
| Manual order, filled in full | [`0xcf3bb528`](https://shannon-explorer.somnia.network/tx/0xcf3bb52843a076ca641868fedfe963ce4ffee08f41b2aaf72252d347f31646ee) |
| **Agent trade** - NO at an 8.6pt edge | [`0xa35eb82f`](https://shannon-explorer.somnia.network/tx/0xa35eb82ffc4fd8726489c202f92b870ee2e72b5a3fc19ac2e04c10fa2868d63b) |
| **Agent trade** - YES at a 4.7pt edge | [`0x179bf5ad`](https://shannon-explorer.somnia.network/tx/0x179bf5adca364ee3c41f9e295724f4eca301a832c965c49d45221d162c0ba8a4) |
| **Agent redemption** - 259.303 tUSDC | [`0x4fc0cdf5`](https://shannon-explorer.somnia.network/tx/0x4fc0cdf54467e24aa630b8a22be4735d77f74e3e3d0e60f0d55e320716cf1bea) |
| **Agent redemption** - 43.750 tUSDC | [`0xbe5d8d57`](https://shannon-explorer.somnia.network/tx/0xbe5d8d579dfb20194ce1105532dd094124a467a35af964131915a2dfa0b0a371) |

Desk wallet: [`0xa92F9706146542d30a6E3b8C48eB996fF3D9175e`](https://shannon-explorer.somnia.network/address/0xa92F9706146542d30a6E3b8C48eB996fF3D9175e)

The two agent trades were chosen, priced and sized by the desk with no human in
the loop. Its own log for them:

```
NO  BTC-0-19OCT26/tUSDC        fair 0.409 vs NO ask 0.505 - 8.6pt edge on NO (model)
YES ETH-248116-09SEP26-1905    fair 0.574 vs ask 0.527    - 4.7pt edge on YES (model)
14 markets - 14 priced - 2 orders - 12 passes
```

The second one lost. ETH needed to close at or above 2481.16 and did not, so
the position settled worthless and the portfolio marks it as such. A 57% call
losing is not a bug, and the desk is built to report that rather than hide it.

The two redemptions close the loop. Payout on DreamDEX is a pull: a winning
position sits as an unclaimed balance until someone redeems it, so the desk
settles first on every pass, before it looks for anything new to buy. Those two
calls returned 303.053 tUSDC and the wallet balance moved 4,182.24 -> 4,485.30,
which is the same number.

That is the full lifecycle on chain, with no human in it: fund, price, order,
fill, settle, redeem.

---

## Architecture

```
┌──────────────────────────┐        ┌───────────────────────────┐
│  Next.js 16 terminal     │        │  agent/ (Python)          │
│                          │        │                           │
│  markets-sdk/react hooks │        │  desk.py     the loop     │
│  · useLiveBinaryOrderBook│        │  strategy.py fair value   │
│    (live book, no poll)  │        │              + Kelly      │
│  wagmi - the USER signs  │        │  no keys, no quantities   │
└───────────┬──────────────┘        └──────────────┬────────────┘
            │                                      │ HTTP (localhost)
            │                        ┌─────────────▼─────────────┐
            │                        │ scripts/bot-bridge.ts     │
            │                        │ THE DESK'S WALLET         │
            │                        │ quantize · sign · submit  │
            │                        └─────────────┬─────────────┘
            │                                      │
     ┌──────▼──────────────────────────────────────▼──────┐
     │        @somnia-chain/markets-sdk  ·  viem          │
     └───────────────────────┬────────────────────────────┘
                             │
   ┌─────────────────────────▼──────────────────────────┐
   │  Somnia Shannon (50312)                            │
   │  MarketsCore · BinaryMarketsModule · OracleHub     │
   │  BinarySettlement · OutcomeToken6909 (ERC-6909)    │
   └────────────────────────────────────────────────────┘
```

### Why a TypeScript bridge instead of Python web3

The SDK is TypeScript-only and owns the parts that are genuinely hard to
reimplement: tick/lot quantization against live venue params, order signing, the
reactive order book, and one-round-trip confirms via
`realtime_sendRawTransaction`. Rewriting that in `web3.py` would have been the
project's biggest source of subtle, money-losing bugs.

So the split is strict: **Python holds the reasoning and never touches a key or
computes an on-chain quantity. TypeScript holds the wallet and never decides
anything.** Every quantization happens in the bridge, always rounding down.

---

## How the SDK is used

This is not a single `placeOrder` call behind a UI. All three tiers of
`@somnia-chain/markets-sdk` are load-bearing:

| Tier | Used for | Where |
| --- | --- | --- |
| **React hooks** | `useLiveBinaryOrderBook` - the book materialised from chain logs over one WebSocket. The app polls *nothing*. | `app/markets/[symbol]/market-panel.tsx` |
| **Unified (CCXT-like)** | `loadMarkets`, `fetchOrderBook`, `createOrder`, `cancelOrder`, `fetchPrice`, `fetchPriceOHLCV` | `lib/dreamdex.ts`, `scripts/bot-bridge.ts` |
| **Raw client/trader** | `listLiveBinaryMarkets`, `listPastBinaryMarkets`, `getPortfolio`, `getBinaryBookParams`, `getMarketOnchain`, `getOpeningPrices`, `trader.redeem`, `trader.faucet` | `lib/portfolio.ts`, `scripts/bot-bridge.ts` |

The **price feed** (`SOMNIA_TESTNET_PRICE_FEED`) is what makes the whole
strategy possible - it is the oracle these contracts settle on, so reading it is
how the desk prices a contract instead of guessing at it.

---

## The pricing model

For a contract "will `S` be at or above `K` at time `T`", under driftless
geometric Brownian motion:

```
P(S_T ≥ K) = Φ(d₂),   d₂ = [ ln(S/K) − ½σ²τ ] / (σ√τ)
```

- `S` - live EMA spot from the settlement feed
- `K` - the contract's strike, or its posted opening price for "closes at or
  above its open" markets
- `τ` - seconds to expiry, annualised
- `σ` - realized volatility from 1-minute candles of the same feed

Driftless is deliberate: over a 60-second horizon any realistic drift is swamped
by volatility, and estimating it from an hour of testnet ticks would add far
more error than it removes.

Sizing is **quarter-Kelly**, capped at 10% of bankroll per contract:

```
f* = ¼ · (p·b − q)/b,     b = (1 − price)/price
```

Edge is measured against **the price we would pay**, never the mid. On a
32-point-wide book the mid always looks cheap while the ask does not - measuring
from the mid is exactly how a backtest prints profit a live book never pays.

That last input is the one that bites. Estimate volatility from an hour of
one-minute candles and then price a 45-day contract with it, and the answer is
badly wrong in a specific direction: intraday variance sits far below multi-day
variance, so the estimate comes out low, d2 comes out large, and a coin flip
prices as a 0.41 "edge". The desk went 0 for 3 on settled positions before this
was caught.

So the sampling window has to cover at least twice the contract's horizon, and
the check is on the data actually returned, not the data requested. On this
testnet that means long-dated contracts are simply refused:

```
vol(ETH): 51 x 1d covers 4406400s, need 6771970s - horizon out of reach
```

Markets with no price feed (the `BOTNAV` agent-performance series) fall through
to a second tier that would blend cross-venue consensus with news sentiment.
**No consensus source is wired, so that tier always declines and those markets
are never traded.** The seam is real and typed (`blend_narrative` in
`strategy.py`); what is missing is a feed to put behind it. The desk refuses to
price rather than guessing at a number it cannot defend, which is the behaviour
we want either way - refusing to price is a first-class outcome here.

---

## Quick start

Requires Node 20+, Python 3.12+, and a Shannon-funded key.

```bash
git clone https://github.com/MikeMoulder/yolomarkets-somnia
cd yolomarkets-somnia

cp .env.example .env          # then set SOMNIA_PRIVATE_KEY
cd web && npm install
```

**Get funded.** Gas and collateral are *different tokens*:

- **STT** (gas) - from the Somnia testnet faucet or the SomniaHacks Telegram.
- **tUSDC** (collateral) - self-serve once you have gas:
  `npm run somnia:smoke -- --fund`

**Check connectivity** before anything else:

```bash
cd web && npm run somnia:smoke
```

```
  ok  chain id is 50312
  ok  rpc serves blocks - #484014631
  ok  loadMarkets() returns symbols - 53 symbols
  ok  live binary Event Contracts found - 20 live
  ok  every market resolved a tradable symbol - 20/20
  ok  venue exposes tick/lot sizes
  ok  all book prices are probabilities in (0,1)
```

**Run it** (three terminals):

```bash
cd web   && npm run bridge                       # execution bridge (holds the key)
cd web   && npm run dev                          # terminal on :3000
cd agent && .venv/bin/python desk.py --watch     # the desk
cd agent && .venv/bin/python chat_service.py     # chat copilot
```

The bridge is **dry-run by default**. Set `BRIDGE_DRY_RUN=0` to sign for real.

```bash
cd agent && .venv/bin/python desk.py --paper-bankroll 100   # observe decisions unfunded
cd agent && .venv/bin/python desk.py --make                 # also rest two-sided quotes
```

---

## Network

| | |
| --- | --- |
| Chain | Somnia Shannon testnet - **50312** |
| RPC | `https://api.infra.testnet.somnia.network` |
| WebSocket | `wss://api.infra.testnet.somnia.network/ws` |
| Indexer | `https://dev.smk.somnia.host/v1/graphql` |
| Price feed | `https://price-feed.dev.oracle.somnia.host/v1/graphql` |
| Explorer | https://shannon-explorer.somnia.network |
| Gas | **STT** (18 dec) |
| Collateral | **tUSDC** `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` (6 dec) |

| Contract | Address |
| --- | --- |
| MarketsCore | `0x2802504314685D89bF6C992CA5a8e7cC78bc0294` |
| BinaryMarketsModule | `0x3ecC694Cef705358864a646142ac17A90E29e388` |
| BinarySettlement | `0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23` |
| OutcomeToken6909 | `0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9` |
| OracleHub | `0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b` |
| CollateralRouter | `0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C` |

We deploy **no contracts of our own** - the venue supplies the market, the order
book and the oracle.

---

## Layout

```
web/
  lib/somnia.ts            network, address book, exchange factories
  lib/dreamdex.ts          Event Contract catalog + order books
  lib/portfolio.ts         positions, marks, claims
  app/markets/[symbol]/    detail page + live book panel
  components/trade-ticket  the max-loss order form
  scripts/bot-bridge.ts    the execution bridge (the desk's wallet)
  scripts/somnia-smoke.ts  connectivity check
agent/
  desk.py                  the autonomous loop
  strategy.py              fair value, Kelly, quoting
  chat_service.py          the streaming chat copilot
  bridge_client.py         the only path from Python to the chain
  test_strategy.py         assertions on the pricing math
```

## Testing

```bash
cd agent && .venv/bin/python test_strategy.py   # the pricing math
cd web   && npm run somnia:smoke                # live connectivity
cd web   && npx tsc --noEmit && npm run build
```

The strategy suite recovers a known volatility from synthetic GBM to within
15%, checks quarter-Kelly against the closed form, and asserts the wide-book
trap (fair value inside a wide spread must **not** register as an edge).

## Status

Testnet only. tUSDC has no monetary value. The desk trades its own wallet;
chat-proposed orders are signed by the user, never by the agent.

## Roadmap

- **Become a market creator.** The SDK exposes the full pipeline
  (`operatorAdmin.createVenue` → `marketCreatorAdmin.createMarketCreator` →
  `oracleHub.scheduleQuestion` → `registerSeries` → `triggerRoll`). YOLO would
  list its own series and the desk would both make and quote them.
- Volatility surface per asset and cadence, rather than one realized estimate.
- Inventory-aware quoting with automatic hedging across correlated strikes.
