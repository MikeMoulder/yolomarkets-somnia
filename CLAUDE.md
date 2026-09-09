# YOLO Markets - agent guidance

An autonomous trading desk for DreamDEX Event Contracts on Somnia.
This file is the load-bearing context for any AI agent working in this repo.

## Hard facts (don't re-derive)

| Thing | Value |
| --- | --- |
| Chain | Somnia Shannon testnet, id `50312` (`0xc488`) |
| RPC | `https://api.infra.testnet.somnia.network` (`https://dream-rpc.somnia.network` is an alias) |
| WebSocket | `wss://api.infra.testnet.somnia.network/ws` |
| Indexer (required by the SDK) | `https://dev.smk.somnia.host/v1/graphql` |
| Price feed | `https://price-feed.dev.oracle.somnia.host/v1/graphql` |
| Explorer | https://shannon-explorer.somnia.network |
| Block time | ~100 ms |
| Gas token | **STT**, 18 decimals |
| Collateral | **tUSDC** `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E`, **6 decimals** |
| SDK | `@somnia-chain/markets-sdk@0.29.0` + `viem@^2` |
| Multicall3 | `0x841b8199E6d3Db3C6f264f6C2bd8848b3cA64223` |

Venue contracts (we deploy none of our own):

| Contract | Address |
| --- | --- |
| MarketsCore | `0x2802504314685D89bF6C992CA5a8e7cC78bc0294` |
| BinaryMarketsModule | `0x3ecC694Cef705358864a646142ac17A90E29e388` |
| BinarySettlement | `0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23` |
| OutcomeToken6909 | `0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9` |
| OracleHub | `0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b` |
| CollateralRouter | `0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C` |

The SDK exports all of these as `SOMNIA_TESTNET_ADDRESSES`. Import that rather
than pasting addresses.

## Shape of the system

```
web/          Next.js 16 terminal + the execution bridge
  lib/somnia.ts        network, address book, exchange factories
  lib/dreamdex.ts      Event Contract catalog + order books
  lib/portfolio.ts     positions, marks, claims
  scripts/bot-bridge.ts   THE ONLY THING HOLDING THE DESK'S KEY
agent/        Python reasoning
  desk.py              the autonomous loop
  strategy.py          fair value, Kelly, quoting
  chat_service.py      SSE chat copilot
  bridge_client.py     the only path from Python to the chain
```

**The split is strict and load-bearing.** Python holds the reasoning and never
touches a key or computes an on-chain quantity. TypeScript holds the wallet and
never decides anything. If you find yourself computing ticks or lots in Python,
stop - that belongs in the bridge.

## Running things

```bash
cd web   && npm run bridge                     # execution bridge, port 8091
cd web   && npm run dev                        # terminal, port 3000
cd agent && .venv/bin/python desk.py --watch   # the desk
cd agent && .venv/bin/python chat_service.py   # chat copilot, port 8081

cd web   && npm run somnia:smoke               # connectivity check
cd agent && .venv/bin/python test_strategy.py  # assertions on the math
```

The bridge is **dry-run by default**; `BRIDGE_DRY_RUN=0` makes it sign.

## Non-obvious rules

1. **`loadMarkets()` must be refreshed, not memoised.** Contracts roll on a
   ~60s cadence and that call is what maps a marketId to a tradable symbol.
   Memoise it at boot and every market minted afterwards renders with an
   unusable id and a link that 404s. There is a 20s TTL in `lib/somnia.ts` and
   in the bridge; keep it well under the shortest series interval.

2. **Strikes and opening prices are integers scaled by 100.** `"249027"` means
   `2490.27`. This is NOT the 18-decimal scale the price feed's own `raw`
   values use. Reading them as 1e18 gives strikes around `2.5e-13`, under which
   every contract prices as a dead certainty (`fair = 1.0`) and the desk wants
   to buy YES at any ask. `desk.py` has a sanity band - a strike outside
   0.5x-2x spot refuses to price rather than trading - because the next scale
   bug will not announce itself as loudly.

3. **The indexer applies `limit` before our expiry filter.** Ask for N markets
   and then drop the ones about to expire and you can get zero. Over-fetch,
   then trim (`lib/dreamdex.ts`).

4. **Price reads need `priceFeed: SOMNIA_TESTNET_PRICE_FEED`** in the client
   config or they throw `NotConfiguredError`. It is set in `lib/somnia.ts`.

5. **The SDK's chain `.d.ts` is frozen against an older viem.** `somniaShannon`
   needs a cast to viem's `Chain`. The runtime object is a valid chain; only
   the declared type disagrees. Re-check on SDK upgrades.

6. **Gas and collateral are different tokens.** A wallet full of tUSDC still
   cannot place an order. Say so in the UI - the failure is otherwise an opaque
   revert. tUSDC is self-serve via `trader.faucet()`; STT is not.

7. **Quantize only in the bridge, always rounding DOWN.** Price to the venue
   tick, size to the venue lot, both read live from `getBinaryBookParams`. This
   is what makes "max loss $5" mean it.

8. **Up and Down share one book.** A NO price is 1 minus the YES price, and a
   NO ask is the mirror of a YES bid. Fetching both sides separately doubles
   the work for no new information.

9. **Measure edge against the price you would PAY, never the mid.** These books
   run 3-5 points wide; the mid always looks cheap while the ask does not.

10. **Never fetch a third party during SSR without a deadline.** Use
    `lib/with-deadline.ts`. The failure mode is not an error, it is a page that
    streams a shell forever and looks like a hosting problem.

## Ports

| Port | Process |
| --- | --- |
| 3000 | Next.js |
| 8081 | chat copilot (`chat_service.py`) |
| 8091 | execution bridge (`bot-bridge.ts`) |
