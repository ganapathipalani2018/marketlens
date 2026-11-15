const istOffset = 330 * 60 * 1000;

function istDateTime(time) {
  return new Date(time + istOffset).toISOString().slice(0, 19).replace("T", " ");
}

export function historicalRange(interval, now = Date.now()) {
  const today = istDateTime(now).slice(0, 10);
  if (interval === "day") {
    const end = new Date(`${today}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 180);
    return { from: `${start.toISOString().slice(0, 10)} 00:00:00`, to: `${end.toISOString().slice(0, 10)} 23:59:59` };
  }
  if (interval === "5minute") {
    return { from: `${istDateTime(now - 10 * 86400000).slice(0, 10)} 00:00:00`, to: istDateTime(now) };
  }
  throw new Error("Unsupported candle interval.");
}

export function normalizeCandles(history, interval, now = Date.now()) {
  if (!Array.isArray(history)) throw new Error("Historical candle data is unavailable.");
  return history.map(candle => {
    if (!candle || !candle.date) throw new Error("Historical candle data contains an invalid timestamp.");
    const time = new Date(candle.date).getTime();
    if (!Number.isFinite(time)) throw new Error("Historical candle data contains an invalid timestamp.");
    return {
      time,
      date: interval === "day" ? istDateTime(time).slice(0, 10) : new Date(time).toISOString(),
      open: Number(candle.open), high: Number(candle.high),
      low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume || 0)
    };
  }).filter(candle => (interval !== "5minute" || candle.time + 5 * 60000 <= now) &&
    Number.isFinite(candle.open) && Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) && Number.isFinite(candle.close))
    .map(({ time, ...candle }) => candle);
}
