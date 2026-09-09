# Handoff

Last updated: 2026-09-09

Repo: https://github.com/MikeMoulder/yolomarkets-somnia

## THE ONE BLOCKER

**The desk wallet holds 0 STT and cannot place a single order.**

```
0xa92F9706146542d30a6E3b8C48eB996fF3D9175e
```

Fund it from the Somnia testnet faucet or the SomniaHacks Telegram. Gas is
**STT**; collateral is **tUSDC** and is self-serve once gas exists
(`npm run somnia:smoke -- --fund`, or `POST /faucet` on the bridge).

Everything below is built and verified against live Shannon EXCEPT the signing
of a real order, which is blocked on this and nothing else.

## What works

- **Terminal.** Catalog of live Event Contracts, market detail with the resting
  book streamed from chain logs (`useLiveBinaryOrderBook`, no polling), a trade
  ticket sized in max loss, portfolio with `trader.redeem`.
- **Execution bridge** (`web/scripts/bot-bridge.ts`, port 8091). Twelve routes:
  health, status, markets, book, price, candles, opening, portfolio, order,
  cancel, redeem, faucet. Shared-secret auth, dry-run by default, quantizes
  price and size DOWN to the venue tick/lot.
- **The desk** (`agent/desk.py`). Perceive, price, decide, execute, settle,
  journal. Prices analytically off the settlement feed; quarter-Kelly sizing;
  two-sided quoting behind `--make`.
- **Chat copilot** (`agent/chat_service.py`, port 8081). SSE streaming with
  five tools; `propose_trade` prices against the live book and emits a
  confirmation card the user signs themselves.

Verified live: 20 markets listed, 16 priced analytically, ETH fair 0.444 vs
book 0.42/0.449, a $5 max-loss proposal sizing to 8.621 contracts at 0.58.
28 strategy assertions pass.

## What is left

1. **A real fill.** Blocked on STT. When gas lands:
   `cd web && BRIDGE_DRY_RUN=0 npm run bridge`, then
   `cd agent && .venv/bin/python desk.py` - and screenshot the explorer.
2. **Demo video** (2-3 min, 15% of the score).
3. **Deploy.** Nothing is deployed; only local `next start`.
4. The agent journal needs `DATABASE_URL` set to populate the desk page feed;
   without it the page renders empty (by design, it is never load-bearing).

## Ports

3000 Next.js · 8081 chat copilot · 8091 execution bridge.

Note: an unrelated older service on this machine occupies 8080 and 8090, which
is why these ports were chosen.

## Traps worth knowing

See CLAUDE.md for the full list. The two that cost real time:

- `loadMarkets()` must be refreshed on a TTL. Contracts roll every ~60s and
  that call maps a marketId to a tradable symbol; memoised at boot, every new
  market renders a dead link.
- Strikes and opening prices are integers scaled by **100**, not 1e18. Reading
  them as 1e18 made every contract price as a certainty and the desk wanted to
  buy YES at any ask. There is now a sanity band that refuses to price a strike
  outside 0.5x-2x spot.
