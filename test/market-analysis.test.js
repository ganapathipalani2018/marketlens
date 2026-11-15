import test from "node:test";
import assert from "node:assert/strict";
import { backtestTrendStrategy, calculateIndicators } from "../lib/market-analysis.js";

function risingCandles(count) {
  return Array.from({ length: count }, (_value, index) => {
    const close = 100 + index * 1.5;
    return {
      date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
      open: close - 0.4,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10000 + index * 10
    };
  });
}

function oscillatingCandles(count) {
  return Array.from({ length: count }, (_value, index) => {
    const close = 100 + Math.floor(index / 2) * 0.1 + (index % 2 ? -0.2 : 0);
    const previousClose = index
      ? 100 + Math.floor((index - 1) / 2) * 0.1 + ((index - 1) % 2 ? -0.2 : 0)
      : close;
    return {
      date: `2026-02-${String((index % 28) + 1).padStart(2, "0")}`,
      open: previousClose,
      high: Math.max(previousClose, close) + 0.05,
      low: Math.min(previousClose, close) - 0.05,
      close,
      volume: 10000
    };
  });
}

test("indicator analysis validates history and returns transparent trend metrics", () => {
  assert.match(calculateIndicators(risingCandles(49)).error, /50 candles/);
  const result = calculateIndicators(risingCandles(80));
  assert.equal(result.trend, "Uptrend");
  assert.equal(result.score, 75);
  assert.equal(result.entryCondition, false);
  assert.ok(result.sma20 > result.sma50);
  assert.equal(result.rsi14, 100);
});

test("backtest is bounded by starting capital and reports drawdown and assumptions", () => {
  assert.match(backtestTrendStrategy(risingCandles(59)).error, /60 daily candles/);
  assert.match(backtestTrendStrategy(risingCandles(80), 0).error, /greater than zero/);
  const result = backtestTrendStrategy(oscillatingCandles(100), 50000);
  assert.equal(result.startingCapital, 50000);
  assert.ok(result.finalEquity > result.startingCapital);
  assert.equal(result.equityCurve.length, 50);
  assert.ok(result.tradeCount > 0);
  assert.match(result.assumptions, /Excludes fees/);
  assert.ok(result.maxDrawdownPct >= 0);
});

test("backtest prioritizes the stop if stop and target trade inside the same candle", () => {
  const candles = oscillatingCandles(100);
  candles[51] = { ...candles[51], low: 90, high: 110 };
  const result = backtestTrendStrategy(candles);
  const exited = result.trades.find(trade => trade.exitDate === candles[51].date);
  assert.equal(exited.exitReason, "ATR stop");
});
