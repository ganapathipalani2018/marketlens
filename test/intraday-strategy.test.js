import test from "node:test";
import assert from "node:assert/strict";
import { evaluateIntraday } from "../lib/intraday-strategy.js";

const now = Date.parse("2026-11-19T04:32:00Z");
const start = Math.floor(now / 300000) * 300000;
const candles = Array.from({ length: 80 }, (_, index) => {
  const close = 100 + Math.floor(index / 2) * 0.1 + (index % 2 ? -0.2 : 0);
  const previous = index ? 100 + Math.floor((index - 1) / 2) * 0.1 + ((index - 1) % 2 ? -0.2 : 0) : close;
  return {
    date: new Date(start - (80 - index) * 300000).toISOString(),
    open: previous, high: Math.max(previous, close) + 0.05, low: Math.min(previous, close) - 0.05, close
  };
});

function evaluate(price, overrides = {}) {
  return evaluateIntraday({
    now, candles, connected: true, entryPrice: "",
    tick: { start, receivedAt: now, price, open: price, high: price, low: price },
    ...overrides
  });
}

test("live tick conditions and entered-price example levels update without requiring a position", () => {
  const buy = evaluate(103.8, { entryPrice: "103.8" });
  assert.equal(buy.buy, true);
  assert.equal(buy.sell, false);
  assert.ok(buy.levels.stopPrice < 103.8);
  assert.ok(buy.levels.targetPrice > 103.8);

  const stop = evaluate(buy.levels.stopPrice, { entryPrice: "103.8" });
  assert.equal(stop.sell, true);
  assert.ok(stop.reasons.includes("Example stop reached"));
  const target = evaluate(buy.levels.targetPrice, { entryPrice: "103.8" });
  assert.equal(target.sell, true);
  assert.ok(target.reasons.includes("Example target reached"));
  const trend = evaluate(103);
  assert.equal(trend.levels, null);
  assert.ok(trend.reasons.includes("Trend exit rule met"));
  const simultaneous = evaluate(103.8, { entryPrice: "105" });
  assert.equal(simultaneous.buy, true);
  assert.ok(simultaneous.reasons.includes("Example stop reached"));

  const invalidEntry = evaluate(103.8, { entryPrice: "-1" });
  assert.match(invalidEntry.entryError, /above zero/);
  assert.equal(invalidEntry.levels, null);
  assert.equal(invalidEntry.buy, true);
  assert.match(evaluate(103.8, { entryPrice: "1e308" }).entryError, /valid buy price/);
  assert.match(evaluate(103.8, { entryPrice: "0.1" }).entryError, /positive example levels/);
});

test("conditions are unavailable outside market hours or with stale stream, ticks, or candles", () => {
  assert.match(evaluate(103, { now: Date.parse("2026-11-19T10:01:00Z") }).error, /market hours/);
  assert.match(evaluate(103, { now: Date.parse("2026-11-21T04:32:00Z") }).error, /market hours/);
  assert.match(evaluate(103, { connected: false }).error, /stream unavailable/);
  assert.match(evaluate(103, { tick: { start, receivedAt: now - 30001, price: 103 } }).error, /recent live price/);
  assert.match(evaluate(103, { tick: { start, receivedAt: now, sourceAt: now - 30001, price: 103 } }).error, /timestamp is stale/);
  assert.match(evaluate(103, { tick: { start, receivedAt: now, sourceAt: NaN, price: 103 } }).error, /timestamp is stale/);
  assert.match(evaluate(103, { tick: { start: start - 300000, receivedAt: now, price: 103, open: 103, high: 103, low: 103 } }).error, /current 5-minute/);
  assert.match(evaluate(103, { candles: candles.slice(0, -1) }).error, /latest completed/);
  assert.match(evaluate(103, { candles: candles.slice(-49) }).error, /latest completed/);
});
