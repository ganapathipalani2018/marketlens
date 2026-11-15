# MarketLens — Zerodha Kite Connect

MarketLens is a local-only Node.js trading assistant for live NSE/BSE quotes, read-only account snapshots, transparent technical indicators, historical rule simulations, browser price alerts, paper-trading automation, and explicitly confirmed real CNC limit orders.

## Requirements and setup

- Node.js 20 or newer.
- A Zerodha account and Kite Connect developer app with the required data/trading permissions. Applicable provider fees and exchange permissions are determined by Zerodha.
- Register `http://127.0.0.1:3000/auth/kite/callback` as the app redirect URL.

1. Run `npm install`, then `npm start`.
2. Open `http://127.0.0.1:3000`, select **Setup Kite API**, and enter your developer app's API key and secret (not your Zerodha login password). These are kept in server memory and must be re-entered after a restart.
3. Select **Connect Zerodha** and finish authentication on Zerodha's site. Never share credentials in chat.

Alternatively, copy `.env.example` to `.env` and add `KITE_API_KEY` and `KITE_API_SECRET` there for persistent local configuration. Never share or commit this file. If you change `PORT`, also update `KITE_REDIRECT_URL` and register `http://127.0.0.1:<port>/auth/kite/callback` with Zerodha. An in-app setup replaces configured credentials in memory only, not in `.env`.

The app binds only to `127.0.0.1`. API credentials and access tokens stay server-side; API credentials entered in the setup form and access tokens are held in memory only. Credentials configured via `.env` remain in that local file. Other users on the same computer may be able to access the local app. Reconnect when required. This app does not process deposits/withdrawals or collect bank details. Its account panel links to Zerodha Kite for deposits/withdrawals and Console for linked bank-account management; those actions and any authentication/payment details remain on Zerodha's official sites. The read-only snapshot can show your Kite profile, equity funds/margins, delivery holdings, net and day positions, and today's orders and trades. Refresh the snapshot from the account panel. Kite Connect does not expose every account feature here; historical statements are not included.

## Features

- NSE/BSE market watch, index snapshots, search, watchlist, and sortable day-move/name/indicator-score views.
- Order and alert fields search the available equity list by symbol or company name and show up to 50 suggestions; type more characters to narrow the results.
- Per-equity daily analysis based on SMA 20/50, RSI 14, MACD histogram, and ATR 14. The 0–100 indicator score counts agreement among four specified conditions; it is **not** a probability, forecast, expected-return estimate, or personal buy/sell recommendation.
- The server automatically scans available NSE/BSE equity instruments in alternating exchange order after Kite login, ten instruments per batch with a one-minute pause between batches. It checks completed daily and 5-minute candles using the same SMA/RSI entry rule. The right-side Market candidates panel shows the ten most recently scanned matches per timeframe, scan progress and unavailable counts. A full cycle may take days; matches are not ranked by expected return and can be stale, illiquid or no longer tradable. Inactive and non-company equity instruments can appear. Candle and scan timestamps, a 5-minute staleness warning, and a pause/resume control are provided. Scanning continues while the server is connected, even if the page is closed, and uses Kite historical-data requests. Repeated request failures pause the scan. Example entry is the historical close, target is close + 3 ATR, and stop is close − 1.5 ATR; these are neither forecasts nor guaranteed fills. Verify current price, liquidity, data and suitability independently. Review buttons only populate the manual order ticket; no orders are placed by the scan.
- The right-side buy/sell watch checks watchlist equities for the daily-close entry rule and Zerodha delivery holdings for the daily-close trend-exit rule. It shows a hypothetical stop (close minus 1.5 ATR) and target (close plus 3 ATR), not a forecast or an existing position's actual exit levels. Refresh after holdings change; watchlist changes trigger a new analysis. Data and failures are shown per symbol. Review buttons only populate the manual order ticket; no orders are placed from the list.
- The Jio stocks panel automatically checks NSE:JPL and NSE:JIOFIN using the same daily rules and links their official financials; it refreshes every 15 minutes while the page is open. Analysis dialogs include a daily-close/SMA chart and simulated historical trade markers when available. They are not live order signals.
- Public filing research retrieves and ranks text excerpts from one fixed Q2 FY2026-27 filing per Jio company, with page citations and a retrieval timestamp. The Jio Financial presentation is the company's filing hosted by BSE; the Jio Platforms release is hosted by Jio. These filings are not automatically discovered or necessarily current. PDF text extraction may misread tables; verify each excerpt against the original. Optional AI generation uses these excerpts, not live prices, broker credentials, or account data, and never places orders.
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
- A Zerodha 403 on live or historical data may indicate missing market-data permissions or an invalid session. Check the app's plan and permissions with Zerodha; authentication alone does not grant market-data access. A rejected stream does not terminate MarketLens.
- This is a personal-use prototype with no legal, regulatory, security, or production-readiness review. Do not expose it to the internet or use other people's accounts. Confirm current Zerodha, exchange, and applicable Indian regulatory requirements before using or distributing trading software.

## Development

- `npm test` runs validation tests for order limits, indicators, and historical simulations.
- Official references: [Kite Connect API](https://kite.trade/docs/connect/v3/), [login/session flow](https://kite.trade/docs/connect/v3/user/), [historical candles](https://kite.trade/docs/connect/v3/historical/), [market quotes and instruments](https://kite.trade/docs/connect/v3/market-quotes/), [WebSocket streaming](https://kite.trade/docs/connect/v3/websocket/), [orders](https://kite.trade/docs/connect/v3/orders/), and the [official JavaScript client](https://github.com/zerodha/kiteconnectjs).

### Optional AI filing summaries

Evidence retrieval works without an AI model. To enable summaries, configure `.env` and restart MarketLens:

- Set `RESEARCH_AI_PROVIDER=ollama` and `RESEARCH_OLLAMA_MODEL` to an installed Ollama model. Ollama must run locally on `127.0.0.1:11434`.
- Or set `RESEARCH_AI_PROVIDER=openai`, `OPENAI_MODEL` to an available Responses API model, and `OPENAI_API_KEY` to your own key. Never share or commit the key. OpenAI usage may incur charges.
- `RESEARCH_AI_PROVIDER=auto` tries Ollama and falls back to OpenAI on failure. Configure both sets of variables. The interface displays which provider was used and warns when fallback occurs.

AI generation happens only when you select **Generate AI summary**. OpenAI receives a fixed research prompt, company/filing title, and selected public filing excerpts; no broker account data, market quotes, credentials, or user-entered prompts are included. The API key is sent only to OpenAI for authentication. Summaries can hallucinate, misinterpret financial tables, or cite incorrectly; check the linked primary source. The chosen documents are a narrow, dated snapshot, not an exhaustive investment assessment. Model output is not investment advice and should not be used as an automatic trading instruction.
