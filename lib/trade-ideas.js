import { paperPriceLevels } from "./paper-simulation.js";

export function trendExitCondition(close, sma20, rsi14) {
  return close < sma20 || rsi14 > 75;
}

export function tradeIdea(indicators) {
  if (!indicators || ![indicators.close, indicators.sma20, indicators.sma50, indicators.rsi14, indicators.atr14]
    .every(Number.isFinite) || indicators.close <= 0 || indicators.atr14 <= 0 ||
    typeof indicators.entryCondition !== "boolean" || !indicators.latestDate) {
    return { error: "Indicators or ATR are unavailable." };
  }

  const levels = paperPriceLevels(indicators.close, indicators.atr14);
  return {
    buyCondition: indicators.entryCondition,
    sellCondition: trendExitCondition(indicators.close, indicators.sma20, indicators.rsi14),
    close: indicators.close,
    date: indicators.latestDate,
    stopPrice: levels.stopPrice > 0 ? levels.stopPrice : null,
    targetPrice: levels.stopPrice > 0 ? levels.targetPrice : null
  };
}
