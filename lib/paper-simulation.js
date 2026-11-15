export function paperPriceLevels(price, atr) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(atr) || atr <= 0) {
    return { error: "Price and ATR must be positive." };
  }
  const stopDistance = atr * 1.5;
  return { stopPrice: price - stopDistance, targetPrice: price + 2 * stopDistance };
}

export function calculatePaperOrder({
  equity,
  cash,
  price,
  atr,
  riskPct,
  allocationPct
}) {
  const values = [equity, cash, price, atr, riskPct, allocationPct];
  if (!values.every(Number.isFinite) || equity <= 0 || cash < 0 || price <= 0 || atr <= 0 ||
      riskPct < 0.1 || riskPct > 1 || allocationPct < 1 || allocationPct > 20) {
    return { error: "Paper order inputs are invalid or exceed configured risk limits." };
  }

  const stopDistance = atr * 1.5;
  const levels = paperPriceLevels(price, atr);
  const riskBudget = equity * riskPct / 100;
  const allocationLimit = equity * allocationPct / 100;
  const quantity = Math.floor(Math.min(
    riskBudget / stopDistance,
    allocationLimit / price,
    cash / price
  ));
  if (quantity < 1) return { error: "Available paper cash or risk budget is too small for one share." };

  return {
    quantity,
    cost: quantity * price,
    ...levels
  };
}

export function paperExitReason(price, position, sma20) {
  if (!Number.isFinite(price) || !position) return "";
  if (price <= position.stopPrice) return "ATR stop";
  if (price >= position.targetPrice) return "2R target";
  if (Number.isFinite(sma20) && price < sma20) return "Trend exit";
  return "";
}

export function paperDrawdownReached(peakEquity, currentEquity, maxDrawdownPct) {
  if (![peakEquity, currentEquity, maxDrawdownPct].every(Number.isFinite) ||
      peakEquity <= 0 || currentEquity < 0 || maxDrawdownPct <= 0) return false;
  return (peakEquity - currentEquity) / peakEquity * 100 >= maxDrawdownPct;
}
