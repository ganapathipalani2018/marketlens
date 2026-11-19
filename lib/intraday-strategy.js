import { calculateIndicators } from "./market-analysis.js";
import { paperPriceLevels } from "./paper-simulation.js";
import { trendExitCondition } from "./trade-ideas.js";

const candleMs = 5 * 60 * 1000;
const istOffsetMs = 330 * 60 * 1000;

export function intradaySessionTime(now) {
  const ist = new Date(now + istOffsetMs);
  const weekday = ist.getUTCDay();
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return weekday >= 1 && weekday <= 5 && minute >= 9 * 60 + 15 && minute < 15 * 60 + 30;
}

export function evaluateIntraday({ candles, tick, now, connected, entryPrice = "" }) {
  if (!intradaySessionTime(now)) {
    return { error: "Outside regular NSE/BSE market hours. Live conditions are paused." };
  }
  if (!connected) return { error: "Live stream unavailable. Waiting for the chart subscription." };
  if (!tick || !Number.isFinite(tick.receivedAt) || now < tick.receivedAt || now - tick.receivedAt > 30000 ||
      !Number.isFinite(tick.price) || tick.price <= 0 || tick.price > Number.MAX_SAFE_INTEGER) {
    return { error: "Waiting for a recent live price update; the last quote may be stale." };
  }
  if (tick.sourceAt != null && (!Number.isFinite(tick.sourceAt) || tick.sourceAt > now + 5000 || now - tick.sourceAt > 30000)) {
    return { error: "The broker's quote timestamp is stale or invalid; waiting for a recent quote." };
  }
  const currentStart = Math.floor(now / candleMs) * candleMs;
  if (tick.start !== currentStart || ![tick.open, tick.high, tick.low].every(Number.isFinite) ||
      tick.low <= 0 || tick.high < tick.low || tick.price < tick.low || tick.price > tick.high) {
    return { error: "Waiting for a live price in the current 5-minute candle." };
  }
  if (!Array.isArray(candles) || candles.length < 50 ||
      Date.parse(candles.at(-1)?.date) !== currentStart - candleMs) {
    return { error: "Waiting for the latest completed 5-minute candle; historical data may be delayed." };
  }
  const completed = calculateIndicators(candles);
  if (completed.error) return { error: completed.error };
  if (!Number.isFinite(completed.atr14) || completed.atr14 <= 0) {
    return { error: "The latest completed 5-minute ATR is unavailable." };
  }
  const partial = { date: new Date(currentStart).toISOString(), open: tick.open, high: tick.high, low: tick.low, close: tick.price };
  const indicators = calculateIndicators([...candles, partial]);
  if (indicators.error) return { error: indicators.error };
  if (![indicators.sma20, indicators.sma50, indicators.rsi14].every(Number.isFinite)) {
    return { error: "Intraday indicators are unavailable." };
  }

  let levels = null;
  let entryError = "";
  if (entryPrice !== "") {
    const entry = Number(entryPrice);
    if (!Number.isFinite(entry) || entry <= 0 || entry > Number.MAX_SAFE_INTEGER) {
      entryError = "Enter a valid buy price above zero.";
    } else {
      const calculated = paperPriceLevels(entry, completed.atr14);
      if (calculated.error || ![calculated.stopPrice, calculated.targetPrice].every(Number.isFinite) || calculated.stopPrice <= 0) {
        entryError = "Valid positive example levels cannot be calculated from this buy price and ATR.";
      } else {
        levels = calculated;
      }
    }
  }
  const reasons = [];
  if (trendExitCondition(tick.price, indicators.sma20, indicators.rsi14)) reasons.push("Trend exit rule met");
  if (levels && tick.price <= levels.stopPrice) reasons.push("Example stop reached");
  if (levels && tick.price >= levels.targetPrice) reasons.push("Example target reached");
  return {
    buy: indicators.entryCondition,
    sell: reasons.length > 0,
    reasons,
    levels,
    entryError,
    atr: completed.atr14,
    price: tick.price,
    receivedAt: tick.receivedAt,
    candleStart: currentStart,
    points: [...candles.slice(-30).map(candle => ({ time: Date.parse(candle.date), price: candle.close })),
      { time: tick.receivedAt, price: tick.price }]
  };
}
