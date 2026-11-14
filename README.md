# MarketLens — Zerodha Kite Connect

MarketLens is a local-only Node.js trading assistant for live NSE/BSE quotes, read-only account snapshots, transparent technical indicators, historical rule simulations, browser price alerts, paper-trading automation, and explicitly confirmed real CNC limit orders.

## Requirements and setup

- Node.js 20 or newer.
- A Zerodha account and Kite Connect developer app with the required data/trading permissions. Applicable provider fees and exchange permissions are determined by Zerodha.
- Register `http://127.0.0.1:3000/auth/kite/callback` as the app redirect URL.

1. Copy `.env.example` to `.env`.
2. Add `KITE_API_KEY` and `KITE_API_SECRET` to `.env`. Never share or commit this file.
3. If you change `PORT`, also update `KITE_REDIRECT_URL` and register `http://127.0.0.1:<port>/auth/kite/callback` with Zerodha.
4. Run `npm install`, then `npm start`.
5. Open `http://127.0.0.1:3000` and select **Connect Zerodha**. Finish authentication on Zerodha's site.

The app binds only to `127.0.0.1`. API credentials and access tokens stay server-side and in memory; reconnect when required. This app does not process deposits/withdrawals or collect bank details. Its account panel links to Zerodha Kite for deposits/withdrawals and Console for linked bank-account management; those actions and any authentication/payment details remain on Zerodha's official sites. The read-only snapshot can show your Kite profile, equity funds/margins, delivery holdings, net and day positions, and today's orders and trades. Refresh the snapshot from the account panel. Kite Connect does not expose every account feature here; historical statements are not included.

## Features

- NSE/BSE market watch, index snapshots, search, watchlist, and sortable day-move/name/indicator-score views.
- Per-equity daily analysis based on SMA 20/50, RSI 14, MACD histogram, and ATR 14. The 0–100 indicator score counts agreement among four specified conditions; it is **not** a probability, forecast, expected-return estimate, or personal buy/sell recommendation.
- Historical daily-rule simulation with return, trade count, win rate, and maximum drawdown metrics.
- A browser-local paper portfolio that can automatically simulate trades against the connected live quote stream. It uses watchlist symbols, historical indicators, bounded per-trade risk/allocation settings, ATR-based simulated exits, and a drawdown pause. It never submits paper orders to Zerodha.
- Browser-local live-price alerts. The browser/app must remain open and connected to check them; they are not broker-side alerts and do not place orders.
- A risk/position-size calculator and a real-order flow restricted to CNC/LIMIT/DAY NSE/BSE equities. Every real order requires review, a checkbox, and typing `PLACE ORDER`.

## Important limitations

- **No trading strategy can guarantee profits, prevent losses, or identify the “perfect” stock.** Technical indicators are historical summaries, not reliable predictions. Use your own research and risk judgment.
- Automated execution is intentionally **paper-only**. Real-money buys and sells are never sent automatically. The live order ticket requires explicit confirmation for every order.
- Add/withdraw money and manage linked banks on Zerodha's official sites, not in MarketLens. The account snapshot does not reserve funds, verify buying power at order fill, or guarantee an order can execute.
- Historical simulation is a simple daily-close example, not a validated or optimized strategy. It can suffer from overfitting and excludes fees, taxes, slippage, liquidity limits, corporate actions, and execution delays. Past results do not predict future performance.
- Paper fills are estimates using observed live quote ticks, not actual executable prices. Paper trading does not replicate broker behavior, fees, or market impact.
- Live quotes and historical data depend on your Kite Connect access, entitlements, exchange hours, and network. Check quote timestamps and verify all orders and fills in Kite.
- This is a personal-use prototype with no legal, regulatory, security, or production-readiness review. Do not expose it to the internet or use other people's accounts. Confirm current Zerodha, exchange, and applicable Indian regulatory requirements before using or distributing trading software.

## Development

- `npm test` runs validation tests for order limits, indicators, and historical simulations.
- Official references: [Kite Connect API](https://kite.trade/docs/connect/v3/), [login/session flow](https://kite.trade/docs/connect/v3/user/), [historical candles](https://kite.trade/docs/connect/v3/historical/), [market quotes and instruments](https://kite.trade/docs/connect/v3/market-quotes/), [WebSocket streaming](https://kite.trade/docs/connect/v3/websocket/), [orders](https://kite.trade/docs/connect/v3/orders/), and the [official JavaScript client](https://github.com/zerodha/kiteconnectjs).
