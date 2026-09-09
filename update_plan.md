> **Status: historical planning document, partly superseded. Not a to-do list.**
>
> This was the pre-build plan. The shipped system diverged from it deliberately,
> and `README.md` plus `agent/strategy.py` describe what actually runs. Read this
> for intent, not for outstanding scope.
>
> | Plan item | Reality |
> | --- | --- |
> | Polymarket Gamma ingestion, `agent/ingestion.py` | **Superseded.** DreamDEX's live corpus is almost entirely price-feed contracts settling in 1-15 minutes off an oracle we can read directly. Those are priced analytically, not by cross-venue consensus. `strategy.py` opens by explaining the call. |
> | LLM sentiment as the pricing engine | **Superseded.** The LLM drives the chat copilot, not fair value. Pricing a 60-second contract cannot wait on a model call. |
> | `@somnia-chain/dreamdex-bot-kit` | **Not used.** `@somnia-chain/markets-sdk@0.29.0` is the official Event Contracts surface and is what the bridge is built on. The Bot Kit is a separate optional toolkit. |
> | FastAPI gateway | **Superseded.** The bridge is the TypeScript process in `web/scripts/bot-bridge.ts`; Python talks to it over HTTP via `bridge_client.py`. The strict split (Python reasons, TypeScript signs) survived; the framework did not. |
> | `agent/economics.py` | **Never built.** Sizing lives in `strategy.py` (`kelly_size`). |
> | Order-book market making, Kelly sizing, max-loss position sizing, the terminal | **Shipped.** |
> | Cross-venue probability arbitrage | **Roadmap.** The seam exists and is typed (`blend_narrative`); no consensus feed is wired behind it, so it never fires. |

---

Here is the fully expanded, granular **`idea.md`** breakdown. It details every single file, contract interaction, data payload, API schema, and execution step needed to convert YOLO Markets into the winning submission.

---

# YOLO Markets v2 — Autonomous Order-Book Market Maker & Cross-Chain Arb Engine

> **Somnia × DreamDEX Event Contracts Hackathon Submission**

---

## Executive Summary

**YOLO Markets v2** evolves prediction markets from passive, illiquid automated market maker (AMM) liquidity pools into a high-frequency, **AI-agent driven order-book trading suite** built on **Somnia Shannon Testnet** and **DreamDEX Event Contracts**.

Traditional prediction markets suffer from cold-start illiquidity, wide bid-ask spreads, and delayed odds reactions relative to global news and off-chain benchmarks. YOLO Markets v2 solves this by deploying **autonomous market-making and arbitrage agents** powered by **Claude 3.5 / LLM sentiment parsing**, **Polymarket Gamma cross-venue data feeds**, and the **`@somnia-chain/dreamdex-bot-kit`**.

By pairing an autonomous Python AI engine with DreamDEX’s zero-fee Central Limit Order Book (CLOB) and Somnia’s high-performance Layer 1 infrastructure, YOLO Markets v2 provides:

1. **Continuous Order-Book Liquidity:** Autonomous market maker (AMM-to-CLOB) grid strategies quoting tight bid-ask spreads across 15m/1h/24h event contracts.
2. **Cross-Venue Probability Arbitrage:** Real-time odds alignment between global sentiment benchmarks (Polymarket Gamma) and DreamDEX order books.
3. **Retail Copilot & Autopilot Terminal:** A sleek Next.js 15 interface featuring 1-click agent delegation, downside-capped position sizing ("Max Loss" protection), and live AI telemetry logs.

---

## Detailed System Architecture

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                                 YOLOMARKETS v2 ARCHITECTURE                               │
└───────────────────────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────┐     ┌─────────────────────────┐     ┌──────────────────────────┐
 │   External Ingestion    │     │   YOLO AI Agent Core    │     │     Execution Engine     │
 │  (Python FastAPI Engine)│     │     (Python / Claude)   │     │    (TypeScript Bridge)   │
 │                         │     │                         │     │                          │
 │ • Polymarket Gamma API  │ ──> │ • Claude 3.5 Sonnet     │ ──> │ • DreamDEX Bot Kit SDK   │
 │ • Crypto & News Feeds   │     │ • Dynamic Kelly Sizing  │     │ • Somnia Shannon RPC     │
 │ • Live DreamDEX Orderbook│    │ • Risk & Spread Engine  │     │ • STT / USDso Gas & Trades│
 └─────────────────────────┘     └─────────────────────────┘     └──────────────────────────┘
              │                                                                │
              ▼                                                                ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │                               Next.js 15 Consumer Terminal                               │
 │   • Order Book Visualizer    • Live AI Reasoning Logs    • 1-Click Autopilot Vault     │
 └──────────────────────────────────────────────────────────────────────────────────────────┘

```

---

## Component-by-Component Technical Spec

### 1. External Ingestion & Signal Layer (`agent/ingestion.py`)

* **Polymarket Gamma Ingestion:** Polls Polymarket REST endpoint (`[https://gamma-api.polymarket.com/events](https://gamma-api.polymarket.com/events)`) every 10 seconds to fetch global probability baselines for matching event titles (e.g., BTC price targets, Fed rate decisions).
* **News & Twitter Stream:** Scrapes breaking headlines and computes a normalized sentiment score $S \in [-1, 1]$.
* **Data Payload Normalized:**
```json
{
  "market_id": "somnia-btc-100k-sept",
  "dreamdex_mid": 0.52,
  "polymarket_prob": 0.61,
  "news_sentiment": 0.35,
  "timestamp": 1725849600
}

```



### 2. Probability & Arbitrage Engine (`agent/strategy.py`)

Calculates model fair-value probability $P_{\text{fair}}$ using a weighted blend of global market consensus and direct news sentiment:


$$P_{\text{fair}} = w_1 \cdot P_{\text{polymarket}} + w_2 \cdot (0.5 + 0.5 \cdot S_{\text{news}})$$

When $\vert{}P_{\text{fair}} - P_{\text{dreamdex\_mid}}\vert{} > \text{Threshold}$ (default $0.05$), the agent flags a high-conviction arbitrage opportunity.

### 3. Sizing & Risk Management (`agent/economics.py`)

Uses fractional Kelly Criterion combined with maximum loss parameters to prevent bankroll depletion:


$$f^* = \lambda \cdot \left( \frac{p \cdot b - q}{b} \right)$$

* $p = P_{\text{fair}}$ (model estimated win probability)
* $q = 1 - p$
* $b = \text{Payout ratio based on limit order price}$
* $\lambda = 0.25$ (Quarter-Kelly conservatism factor)

### 4. TypeScript Bot Kit Execution Engine (`scripts/bot_bridge.ts`)

Converts trade signals into low-latency Web3 limit order calls via `@somnia-chain/dreamdex-bot-kit`:

* **Buy YES / Limit Bid:** Placed at $\text{Best Bid} + 0.01$ when market underprices outcome.
* **Buy NO / Limit Ask:** Placed at $1.00 - (\text{Best Ask} - 0.01)$ when market overprices outcome.
* **Auto-Settlement Worker:** Continuously monitors resolved markets and invokes `claimWinnings()` via the SDK.

---

## In-Depth Code Architecture & Implementations

### Python Arbitrage Strategy Engine (`agent/strategy.py`)

```python
import math
from typing import Dict, Any

class YOLOStrategyEngine:
    def __init__(self, confidence_threshold: float = 0.04, kelly_fraction: float = 0.25):
        self.threshold = confidence_threshold
        self.kelly_fraction = kelly_fraction

    def calculate_fair_value(self, polymarket_prob: float, sentiment_score: float) -> float:
        # 80% weight on Polymarket consensus, 20% on real-time news sentiment
        fair_val = (0.80 * polymarket_prob) + (0.20 * (0.5 + (0.5 * sentiment_score)))
        return max(0.01, min(0.99, fair_val))

    def calculate_kelly_size(self, fair_prob: float, price: float, bankroll: float) -> float:
        if price <= 0 or price >= 1:
            return 0.0
        
        b = (1.0 - price) / price  # Odds payout
        p = fair_prob
        q = 1.0 - p
        
        kelly_f = (p * b - q) / b
        if kelly_f <= 0:
            return 0.0
            
        adjusted_size = bankroll * (kelly_f * self.kelly_fraction)
        return round(adjusted_size, 2)

    def evaluate(self, market_data: Dict[str, Any], bankroll: float) -> Dict[str, Any]:
        p_fair = self.calculate_fair_value(
            market_data["polymarket_prob"], 
            market_data["news_sentiment"]
        )
        
        best_bid = market_data["dreamdex_bid"]
        best_ask = market_data["dreamdex_ask"]
        mid_price = (best_bid + best_ask) / 2.0
        
        edge = p_fair - mid_price

        if edge > self.threshold:
            size = self.calculate_kelly_size(p_fair, best_ask, bankroll)
            return {
                "action": "BUY_YES",
                "symbol": market_data["symbol"],
                "target_price": round(best_ask, 2),
                "quantity": size,
                "edge": round(edge, 4),
                "reasoning": f"Fair value ({p_fair:.2f}) > DreamDEX Ask ({best_ask:.2f}). Edge: {edge:.2%}"
            }
        elif edge < -self.threshold:
            size = self.calculate_kelly_size(1.0 - p_fair, 1.0 - best_bid, bankroll)
            return {
                "action": "BUY_NO",
                "symbol": market_data["symbol"],
                "target_price": round(1.0 - best_bid, 2),
                "quantity": size,
                "edge": round(abs(edge), 4),
                "reasoning": f"Fair value ({p_fair:.2f}) < DreamDEX Bid ({best_bid:.2f}). Mispricing detected."
            }
            
        return {
            "action": "HOLD",
            "symbol": market_data["symbol"],
            "target_price": 0.0,
            "quantity": 0.0,
            "edge": round(edge, 4),
            "reasoning": "Market balanced. No actionable edge."
        }

```

---

### TypeScript DreamDEX Execution Bridge (`scripts/bot_bridge.ts`)

```typescript
import { DreamDexBot, OrderType, Side, Market } from '@somnia-chain/dreamdex-bot-kit';
import axios from 'axios';

interface AgentSignal {
  action: 'BUY_YES' | 'BUY_NO' | 'HOLD';
  symbol: string;
  target_price: number;
  quantity: number;
  reasoning: string;
}

export class YOLOExecutor {
  private bot: DreamDexBot;
  private pythonAgentUrl: string;

  constructor(botInstance: DreamDexBot, agentUrl: string) {
    this.bot = botInstance;
    this.pythonAgentUrl = agentUrl;
  }

  async runExecutionCycle(marketSymbol: string, bankroll: number) {
    try {
      // 1. Fetch live order book depth from DreamDEX CLOB
      const orderBook = await this.bot.getOrderBook(marketSymbol);
      const bestAsk = orderBook.asks[0]?.price || 0.99;
      const bestBid = orderBook.bids[0]?.price || 0.01;

      // 2. Query Python Agent API for signal
      const response = await axios.post(`${this.pythonAgentUrl}/evaluate`, {
        symbol: marketSymbol,
        dreamdex_bid: bestBid,
        dreamdex_ask: bestAsk,
        bankroll: bankroll
      });

      const signal: AgentSignal = response.data;
      console.log(`[YOLO Agent Signal] ${signal.symbol}: ${signal.action} | ${signal.reasoning}`);

      if (signal.action === 'HOLD' || signal.quantity <= 0) {
        return;
      }

      // 3. Execute order on Somnia Shannon Testnet via DreamDEX Bot Kit
      const side = signal.action === 'BUY_YES' ? Side.BUY : Side.SELL;

      const orderResult = await this.bot.placeOrder({
        symbol: signal.symbol,
        side: side,
        type: OrderType.LIMIT,
        price: signal.target_price,
        quantity: signal.quantity,
      });

      console.log(`[Order Confirmed] Tx Hash: ${orderResult.transactionHash}`);
      return orderResult;

    } catch (error) {
      console.error(`[Execution Error] Failed cycle for ${marketSymbol}:`, error);
    }
  }
}

```

---

### FastAPI Gateway Interface (`agent/main.py`)

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from strategy import YOLOStrategyEngine

app = FastAPI(title="YOLO Markets v2 Agent Core API")
engine = YOLOStrategyEngine(confidence_threshold=0.04)

class EvaluationRequest(BaseModel):
    symbol: str
    dreamdex_bid: float
    dreamdex_ask: float
    bankroll: float

@app.post("/evaluate")
async def evaluate_market(req: EvaluationRequest):
    # Mock external ingestion inputs (replaced with live Polymarket Gamma polling in prod)
    mock_market_data = {
        "symbol": req.symbol,
        "dreamdex_bid": req.dreamdex_bid,
        "dreamdex_ask": req.dreamdex_ask,
        "polymarket_prob": 0.65,  # Simulated live consensus
        "news_sentiment": 0.40   # Bullish breaking news
    }
    
    decision = engine.evaluate(mock_market_data, req.bankroll)
    return decision

@app.get("/health")
def health_check():
    return {"status": "online", "agent": "YOLO-v2-Somnia Engine"}

```

---

## Step-by-Step Deployment & Hackathon Execution Roadmap

### Phase 1: Environment Configuration & Testnet Setup (Days 1–2)

1. **Network Sync:** Connect local development environment to Somnia Shannon Testnet:
* **RPC URL:** `[https://dream-rpc.somnia.network](https://dream-rpc.somnia.network)` (or official Shannon testnet RPC)
* **Chain ID:** Somnia Testnet Chain ID
* **Faucet:** Request `STT` gas tokens via official Telegram/faucet interface.


2. **Bot Kit Installation:**
```bash
npm install @somnia-chain/dreamdex-bot-kit viem wagmi
pip install fastapi uvicorn requests pydantic httpx

```



### Phase 2: Python Agent & TypeScript Bridge Construction (Days 3–4)

1. Initialize FastAPI server (`agent/main.py`) running the ingestion and Kelly sizing modules.
2. Build `scripts/bot_bridge.ts` to poll the Python API, construct DreamDEX limit orders, and broadcast transactions to Somnia.
3. Verify testnet order creation, cancellation, and execution routines using test STT tokens.

### Phase 3: Frontend Web Terminal Upgrade (Days 5–6)

1. Modify `web/` (Next.js 15) to stream live order book depth directly from DreamDEX APIs.
2. Implement **"Downside-Capped Order Module"**:
* Input: User enters `Max USDso Risk = $25.00`
* Calculation: Frontend calculates exact contract size $Q = \frac{\text{Risk}}{\text{Limit Price}}$ and displays maximum potential payout instantly.


3. Build the **Live AI Telemetry Feed component**, rendering continuous terminal outputs from the YOLO agent (`[Arb Found] Fair: 0.65 | Ask: 0.55 | Placing Limit Buy`).

### Phase 4: Verification, Demo & Deliverables (Day 7)

1. **End-to-End Test:** Trigger an artificial price divergence on a test contract, observe the agent detect the mispricing, construct the transaction, and submit the limit order via the `dreamdex-bot-kit`.
2. **Demo Recording:** Produce a 2–3 minute video showcasing:
* **0:00 - 0:30:** Problem statement (Illiquidity, manual trading fatigue on binary contracts).
* **0:30 - 1:30:** YOLO Agent live execution (Detecting Polymarket mispricing, auto-placing limit orders on DreamDEX).
* **1:30 - 2:30:** Consumer Web UI (1-click Autopilot mode, downside-capped order slider, live order book visualization).


3. **Repository Submission:** Ensure clean documentation in `README.md`, updated `idea.md`, and public GitHub repository tags.

---

## Hackathon Evaluation & Scoring Alignment Matrix

| Criterion | Weight | How YOLO Markets v2 Maximizes Score |
| --- | --- | --- |
| **Technical Implementation** | **25%** | Deeply integrates `@somnia-chain/dreamdex-bot-kit`, bridges Python AI models with TypeScript Web3 execution, deploys on Somnia Testnet, and processes high-frequency limit order workflows. |
| **Innovation & Originality** | **20%** | Replaces static AMM bonding curves with autonomous cross-venue sentiment arbitrage agents and automated grid market-making on zero-fee CLOBs. |
| **User Experience & Design** | **20%** | Replaces complex option math with downside-capped risk inputs ("Max Loss Protection"), dark-mode terminal visuals, and 1-click strategy delegation. |
| **Business & Ecosystem Impact** | **20%** | Solves DreamDEX’s primary cold-start problem (order book liquidity) by providing continuous, automated 24/7 limit order liquidity. |
| **Presentation & Demo** | **15%** | Clean 2-minute video demonstrating real-time sentiment shifts, automated CLOB order placement, and live settlement logs. |

---

## Detailed Repository File Structure

```text
yolomarkets/
├── agent/                         # Python Autonomous AI Engine
│   ├── ingestion.py               # Polymarket Gamma API & News scrapers
│   ├── strategy.py                # Fair value probability & Kelly sizing calculations
│   ├── economics.py               # Bankroll risk guards & fractional sizing rules
│   └── main.py                    # FastAPI gateway service for TypeScript bridge
├── scripts/                       # Web3 & Bot Kit Execution Bridges
│   ├── bot_bridge.ts              # DreamDEX Bot Kit SDK handler & execution loop
│   └── deploy_testnet.ts          # Testnet setup & wallet configuration scripts
├── web/                           # Next.js 15 Consumer Terminal
│   ├── app/                       # App Router (Terminal, Autopilot Vault, AI Logs)
│   ├── components/                # CLOB Depth Visualizer, Risk Slider, Telemetry Feed
│   └── lib/                       # Web3, Viem, Wagmi, and DreamDEX SDK wrappers
├── idea.md                        # Master Technical Architecture & Hackathon Plan
├── README.md                      # Quickstart installation & setup guide
└── docker-compose.yml             # Orchestration for FastAPI, Node execution, and Next.js UI

```