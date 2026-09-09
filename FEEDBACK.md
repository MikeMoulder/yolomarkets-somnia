# SDK and documentation feedback

Submitted for the Somnia × DreamDEX Event Contracts hackathon, which explicitly
invites this report.

**Who is writing.** YOLO Markets is an autonomous trading desk built on
`@somnia-chain/markets-sdk@0.29.0`. It reads the catalog and books, prices
contracts analytically off the settlement feed, sizes with fractional Kelly,
signs and submits limit orders, detects settlement, and redeems winners — the
full lifecycle, unattended, on Shannon. Four transactions from the desk wallet
are listed in the README with block numbers. So this feedback comes from
shipping against the SDK rather than reading it.

**Summary.** The SDK is good. `useLiveBinaryOrderBook` alone saved us a day.
Almost everything below is a *documentation* problem rather than a code
problem, and three of the items cost us real testnet money — which is the
useful signal here, because each one failed silently rather than throwing.

---

## What worked, and is worth keeping

| Surface | Why it mattered |
| --- | --- |
| `useLiveBinaryOrderBook(pool, depth)` | Materialises the resting book from chain logs with no polling loop. We deleted our own poller after finding it. This is the SDK's best feature and it is underadvertised. |
| `SOMNIA_TESTNET_ADDRESSES` | A single exported address book meant zero pasted constants and nothing to re-verify after a redeploy. |
| `getBinaryBookParams` | Exposing tick, lot and minimum size as live venue state — rather than as documentation we would have hardcoded — is exactly right. |
| `priceToProbability(value, decimals)` | The one scale converter that exists, and it is correct. See finding 1 for the ones that do not exist. |
| `trader.faucet()` | Self-serve collateral. Removed a human from our loop entirely. |
| Binary markets sharing one book | Genuinely elegant: a NO price is 1 minus the YES price and a NO ask mirrors a YES bid. See finding 6 — it needs to be stated. |

---

## Findings, ranked by what they cost us

### 1. Price levels arrive at a scale that is undocumented and not self-consistent — this one cost money

`strike` and opening prices come back as integers **scaled by 100**:
`"249027"` means `2490.27`. Book prices are fixed-point in the market's
**quote decimals** (6 on this testnet, 18 on mainnet). The price feed's own
`raw` values are **1e18**. Three different scales, on the same conceptual
quantity, reachable from the same client, none annotated in the type.

We read strikes as 1e18. Every strike became ~`2.5e-13`, every contract priced
as a dead certainty (`fair = 1.0`), and the desk wanted to buy YES at any ask.
Nothing threw. The numbers were plausible right up until they were positions.

**What makes it dangerous** is that the failure is silent and directional. An
exception would have cost minutes.

**Suggested fixes**, cheapest first:

- Say the scale in the field docs and in the type — `strike: string // integer, ×100`.
- Ship `strikeToPrice(raw)` next to `priceToProbability`, so no integration
  hand-rolls a divisor.
- Best: return these as annotated values, or make the scale a property of the
  market object rather than tribal knowledge.

We ended up **inferring** the scale by testing candidate divisors against spot
and refusing to price anything that lands outside 0.5×–2× spot
(`agent/strategy.py:infer_level`). That is a workaround for missing metadata,
and we would happily delete it.

### 2. `loadMarkets()` looks memoisable and is not

The natural read is that a market map is static, so you cache it at boot.
Contracts on this venue roll on a **~60 second cadence**, and this call is what
maps a `marketId` to a tradable symbol. Memoised once, every market minted
afterwards renders with an unusable id and a link that 404s — and again, no
error, just a UI that quietly rots the longer it stays open.

**Suggested fix:** document the expected refresh cadence at the call site, and
either expose a TTL option or invalidate internally on a new-market event. We
run a 20s TTL, chosen to stay well under the shortest series interval.

### 3. The indexer applies `limit` *before* filters, so a correct query returns zero

Ask for 20 live markets, then drop the ones inside your minimum time-to-expiry,
and you can legitimately get an empty list while the venue is busy. It reads as
an outage or an empty venue, and it is neither.

**Suggested fix:** one line in the query docs — "`limit` is applied before
filtering; over-fetch and trim." Or support the expiry filter server-side.

### 4. `NotConfiguredError` fires at call time, not at construction time

Omit `priceFeed: SOMNIA_TESTNET_PRICE_FEED` from the client config and the
client constructs happily, then throws on the first price read — often deep in
an async path, far from the config that caused it.

**Suggested fix:** validate at construction, or name the missing key in the
message (`NotConfiguredError: priceFeed`). The current message does not say
which capability was not configured, so the first search is through your own
code rather than the config object.

### 5. Gas and collateral are different tokens, and the failure is an opaque revert

**STT** is gas, **tUSDC** is collateral, and they are unrelated. A wallet
holding 4,000 tUSDC and zero STT cannot place an order, and what the user sees
is a revert with nothing in it about funding. tUSDC is self-serve via
`trader.faucet()`; STT is not, which makes this the more likely of the two to
be empty.

**Suggested fix:** a typed `InsufficientGasError`, or a preflight balance check
in the order path. We surface it in our own UI because the raw failure is
unactionable, but every integration will independently rediscover this.

### 6. That Up and Down share one book is load-bearing and unstated

We fetched both sides separately before working out that a NO ask is the mirror
of a YES bid — double the RPC work for no new information.

**Suggested fix:** state the invariant in the binary-markets docs with the two
lines of arithmetic. It is a nice design; it is currently something you deduce.

### 7. Rounding direction on quantization is left entirely to the caller

`getBinaryBookParams` gives tick and lot. What it does not say is which way to
round. For anything that promises a user a bounded loss, the answer must be
**down, always, on both price and size** — round up and "max loss $5" silently
becomes $5.02.

**Suggested fix:** ship `quantizePrice`/`quantizeSize` helpers with an explicit
rounding argument, defaulting to floor. This is small, but it is the kind of
thing every integration writes slightly differently and one of them writes
wrong.

### 8. The chain export's types are frozen against an older viem

`somniaShannon` from `@somnia-chain/markets-sdk/chains` does not satisfy viem's
current `Chain` type, so it needs `as unknown as Chain` in a strict codebase.
The runtime object is a valid chain — only the declared type disagrees.

**Suggested fix:** widen the peer range or regenerate against current viem.
Worth re-checking each SDK release; a cast is the kind of thing that hides a
real type error later.

### 9. Which SDK is the official surface is not stated plainly enough

`@somnia-chain/markets-sdk` and the DreamDEX Bot Kit are both presented as ways
to trade Event Contracts. It took reading both to conclude that the markets SDK
is the primary developer surface and the Bot Kit is an optional toolkit on top.
For a team choosing a foundation in hour one of a hackathon, that decision is
expensive to get wrong.

**Suggested fix:** one sentence at the top of each README saying what the other
one is for.

---

## Documentation gaps, in one list

- Scale of `strike`, opening prices, book prices and feed `raw` values (finding 1).
- Refresh semantics of `loadMarkets()` and the ~60s contract roll (finding 2).
- `limit`-before-filter ordering on indexer queries (finding 3).
- Which config keys each capability requires (finding 4).
- STT vs tUSDC, and that only one is self-serve (finding 5).
- The shared-book invariant for binary markets (finding 6).
- Rounding direction for tick and lot (finding 7).
- Reference markets: `strike == 0` means "settles against its own opening
  price", which the venue posts shortly *after* the round opens. Before that the
  contract is genuinely unpriceable. We found this by inspecting rows, not from
  docs, and it is the difference between skipping a market and mispricing it.

## The one-line version

Ship the scale converters and document the three scales. Everything else on
this list costs an afternoon; that one costs positions, and it costs them
quietly.
