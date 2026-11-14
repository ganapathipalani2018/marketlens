import test from "node:test";
import assert from "node:assert/strict";
import { calculatePaperOrder, paperDrawdownReached, paperExitReason } from "../lib/paper-simulation.js";

test("paper order size stays inside both per-trade risk and allocation caps", () => {
  const order = calculatePaperOrder({
    equity: 100000,
    cash: 100000,
    price: 100,
    atr: 2,
    riskPct: 0.5,
    allocationPct: 10
  });
  assert.equal(order.quantity, 100);
  assert.equal(order.cost, 10000);
  assert.equal(order.stopPrice, 97);
  assert.equal(order.targetPrice, 106);
});

test("paper order refuses invalid, excessive, or underfunded settings", () => {
  assert.match(calculatePaperOrder({
    equity: 100000, cash: 50, price: 100, atr: 2, riskPct: 0.5, allocationPct: 10
  }).error, /too small/);
  assert.match(calculatePaperOrder({
    equity: 100000, cash: 100000, price: 100, atr: 2, riskPct: 5, allocationPct: 10
  }).error, /invalid/);
});

test("paper exit checks stops before targets on an ambiguous quote", () => {
  const position = { stopPrice: 97, targetPrice: 106 };
  assert.equal(paperExitReason(96, position, 90), "ATR stop");
  assert.equal(paperExitReason(107, position, 90), "2R target");
  assert.equal(paperExitReason(99, position, 100), "Trend exit");
  assert.equal(paperExitReason(99, position, 90), "");
});

test("paper drawdown guard triggers at the configured portfolio loss threshold", () => {
  assert.equal(paperDrawdownReached(100000, 95000, 5), true);
  assert.equal(paperDrawdownReached(100000, 95001, 5), false);
  assert.equal(paperDrawdownReached(0, 0, 5), false);
});
