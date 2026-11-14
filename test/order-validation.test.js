import test from "node:test";
import assert from "node:assert/strict";
import { validateOrderRequest } from "../lib/order-validation.js";

const instrument = {
  exchange: "NSE",
  tradingsymbol: "INFY",
  instrument_type: "EQ",
  isEquity: true,
  tick_size: 0.05
};

test("valid equity limit order is constrained to CNC and DAY", () => {
  const result = validateOrderRequest({ transactionType: "BUY", quantity: 3, price: 1500.1 }, instrument);
  assert.deepEqual(result.order, {
    exchange: "NSE",
    tradingsymbol: "INFY",
    transaction_type: "BUY",
    quantity: 3,
    product: "CNC",
    order_type: "LIMIT",
    price: 1500.1,
    validity: "DAY",
    tag: "MLENS"
  });
});

test("rejects non-equities, market orders, fractional or excessive quantities, and off-tick prices", () => {
  assert.match(validateOrderRequest({ transactionType: "BUY", quantity: 1, price: 100 }, { ...instrument, instrument_type: "FUT" }).error, /equity/);
  assert.match(validateOrderRequest({ transactionType: "MARKET", quantity: 1, price: 100 }, instrument).error, /BUY or SELL/);
  assert.match(validateOrderRequest({ transactionType: "BUY", quantity: 1.5, price: 100 }, instrument).error, /whole number/);
  assert.match(validateOrderRequest({ transactionType: "BUY", quantity: 10001, price: 100 }, instrument).error, /10,000/);
  assert.match(validateOrderRequest({ transactionType: "BUY", quantity: 1, price: 100.03 }, instrument).error, /tick size/);
});
