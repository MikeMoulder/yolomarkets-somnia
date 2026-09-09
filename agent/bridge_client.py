"""Thin HTTP client for the TypeScript execution bridge.

Every chain read and write the Python agent performs goes through here. The
split is deliberate: the DreamDEX SDK is TypeScript-only and owns tick/lot
quantization, order signing and the reactive book, so Python never touches a
key and never computes an on-chain quantity.
"""

from __future__ import annotations

import os
from typing import Any

import requests

BRIDGE_URL = os.environ.get("AGENT_BRIDGE_URL", "http://127.0.0.1:8091")
BRIDGE_SECRET = os.environ.get("AGENT_BRIDGE_SECRET", "")
TIMEOUT = float(os.environ.get("AGENT_BRIDGE_TIMEOUT_S", "30"))


class BridgeError(RuntimeError):
    pass


def _headers() -> dict[str, str]:
    h = {"content-type": "application/json"}
    if BRIDGE_SECRET:
        h["x-bridge-secret"] = BRIDGE_SECRET
    return h


def _get(path: str, **params: Any) -> Any:
    clean = {k: v for k, v in params.items() if v is not None}
    try:
        r = requests.get(f"{BRIDGE_URL}{path}", params=clean,
                         headers=_headers(), timeout=TIMEOUT)
    except requests.RequestException as e:
        raise BridgeError(f"bridge unreachable at {BRIDGE_URL}: {e}") from e
    if r.status_code >= 400:
        raise BridgeError(f"GET {path} -> {r.status_code}: {r.text[:200]}")
    return r.json()


def _post(path: str, payload: dict[str, Any]) -> Any:
    try:
        r = requests.post(f"{BRIDGE_URL}{path}", json=payload,
                          headers=_headers(), timeout=TIMEOUT)
    except requests.RequestException as e:
        raise BridgeError(f"bridge unreachable at {BRIDGE_URL}: {e}") from e
    if r.status_code >= 400:
        raise BridgeError(f"POST {path} -> {r.status_code}: {r.text[:200]}")
    return r.json()


def health() -> dict[str, Any]:
    return _get("/health")


def status() -> dict[str, Any]:
    return _get("/status")


def markets(limit: int = 60, min_seconds_left: int = 60) -> list[dict[str, Any]]:
    return _get("/markets", limit=limit, minSecondsLeft=min_seconds_left)["markets"]


def book(outcome_symbol: str, depth: int = 5) -> dict[str, Any]:
    return _get("/book", symbol=outcome_symbol, depth=depth)


def price(asset: str) -> dict[str, Any]:
    return _get("/price", asset=asset)


def candles(asset: str, timeframe: str = "1m", limit: int = 60) -> list[list[float]]:
    return _get("/candles", asset=asset, timeframe=timeframe, limit=limit)["candles"]


def opening_prices(market_ids: list[str]) -> dict[str, str | None]:
    if not market_ids:
        return {}
    return _get("/opening", marketIds=",".join(market_ids))["opening"]


def portfolio(user: str | None = None) -> dict[str, Any]:
    return _get("/portfolio", user=user)


def place_order(*, symbol: str, side: str, price: float, size: float,
                order_type: str = "limit", post_only: bool = False) -> dict[str, Any]:
    """Place an order. Quantization happens in the bridge, never here."""
    return _post("/order", {
        "symbol": symbol,
        "side": side,
        "type": order_type,
        "price": price,
        "size": size,
        "postOnly": post_only,
    })


def cancel_order(order_id: str, symbol: str) -> dict[str, Any]:
    return _post("/cancel", {"id": order_id, "symbol": symbol})


def redeem(*, market_id: str, outcome_idx: int, amount: float) -> dict[str, Any]:
    return _post("/redeem", {"marketId": market_id,
                             "outcomeIdx": outcome_idx,
                             "amount": amount})


def faucet() -> dict[str, Any]:
    return _post("/faucet", {})
