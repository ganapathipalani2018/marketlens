import { trendExitCondition } from "./trade-ideas.js";

function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function simpleMovingAverage(values, period, index) {
  if (index + 1 < period) return null;
  return average(values.slice(index + 1 - period, index + 1));
}

function calculateRsi(closes, index, period = 14) {
  if (index < period) return null;
  let gains = 0;
  let losses = 0;
  for (let cursor = 1; cursor <= period; cursor += 1) {
    const change = closes[cursor] - closes[cursor - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let cursor = period + 1; cursor <= index; cursor += 1) {
    const change = closes[cursor] - closes[cursor - 1];
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function calculateAtr(candles, index, period = 14) {
  if (index < period) return null;
  const ranges = [];
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const candle = candles[cursor];
    const previousClose = candles[cursor - 1].close;
    ranges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    ));
  }
  return average(ranges);
}

function calculateMacd(closes, index) {
  if (index < 34) return null;
  let fast = closes[0];
  let slow = closes[0];
  let signal = 0;
  const macdValues = [];
  for (let cursor = 1; cursor <= index; cursor += 1) {
    fast = closes[cursor] * (2 / 13) + fast * (1 - 2 / 13);
    slow = closes[cursor] * (2 / 27) + slow * (1 - 2 / 27);
    macdValues.push(fast - slow);
    if (macdValues.length === 1) signal = macdValues[0];
    else signal = macdValues[macdValues.length - 1] * (2 / 10) + signal * (1 - 2 / 10);
  }
  const value = macdValues.at(-1);
  return { value, signal, histogram: value - signal };
}

export function calculateIndicators(candles) {
  if (!Array.isArray(candles) || candles.length < 50) {
    return { error: "At least 50 candles are required for these indicators." };
  }
  const valid = candles.every(candle =>
    Number.isFinite(candle.open) && Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) && Number.isFinite(candle.close) &&
    candle.high >= candle.low && candle.close > 0
  );
  if (!valid) return { error: "Historical candle data contains invalid prices." };

  const index = candles.length - 1;
  const closes = candles.map(candle => candle.close);
  const close = closes[index];
  const sma20 = simpleMovingAverage(closes, 20, index);
  const sma50 = simpleMovingAverage(closes, 50, index);
  const rsi14 = calculateRsi(closes, index);
  const atr14 = calculateAtr(candles, index);
  const macd = calculateMacd(closes, index);
  const components = {
    priceAboveSma20: close > sma20,
    sma20AboveSma50: sma20 > sma50,
    macdPositive: macd.histogram > 0,
    rsiInNeutralRange: rsi14 >= 45 && rsi14 <= 70
  };
  const score = Object.values(components).filter(Boolean).length * 25;
  const trend = close > sma20 && sma20 > sma50 ? "Uptrend" : close < sma20 && sma20 < sma50 ? "Downtrend" : "Mixed";

  return {
    latestDate: candles[index].date,
    close,
    sma20,
    sma50,
    rsi14,
    atr14,
    macd,
    score,
    trend,
    components,
    entryCondition: components.priceAboveSma20 && components.sma20AboveSma50 && components.rsiInNeutralRange
  };
}

export function backtestTrendStrategy(candles, startingCapital = 100000) {
  if (!Number.isFinite(startingCapital) || startingCapital <= 0) {
    return { error: "Starting capital must be greater than zero." };
  }
  if (!Array.isArray(candles) || candles.length < 60) {
    return { error: "At least 60 daily candles are required for a basic historical simulation." };
  }

  const closes = candles.map(candle => candle.close);
  const trades = [];
  const equityCurve = [];
  let position = null;
  let realized = 0;
  let peakEquity = startingCapital;
  let maxDrawdownPct = 0;

  for (let index = 50; index < candles.length; index += 1) {
    const candle = candles[index];
    const sma20 = simpleMovingAverage(closes, 20, index);
    const sma50 = simpleMovingAverage(closes, 50, index);
    const rsi14 = calculateRsi(closes, index);
    const atr14 = calculateAtr(candles, index);

    if (position) {
      let exitPrice = null;
      let exitReason = "";
      if (candle.low <= position.stopPrice) {
        exitPrice = position.stopPrice;
        exitReason = "ATR stop";
      } else if (candle.high >= position.targetPrice) {
        exitPrice = position.targetPrice;
        exitReason = "2R target";
      } else if (trendExitCondition(candle.close, sma20, rsi14)) {
        exitPrice = candle.close;
        exitReason = "Trend exit";
      }

      if (exitPrice !== null) {
        const pnl = (exitPrice - position.entryPrice) * position.quantity;
        realized += pnl;
        trades.push({
          entryDate: position.entryDate,
          exitDate: candle.date,
          entryPrice: position.entryPrice,
          exitPrice,
          quantity: position.quantity,
          pnl,
          exitReason
        });
        position = null;
      }
    }

    if (!position && atr14 > 0 && closes[index] > sma20 && sma20 > sma50 && rsi14 >= 45 && rsi14 <= 70) {
      const entryPrice = candle.close;
      const stopPrice = entryPrice - 1.5 * atr14;
      const riskBudget = Math.max(0, startingCapital + realized) * 0.01;
      const maxPositionValue = Math.max(0, startingCapital + realized) * 0.2;
      const quantity = Math.floor(Math.min(riskBudget / (entryPrice - stopPrice), maxPositionValue / entryPrice));
      if (quantity > 0) {
        position = {
          entryDate: candle.date,
          entryPrice,
          quantity,
          stopPrice,
          targetPrice: entryPrice + 2 * (entryPrice - stopPrice)
        };
      }
    }

    const openPnl = position ? (candle.close - position.entryPrice) * position.quantity : 0;
    const equity = startingCapital + realized + openPnl;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peakEquity - equity) / peakEquity * 100);
    equityCurve.push({ date: candle.date, equity });
  }

  const wins = trades.filter(trade => trade.pnl > 0).length;
  const losses = trades.length - wins;
  const grossProfit = trades.reduce((total, trade) => total + Math.max(0, trade.pnl), 0);
  const grossLoss = Math.abs(trades.reduce((total, trade) => total + Math.min(0, trade.pnl), 0));
  const lastClose = candles.at(-1).close;
  const openPnl = position ? (lastClose - position.entryPrice) * position.quantity : 0;
  const finalEquity = startingCapital + realized + openPnl;

  return {
    startingCapital,
    finalEquity,
    totalReturnPct: (finalEquity - startingCapital) / startingCapital * 100,
    maxDrawdownPct,
    tradeCount: trades.length,
    winRatePct: trades.length ? wins / trades.length * 100 : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? null : 0,
    openPosition: position ? { ...position, lastClose, unrealizedPnl: openPnl } : null,
    trades,
    equityCurve,
    startDate: candles[50].date,
    endDate: candles.at(-1).date,
    assumptions: "Daily-close simulation, 1% equity risk per trade, 20% max allocation, 1.5 ATR stop, 2R target. Excludes fees, taxes, slippage, liquidity, corporate actions, and execution delays."
  };
}
