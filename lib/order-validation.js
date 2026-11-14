export function validateOrderRequest(body, instrument) {
  if (!instrument || !instrument.isEquity || instrument.instrument_type !== "EQ" || !["NSE", "BSE"].includes(instrument.exchange)) {
    return { error: "Choose an available NSE or BSE equity instrument." };
  }

  const transactionType = body?.transactionType;
  const quantity = Number(body?.quantity);
  const price = Number(body?.price);
  const tickSize = Number(instrument.tick_size);

  if (!["BUY", "SELL"].includes(transactionType)) {
    return { error: "Choose BUY or SELL." };
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) {
    return { error: "Quantity must be a whole number from 1 to 10,000 shares." };
  }
  if (!Number.isFinite(price) || price <= 0 || price > 10000000) {
    return { error: "Enter a valid limit price greater than zero." };
  }
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    return { error: "The instrument tick size is unavailable." };
  }
  const ticks = price / tickSize;
  if (Math.abs(ticks - Math.round(ticks)) > 1e-7) {
    return { error: `Price must be a multiple of the ₹${tickSize} tick size.` };
  }

  return {
    order: {
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      transaction_type: transactionType,
      quantity,
      product: "CNC",
      order_type: "LIMIT",
      price,
      validity: "DAY",
      tag: "MLENS"
    }
  };
}
