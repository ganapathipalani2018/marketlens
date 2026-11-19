import test from "node:test";
import assert from "node:assert/strict";
import { buildPriceChart } from "../lib/price-chart.js";

function candles(count) {
  return Array.from({ length: count }, (_value, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    close: 100 + index
  }));
}

test("chart uses the latest 90 closes while calculating moving averages from earlier data", () => {
  const chart = buildPriceChart(candles(120));
  assert.equal(chart.points.length, 90);
  assert.equal(chart.points[0].close, 130);
  assert.equal(chart.points[0].sma20, 120.5);
  assert.equal(chart.points[0].sma50, null);
  assert.equal(chart.points[19].sma50, 124.5);
  assert.ok(chart.min < 120.5);
  assert.ok(chart.max > 219);
});

test("chart marks only visible simulated trades and includes marker prices in the scale", () => {
  const history = candles(120);
  const chart = buildPriceChart(history, {
    trades: [
      { entryDate: history[0].date, entryPrice: 100, exitDate: history[31].date, exitPrice: 120 },
      { entryDate: history[60].date, entryPrice: 160, exitDate: history[70].date, exitPrice: 300 }
    ],
    openPosition: { entryDate: history[100].date, entryPrice: 200 }
  });
  assert.deepEqual(chart.markers.map(marker => [marker.index, marker.side]), [[1, "sell"], [30, "buy"], [40, "sell"], [70, "buy"]]);
  assert.ok(chart.max > 300);
  assert.ok(chart.min < 120);
});

test("chart refuses invalid history and handles a flat price range", () => {
  assert.match(buildPriceChart(candles(49)).error, /50 valid/);
  const invalid = candles(50);
  invalid[0].date = "<script>";
  assert.match(buildPriceChart(invalid).error, /valid dated/);
  const flat = candles(50).map(candle => ({ ...candle, close: 100 }));
  const chart = buildPriceChart(flat, { error: "No backtest" });
  assert.ok(chart.max > chart.min);
  assert.deepEqual(chart.markers, []);
});

test("chart highlights the latest matching rule condition separately from simulated trades", () => {
  const history = candles(60);
  const latest = history.at(-1);
  const idea = { date: latest.date, close: latest.close, buyCondition: true, sellCondition: false };
  const chart = buildPriceChart(history, null, idea);
  assert.deepEqual(chart.condition, { index: 59, date: latest.date, price: latest.close, buy: true, sell: false });
  assert.deepEqual(chart.markers, []);
  assert.equal(buildPriceChart(history, null, { ...idea, buyCondition: false, sellCondition: true }).condition.sell, true);
  assert.deepEqual(
    buildPriceChart(history, null, { ...idea, buyCondition: false }).condition,
    { index: 59, date: latest.date, price: latest.close, buy: false, sell: false }
  );
});

test("chart does not display mismatched or unavailable conditions as current", () => {
  const history = candles(60);
  const idea = { date: history.at(-2).date, close: history.at(-1).close, buyCondition: true, sellCondition: false };
  assert.match(buildPriceChart(history, null, idea).condition.error, /unavailable/);
  assert.match(buildPriceChart(history, null, { ...idea, date: history.at(-1).date, close: 1 }).condition.error, /unavailable/);
  assert.equal(buildPriceChart(history, null, { error: "Indicators unavailable." }).condition.error, "Indicators unavailable.");
});

test("chart ranges retain earlier data for averages and show only visible simulated trades", () => {
  const history = candles(120);
  const backtest = { trades: [{ entryDate: history[60].date, entryPrice: 160, exitDate: history[100].date, exitPrice: 200 }] };
  const chart = buildPriceChart(history, backtest, null, 30);
  assert.equal(chart.points.length, 30);
  assert.equal(chart.points[0].sma50, 165.5);
  assert.deepEqual(chart.markers.map(marker => [marker.index, marker.side]), [[10, "sell"]]);
  assert.equal(buildPriceChart(history, backtest, null, 60).points.length, 60);
  assert.equal(buildPriceChart(history.slice(0, 50), null, null, 90).points.length, 50);
  assert.match(buildPriceChart(history, null, null, 0).error, /chart range/);
});

test("chart preserves simulated exit reasons and orders a same-day sell before the next buy", () => {
  const history = candles(120);
  const chart = buildPriceChart(history, {
    trades: [
      { entryDate: history[60].date, entryPrice: 160, exitDate: history[80].date, exitPrice: 175, exitReason: "ATR stop" },
      { entryDate: history[80].date, entryPrice: 180, exitDate: history[95].date, exitPrice: 195, exitReason: "2R target" }
    ],
    openPosition: { entryDate: history[100].date, entryPrice: 200 }
  });
  assert.deepEqual(chart.markers.map(({ side, date, reason }) => [side, date, reason]), [
    ["buy", history[60].date, "Entry rule"],
    ["sell", history[80].date, "ATR stop"],
    ["buy", history[80].date, "Entry rule"],
    ["sell", history[95].date, "2R target"],
    ["buy", history[100].date, "Entry rule"]
  ]);
  const missingReason = buildPriceChart(history, {
    trades: [{ exitDate: history[80].date, exitPrice: 180 }]
  });
  assert.equal(missingReason.markers[0].reason, "Exit reason unavailable");
});
