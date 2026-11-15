import test from "node:test";
import assert from "node:assert/strict";
import { tradeIdea } from "../lib/trade-ideas.js";

const indicators = {
  latestDate: "2026-11-13",
  close: 100,
  sma20: 98,
  sma50: 95,
  rsi14: 60,
  atr14: 2,
  entryCondition: true
};

test("trade ideas use the existing entry rule and hypothetical paper levels", () => {
  assert.deepEqual(tradeIdea(indicators), {
    buyCondition: true, sellCondition: false, close: 100, date: "2026-11-13",
    stopPrice: 97, targetPrice: 106
  });
  assert.equal(tradeIdea({ ...indicators, entryCondition: false }).buyCondition, false);
});

test("sell review uses the backtest trend-exit thresholds", () => {
  assert.equal(tradeIdea({ ...indicators, close: 97 }).sellCondition, true);
  assert.equal(tradeIdea({ ...indicators, rsi14: 75 }).sellCondition, false);
  assert.equal(tradeIdea({ ...indicators, rsi14: 75.1 }).sellCondition, true);
});

test("invalid indicators or non-positive hypothetical stops are not presented as levels", () => {
  assert.match(tradeIdea({ ...indicators, atr14: 0 }).error, /unavailable/);
  assert.match(tradeIdea({ ...indicators, rsi14: NaN }).error, /unavailable/);
  const result = tradeIdea({ ...indicators, atr14: 100 });
  assert.equal(result.stopPrice, null);
  assert.equal(result.targetPrice, null);
});
