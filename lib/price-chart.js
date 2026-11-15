export function buildPriceChart(candles, backtest) {
  if (!Array.isArray(candles) || candles.length < 50 || candles.some(candle =>
    !/^\d{4}-\d{2}-\d{2}$/.test(candle.date) ||
    !Number.isFinite(candle.close) || candle.close <= 0
  )) {
    return { error: "At least 50 valid dated daily closes are required for the chart." };
  }
  const first = Math.max(0, candles.length - 90);
  const points = candles.slice(first).map((candle, index) => {
    const end = first + index + 1;
    const average = period => end >= period
      ? candles.slice(end - period, end).reduce((sum, item) => sum + item.close, 0) / period
      : null;
    return { date: candle.date, close: candle.close, sma20: average(20), sma50: average(50) };
  });
  const dates = new Map(points.map((point, index) => [point.date, index]));
  const markers = [];
  const addMarker = (date, price, side) => {
    if (dates.has(date) && Number.isFinite(price) && price > 0) {
      markers.push({ index: dates.get(date), price, side, date });
    }
  };
  if (backtest && !backtest.error) {
    for (const trade of backtest.trades || []) {
      addMarker(trade.entryDate, trade.entryPrice, "buy");
      addMarker(trade.exitDate, trade.exitPrice, "sell");
    }
    if (backtest.openPosition) {
      addMarker(backtest.openPosition.entryDate, backtest.openPosition.entryPrice, "buy");
    }
  }
  const values = points.flatMap(point => [point.close, point.sma20, point.sma50].filter(Number.isFinite));
  values.push(...markers.map(marker => marker.price));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.1, max * 0.005);
  return { points, markers, min: Math.max(0, min - padding), max: max + padding };
}
