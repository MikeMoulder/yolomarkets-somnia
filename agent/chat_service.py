"""Chat copilot for the YOLO desk.

A small threaded HTTP server exposing:

    POST /chat          server-sent events: status, tool, delta, proposal, done
    POST /chat/record   log an executed trade to the journal
    GET  /healthz

The model gets read-only tools over the execution bridge plus one write-shaped
tool, `propose_trade`, which PRICES an order against the live book and emits it
as a proposal. It never signs: the browser executes proposals on the user's own
wallet, so the wallet prompt is the authorization.

Deliberately http.server rather than FastAPI. The surface is three routes, the
OpenAI SDK's streaming client is synchronous, and one fewer framework is one
fewer thing to get wrong the night before a deadline.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(REPO_ROOT / ".env")

import bridge_client as bridge  # noqa: E402
import strategy as S  # noqa: E402

try:
    from db import insert_journal
except Exception:
    insert_journal = None  # type: ignore[assignment]

PORT = int(os.environ.get("AGENT_CHAT_PORT", "8081"))
SHARED_SECRET = os.environ.get("AGENT_CHAT_SHARED_SECRET", "")
MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemini-3-flash-preview")
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")

# Refuse to price a trade this close to settlement: the user still has to sign,
# and a contract that expires mid-confirm is a guaranteed loss.
MIN_TTE_SECONDS = int(os.environ.get("AGENT_CHAT_MIN_TTE_SECONDS", "120"))

SYSTEM = """You are the YOLO desk copilot.

You trade DreamDEX Event Contracts on Somnia: short-dated binary markets that
settle on an oracle price feed, usually within minutes. Prices are
probabilities between 0 and 1. Up (YES) and Down (NO) share one order book, so
a NO price is 1 minus the YES price.

How you think about value: these contracts settle on a feed whose current value
you can read, so fair value is spot, strike and time to expiry - not a vibe.
Use get_fair_value for that. Say when a market is unpriceable rather than
guessing.

Rules:
- Collateral is tUSDC. Gas is STT. They are different tokens; a user with tUSDC
  and no STT cannot trade.
- Size trades by what the user can afford to LOSE. On a binary, max loss is the
  cost.
- You never sign anything. propose_trade prepares an order the user confirms in
  their own wallet.
- Be short and concrete. Give numbers. Never invent a market, price or balance:
  call a tool.
"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_markets",
            "description": "List live Event Contracts, soonest to expire first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "max markets (default 15)"},
                    "asset": {"type": "string", "description": "filter, e.g. BTC or ETH"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_order_book",
            "description": "Best bids and asks for a market's YES side.",
            "parameters": {
                "type": "object",
                "properties": {"symbol": {"type": "string"}},
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_fair_value",
            "description": ("Model probability that a market resolves YES, from live spot, "
                            "the strike and time to expiry. Returns null if unpriceable."),
            "parameters": {
                "type": "object",
                "properties": {"symbol": {"type": "string"}},
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_portfolio",
            "description": "The user's open positions, marks and claimable payouts.",
            "parameters": {
                "type": "object",
                "properties": {"user": {"type": "string", "description": "wallet address"}},
                "required": ["user"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_trade",
            "description": ("Price an order against the live book and show the user a "
                            "confirmation card. Signs nothing."),
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string"},
                    "side": {"type": "string", "enum": ["YES", "NO"]},
                    "max_loss_usdc": {"type": "number",
                                      "description": "most the user is willing to lose"},
                    "user": {"type": "string"},
                },
                "required": ["symbol", "side", "max_loss_usdc"],
            },
        },
    },
]


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------

def _market(symbol: str) -> dict[str, Any] | None:
    for m in bridge.markets(limit=120, min_seconds_left=0):
        if m["symbol"] == symbol:
            return m
    return None


def _fair_value(m: dict[str, Any]) -> tuple[float | None, str]:
    asset = (m.get("asset") or "").upper()
    if not asset:
        return None, "market has no asset"

    try:
        spot = bridge.price(asset).get("ema")
        vol = S.realized_vol([float(r[4]) for r in bridge.candles(asset, "1m", 60)], 60.0)
    except Exception as e:
        return None, f"price feed unavailable: {e}"
    if not spot or not vol:
        return None, "no price feed for this asset"

    raw = m.get("strike")
    if not raw or str(raw) in ("0", ""):
        raw = bridge.opening_prices([m["marketId"]]).get(m["marketId"])
        if not raw:
            return None, "opening price not posted yet"

    # The venue posts levels at more than one scale, so decode against spot
    # rather than assuming one (see strategy.infer_level).
    strike = S.infer_level(raw, spot)
    if strike is None:
        return None, "price level matches no known scale near spot"

    p = S.probability_above(spot, strike, float(m["secondsLeft"]), vol)
    return p, (f"spot {spot:.2f} vs strike {strike:.2f}, {m['secondsLeft']}s left, "
               f"vol {vol:.1%}")


def run_tool(name: str, args: dict[str, Any]) -> tuple[dict[str, Any], dict | None]:
    """Returns (tool result, optional proposal to emit to the browser)."""
    if name == "list_markets":
        rows = bridge.markets(limit=int(args.get("limit") or 15), min_seconds_left=60)
        asset = (args.get("asset") or "").upper()
        if asset:
            rows = [r for r in rows if (r.get("asset") or "").upper() == asset]
        return {"markets": [
            {"symbol": r["symbol"], "question": r["question"], "asset": r.get("asset"),
             "interval": r.get("interval"), "secondsLeft": r["secondsLeft"],
             "lastPrice": r.get("lastPrice")}
            for r in rows[:20]]}, None

    if name == "get_order_book":
        m = _market(args["symbol"])
        if not m:
            return {"error": "unknown market"}, None
        b = bridge.book(m["yesSymbol"], 5)
        return {"symbol": m["symbol"], "bestBid": b.get("bestBid"),
                "bestAsk": b.get("bestAsk"), "spread": b.get("spread"),
                "bids": b.get("bids", [])[:5], "asks": b.get("asks", [])[:5]}, None

    if name == "get_fair_value":
        m = _market(args["symbol"])
        if not m:
            return {"error": "unknown market"}, None
        p, why = _fair_value(m)
        return {"symbol": m["symbol"], "fair_yes": p, "basis": why}, None

    if name == "read_portfolio":
        p = bridge.portfolio(args["user"])
        return {"open": p.get("open", []), "claimable": p.get("claimable", 0),
                "openValue": p.get("openValue", 0)}, None

    if name == "propose_trade":
        return propose_trade(args)

    return {"error": f"unknown tool {name}"}, None


def propose_trade(args: dict[str, Any]) -> tuple[dict[str, Any], dict | None]:
    symbol = args["symbol"]
    side = args["side"].upper()
    max_loss = float(args["max_loss_usdc"])

    m = _market(symbol)
    if not m:
        return {"error": "unknown market"}, None
    if m["secondsLeft"] < MIN_TTE_SECONDS:
        return {"error": f"only {m['secondsLeft']}s to expiry - too close to confirm "
                         f"safely (need {MIN_TTE_SECONDS}s)"}, None

    b = bridge.book(m["yesSymbol"], 5)
    price = b.get("bestAsk") if side == "YES" else (
        None if b.get("bestBid") is None else 1 - b["bestBid"])
    if not price or not (0 < price < 1):
        return {"error": f"no liquidity on the {side} side"}, None

    size = round(max_loss / price, 3)
    if size <= 0:
        return {"error": "size rounds to zero - increase the amount"}, None

    balance = 0.0
    if args.get("user"):
        try:
            st = bridge.portfolio(args["user"])
            balance = float(st.get("openValue") or 0)
        except Exception:
            pass

    order = {
        "symbol": m["symbol"],
        "outcome_symbol": m["yesSymbol"] if side == "YES" else m["noSymbol"],
        "question": m["question"],
        "side": side,
        "size": size,
        "price": round(price, 3),
        "cost_usdc": round(size * price, 2),
        "payout_usdc": round(size, 2),
        "wallet_balance_usdc": balance,
        "sufficient_balance": True,
    }
    return {"proposed": order}, order


# --------------------------------------------------------------------------
# Streaming turn
# --------------------------------------------------------------------------

def sse(event: dict) -> bytes:
    return f"data: {json.dumps(event)}\n\n".encode()


def chat_turn(messages: list[dict], user: str | None) -> Iterator[bytes]:
    if not API_KEY:
        yield sse({"type": "error", "message": "OPENROUTER_API_KEY is not set"})
        return

    from openai import OpenAI
    client = OpenAI(api_key=API_KEY, base_url=BASE_URL)

    convo: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM}]
    if user:
        convo.append({"role": "system", "content": f"The connected wallet is {user}."})
    convo.extend(messages)

    # Bounded so a model that loops on tools cannot stream forever.
    for _ in range(6):
        yield sse({"type": "status", "text": "thinking"})
        stream = client.chat.completions.create(
            model=MODEL, messages=convo, tools=TOOLS, stream=True,
            temperature=float(os.environ.get("BRAIN_TEMPERATURE", "0.15")),
        )

        text = ""
        calls: dict[int, dict] = {}
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                text += delta.content
                yield sse({"type": "delta", "text": delta.content})
            for tc in (delta.tool_calls or []):
                slot = calls.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                if tc.id:
                    slot["id"] = tc.id
                if tc.function and tc.function.name:
                    slot["name"] = tc.function.name
                if tc.function and tc.function.arguments:
                    slot["args"] += tc.function.arguments

        if not calls:
            yield sse({"type": "done"})
            return

        convo.append({
            "role": "assistant",
            "content": text or None,
            "tool_calls": [
                {"id": c["id"], "type": "function",
                 "function": {"name": c["name"], "arguments": c["args"] or "{}"}}
                for c in calls.values()
            ],
        })

        for c in calls.values():
            yield sse({"type": "status", "text": c["name"], "tool": c["name"]})
            try:
                args = json.loads(c["args"] or "{}")
                if c["name"] in ("read_portfolio", "propose_trade") and user:
                    args.setdefault("user", user)
                result, proposal = run_tool(c["name"], args)
                ok = "error" not in result
            except Exception as e:
                result, proposal, ok = {"error": str(e)}, None, False

            yield sse({"type": "tool", "name": c["name"], "ok": ok})
            if proposal:
                yield sse({"type": "proposal", "order": proposal})
            convo.append({"role": "tool", "tool_call_id": c["id"],
                          "content": json.dumps(result, default=str)[:6000]})

    yield sse({"type": "done"})


# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *a: Any) -> None:
        print(f"[chat] {fmt % a}", flush=True)

    def _authorized(self) -> bool:
        if not SHARED_SECRET:
            return True
        return self.headers.get("x-agent-secret") == SHARED_SECRET

    def _body(self) -> dict:
        n = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self) -> None:
        if self.path.startswith("/healthz"):
            payload = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if not self._authorized():
            self.send_error(401)
            return

        if self.path.startswith("/chat/record"):
            b = self._body()
            if insert_journal:
                try:
                    insert_journal(
                        user_addr=(b.get("userAddr") or "anon"), trigger="chat",
                        kind="trade", market=b.get("market"),
                        title=f"{b.get('side')} {b.get('sharesHuman')} contracts",
                        body=b.get("question") or "", meta=b)
                except Exception:
                    pass
            payload = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        if not self.path.startswith("/chat"):
            self.send_error(404)
            return

        b = self._body()

        # The web proxy speaks {message, user_addr, history, current_market};
        # a direct caller may send an OpenAI-style {messages, user}. Accept
        # both so the service is testable with curl without pretending the
        # browser sends a shape it does not.
        messages = b.get("messages")
        if not messages:
            history = [
                {"role": h.get("role"), "content": h.get("content")}
                for h in (b.get("history") or [])
                if h.get("role") in ("user", "assistant") and h.get("content")
            ]
            messages = history + [{"role": "user", "content": b.get("message") or ""}]
        user = b.get("user") or b.get("user_addr")
        market_hint = b.get("current_market")
        if market_hint:
            messages = [{"role": "system",
                         "content": f'The user is looking at market "{market_hint}".'}
                        ] + messages

        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        try:
            for frame in chat_turn(messages, user):
                self.wfile.write(frame)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass          # the browser navigated away mid-stream
        except Exception as e:
            try:
                self.wfile.write(sse({"type": "error", "message": str(e)}))
            except Exception:
                pass


def main() -> int:
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[chat] listening on 127.0.0.1:{PORT}  model={MODEL}", flush=True)
    if not API_KEY:
        print("[chat] OPENROUTER_API_KEY unset - chat will return an error", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
