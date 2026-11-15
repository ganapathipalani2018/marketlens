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
