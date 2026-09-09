# Handoff

Last updated: 2026-09-09 20:10 UTC

Repo: https://github.com/MikeMoulder/yolomarkets-somnia

## Read this first: the clock

The submission window is at best hours away, and may already be shut.

| Source | End of submissions |
| --- | --- |
| `hackathon_requirements.md` (our copy) | 8 Sep - passed |
| Eventbrite listing (official) | 9 Sep, 09:00 UTC - passed |
| Web search, unverified | extended to 11 Sep, 23:59 UTC |

DoraHacks sits behind an AWS WAF captcha, so neither `curl` nor an automated
fetch can confirm the extension. **Open the DoraHacks page or the SomniaHacks
Telegram in a browser and settle this before doing any other work.** Every
priority below assumes hours, not days.

The engineering is in good shape. The packaging is what is missing: nothing is
deployed and there is no demo video. Do not start new features.

## Status: live and trading

The desk wallet is funded and has traded on Somnia Shannon.

```
0xa92F9706146542d30a6E3b8C48eB996fF3D9175e
```

Balances read from chain: **49.85 STT**, **4,485 tUSDC**.

The drawdown from 10,000 is real and mostly explained: long-dated contracts
priced off a one-hour volatility estimate (fixed), and an averaging-down loop
where a decaying mark reopened the position cap (fixed). Both are in the git
history with the numbers.

**The full lifecycle is now closed on chain** - fund, price, order, fill,
settle, redeem - with no human in it. The desk redeemed two settled winners for
259.303 and 43.750 tUSDC; the wallet moved 4,182.24 -> 4,485.30, the same
303.053. Redemption hashes `0x4fc0cdf5` and `0xbe5d8d57`, both to
BinaryMarketsModule.

Four transactions, all re-verified against the RPC (`status=0x1`, all sent from
the desk wallet). Hashes are in the README:

| What | Tx | Block |
| --- | --- | --- |
| Faucet mint | `0x6dab7cea` | 484070681 |
| Manual order, filled in full | `0xcf3bb528` | 484071328 |
| Agent trade, NO at 8.6pt edge | `0xa35eb82f` | 484073292 |
| Agent trade, YES at 4.7pt edge | `0x179bf5ad` | 484073307 |

The last two were chosen, priced and sized by the desk with no human in the
loop. That is the project's strongest single claim - lead with it. Settlement
detection works too: the YES trade lost, and the position was correctly marked
worthless and excluded from claimable.

Gas is STT, collateral is tUSDC, and they are unrelated: tUSDC is self-serve
via `npm run somnia:smoke -- --fund`, STT is not.

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
  confirmation card the user signs themselves. **Currently unusable - see
  Known bugs 1 and 2.**

Green as of the last check: `npx tsc --noEmit` clean, `npm run build` exit 0,
`npm run somnia:smoke` all checks pass against live Shannon, and **61** strategy
assertions pass. Note that README.md:311, README.md:317 and CLAUDE.md:65 all
still say **28** - the suite has more than doubled since that number was
written. Prefer "all strategy checks pass" in docs over a count that rots.

## Known bugs

Ranked by what a judge would hit first.

1. **OpenRouter credits are exhausted.** Posting to `127.0.0.1:8081/chat`
   streams `status: thinking` and then
   `402 - Insufficient credits`. Transport, auth, tools and error propagation
   all work; the model call is the only thing failing. **The copilot cannot be
   demoed until this is topped up** - and it is a headline feature.

2. **The chat route's fallback port is still wrong, and it will bite on
   deploy.** `web/app/api/agent/chat/route.ts:22` defaults `AGENT_SERVICE_URL`
   to `http://127.0.0.1:8080`, which on this machine is
   `/root/yolomarkets/agent/runner.py` - an unrelated project that answers
   `/chat` with an empty 200. Locally this is now masked: `web/.env.local` sets
   `AGENT_SERVICE_URL` explicitly, so the running app does reach 8081 and the
   proxy is verified working end to end. But the fallback is one missing env
   var away from silently routing chat into another project. Change the default
   to 8081, and **set `AGENT_SERVICE_URL` explicitly in the Vercel
   environment** when deploying.

3. **`web/package.json` advertises 12 scripts that do not exist** -
   `catalog-indexer`, `nanopay-service`, `fast-market-keeper`,
   `fast-market-swarm`, `polymarket-wrap`, `polymarket-resolution-keeper`,
   `telegram-suggest`, `telegram-bot`, `generate-fast-market-wallets`,
   `generate-standalone-wallets`, `sweep-standalone-wallets`,
   `x402-insight-demo`. Seven dependencies are also unused with zero imports
   anywhere: `@circle-fin/*` (4), `@x402/*` (2), `jose`. All leftovers from a
   prior project. Technical Implementation is 25% of the score and
   `package.json` is opened early.

4. **Doc drift on claims we stake credibility on.**
   - `agent/desk.py:9` documents a `--once` flag that is not registered.
     One pass is already the default, so just drop the line.
   - `web/scripts/bot-bridge.ts:33` defaults `BRIDGE_PORT` to **8090**, but the
     docs say 8091 and 8090 is occupied on this box. Only `.env` saves it.

5. **The "narrative" pricing tier can never fire.** `desk.py:217` never passes
   `consensus` or `sentiment`, so `blend_narrative` always returns `None` and
   every non-feed market is refused. The README wording is accurate but implies
   a cross-venue capability that does not run. Either wire a consensus source
   or soften the claim.

6. **`update_plan.md` and the shipped design disagree.** The plan specifies a
   FastAPI gateway, `@somnia-chain/dreamdex-bot-kit`, Polymarket Gamma
   ingestion, `agent/ingestion.py` and `agent/economics.py` - none of which
   exist, because the desk went analytic instead. That was the right call and
   `strategy.py` opens by explaining exactly why. But the plan reads as
   outstanding scope to anyone who opens it. Add a one-line header marking
   which parts are superseded and which are still roadmap.

## What is left

In this order.

1. **Confirm the deadline.** Everything else depends on it.
2. **Top up OpenRouter credits** (Known bug 1). Everything else in the chat
   path is verified working; this one 402 is all that stands between the
   copilot and a demo.
3. **Record the demo video** (2-3 min, 15% of the score, currently a zero). The
   strongest 30 seconds already exists: the desk picking, pricing and sizing a
   trade unaided, then the explorer showing the transaction.
4. **Deploy.** Nothing is deployed; only local `next start`. Vercel is fine -
   `/api/agent/status` already degrades gracefully to "Offline" when the bridge
   is unreachable, so a deploy will not break the page. Set
   `AGENT_SERVICE_URL` explicitly there (Known bug 2).
5. If time remains: clear Known bugs 3, 4, 5 and 6, then write the **SDK and
   docs feedback report**. It is explicitly invited in the submission
   guidelines and CLAUDE.md's ten traps are already 80% of it.

## Requirements scorecard

Checked strictly against `hackathon_requirements.md` and the live docs.

| Requirement | Status |
| --- | --- |
| Working prototype | done - build clean, smoke passes live |
| Integration with DreamDEX Event Contracts | done - 4 txs verified on chain |
| Meaningful use of DreamDEX APIs/SDKs | done - all three SDK tiers load-bearing |
| Clear and intuitive UX | done |
| GitHub repository | done - public, clean tree, no secrets in history |
| Prototype accessible on testnet | **missing - nothing deployed** |
| 2-3 min demo video | **missing** |
| Optional: SDK/docs feedback report | not started, cheap win |
| Optional: deck | not started |

`@somnia-chain/markets-sdk` >= 0.29.0 is confirmed by the DreamDEX docs as the
official developer surface for Event Contracts, and we are on `^0.29.0`. The
DreamDEX Bot Kit is a separate optional toolkit - not using it is not a gap.

## Note for the next agent

This repo has had **more than one session committing to it concurrently**.
Four commits landed between `667b87a` and this handoff while an audit was in
progress, one of which fixed a bug the audit had already written up. Before
acting on anything below, run `git log --oneline -10` and re-check the specific
line the note points at. Findings here were verified at 2026-09-09 ~19:45 UTC
and every one was re-confirmed against HEAD at that time.

## Ports

3000 Next.js · 8081 chat copilot · 8091 execution bridge.

An unrelated older project on this machine (`/root/yolomarkets`) occupies 8080
and 8090, which is why these ports were chosen. That collision is no longer
just a note - it is actively breaking the chat proxy (Known bug 1).

## Traps worth knowing

See CLAUDE.md for the full list. The two that cost real time:

- `loadMarkets()` must be refreshed on a TTL. Contracts roll every ~60s and
  that call maps a marketId to a tradable symbol; memoised at boot, every new
  market renders a dead link.
- Strikes and opening prices are integers scaled by **100**, not 1e18. Reading
  them as 1e18 made every contract price as a certainty and the desk wanted to
  buy YES at any ask. There is now a sanity band that refuses to price a strike
  outside 0.5x-2x spot.
