import test from "node:test";
import assert from "node:assert/strict";
import { createMarketScanner } from "../lib/market-scanner.js";
import { historicalRange, normalizeCandles } from "../lib/historical-candles.js";

const indicators = {
  latestDate: "2026-11-16T04:30:00.000Z",
  close: 100, sma20: 98, sma50: 95, rsi14: 60, atr14: 2, entryCondition: true
};

function harness(analyze) {
  const jobs = [];
  const scanner = createMarketScanner({
    analyze,
    now: () => 12345,
    schedule: (callback, delay) => { const job = { callback, delay }; jobs.push(job); return job; },
    cancel: job => { const index = jobs.indexOf(job); if (index >= 0) jobs.splice(index, 1); }
  });
  return { scanner, jobs };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("Scanner did not complete the expected work.");
}

test("scanner rotates in bounded batches across both timeframes and can pause", async () => {
  const calls = [];
  const { scanner, jobs } = harness(async (symbol, interval) => {
    calls.push([symbol, interval]);
    return symbol === "S1" && interval === "day" ? { ...indicators, entryCondition: false } : indicators;
  });
  scanner.reset(Array.from({ length: 11 }, (_, i) => `S${i}`));
  scanner.start();
  const first = jobs.shift();
  assert.equal(first.delay, 0);
  first.callback();
  await waitFor(() => jobs.length === 1);
  assert.equal(jobs[0].delay, 60000);
  assert.equal(calls.length, 20);
  assert.equal(scanner.snapshot().completed, 10);
  assert.equal(scanner.snapshot().candidates.day.length, 9);
  assert.equal(scanner.snapshot().candidates["5minute"].length, 10);
  assert.equal(scanner.snapshot().candidates.day[0].targetPrice, 106);
  scanner.stop();
  assert.equal(jobs.length, 0);
  scanner.start();
  jobs.shift().callback();
  await waitFor(() => scanner.snapshot().cycle === 1);
  assert.equal(scanner.snapshot().completed, 0);
  scanner.stop();
});

test("scanner pauses on repeated request failures and reports unavailable data", async () => {
  const { scanner, jobs } = harness(async () => { throw new Error("mock failure"); });
  scanner.reset(["S1", "S2", "S3", "S4"]);
  scanner.start();
  jobs.shift().callback();
  await waitFor(() => !scanner.snapshot().running);
  assert.equal(scanner.snapshot().completed, 3);
  assert.equal(scanner.snapshot().unavailable, 6);
  assert.match(scanner.snapshot().error, /Repeated historical-data requests failed/);
  assert.match(scanner.snapshot().lastIssue, /S3/);
  assert.equal(jobs.length, 0);
});

test("stopping a scan discards an in-flight result", async () => {
  let resolveAnalysis;
  const { scanner, jobs } = harness(() => new Promise(resolve => { resolveAnalysis = resolve; }));
  scanner.reset(["S1"]);
  scanner.start();
  jobs.shift().callback();
  assert.equal(scanner.snapshot().current, "S1");
  scanner.stop();
  resolveAnalysis(indicators);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(scanner.snapshot().completed, 0);
  assert.deepEqual(scanner.snapshot().candidates.day, []);
  assert.equal(jobs.length, 0);
});

test("historical ranges and timestamps use IST and exclude the incomplete 5-minute candle", () => {
  const now = Date.parse("2026-11-16T04:42:00Z");
  assert.equal(historicalRange("day", now).to, "2026-11-15 23:59:59");
  assert.equal(historicalRange("5minute", now).to, "2026-11-16 10:12:00");
  const bar = date => ({ date, open: 100, high: 102, low: 99, close: 101, volume: 5 });
  const daily = normalizeCandles([bar(new Date("2026-11-15T18:30:00Z"))], "day", now);
  assert.equal(daily[0].date, "2026-11-16");
  const intraday = normalizeCandles([
    bar("2026-11-16T10:05:00+05:30"),
    bar("2026-11-16T10:10:00+05:30")
  ], "5minute", now);
  assert.equal(intraday.length, 1);
  assert.equal(intraday[0].date, "2026-11-16T04:35:00.000Z");
  assert.throws(() => normalizeCandles([bar(null)], "day", now), /invalid timestamp/);
});
