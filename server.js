import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import { KiteConnect, KiteTicker } from "kiteconnect";
import { WebSocket, WebSocketServer } from "ws";
import { validateOrderRequest } from "./lib/order-validation.js";
import { backtestTrendStrategy, calculateIndicators } from "./lib/market-analysis.js";
import { createResearchService } from "./lib/research.js";
import { createMarketScanner } from "./lib/market-scanner.js";
import { historicalRange, normalizeCandles } from "./lib/historical-candles.js";
import { createMarketSubscriptions } from "./lib/market-subscriptions.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const expectedRedirectUrl = `http://${host}:${port}/auth/kite/callback`;
const redirectUrl = process.env.KITE_REDIRECT_URL || expectedRedirectUrl;
let apiKey = process.env.KITE_API_KEY;
let apiSecret = process.env.KITE_API_SECRET;
const origin = `http://${host}:${port}`;
const app = express();
const httpServer = app.listen(port, host, () => {
  console.log(`MarketLens running at ${origin}`);
  if (!apiKey || !apiSecret) console.log("Use Setup Kite API in MarketLens or add Kite API credentials to .env.");
});
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });

let kite = null;
let ticker = null;
let tickerReconnectTimer = null;
let connected = false;
let tickerError = null;
let instruments = [];
let instrumentsByKey = new Map();
const defaultSubscribedKeys = [
  "NSE:NIFTY 50", "NSE:NIFTY BANK", "NSE:NIFTY IT", "BSE:SENSEX",
  "NSE:RELIANCE", "NSE:TCS", "NSE:INFY", "NSE:HDFCBANK",
  "NSE:ICICIBANK", "NSE:SBIN", "NSE:ITC", "NSE:LT"
];
const subscriptions = createMarketSubscriptions(defaultSubscribedKeys);
let loginState = null;
let loginStateExpires = 0;
let loginInProgress = false;
const pendingOrders = new Map();
const marketSocketClients = new Set();
const analysisCache = new Map();
let historyQueue = Promise.resolve();
let lastHistoryRequestAt = 0;
const scanner = createMarketScanner({ analyze: async (key, interval) => (await loadAnalysis(key, interval)).indicators });
const researchService = createResearchService();
let userSummary = null;

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", `ws://${host}:${port}`],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", "https://kite.zerodha.com"]
    }
  },
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  referrerPolicy: { policy: "no-referrer" }
}));
app.use(express.json({ limit: "8kb" }));

function configured() {
  return Boolean(apiKey && apiSecret && redirectUrl === expectedRedirectUrl);
}

function requireSameOrigin(req, res, next) {
  if (req.get("origin") !== origin) {
    return res.status(403).json({ error: "Request origin rejected. Open MarketLens at its local address." });
  }
  next();
}

function requireSession(req, res, next) {
  if (!kite) return res.status(401).json({ error: "Connect your Zerodha account first." });
  next();
}

function clientError(res, error) {
  const message = error?.message || "The Kite Connect request failed.";
  console.error("Kite Connect request failed:", message);
  const status = Number(error?.status) === 403 ? 403 : 502;
  res.status(status).json({ error: message });
}

function stopTicker() {
  clearTimeout(tickerReconnectTimer);
  tickerReconnectTimer = null;
  const previousTicker = ticker;
  ticker = null;
  if (previousTicker) {
    try {
      previousTicker.disconnect();
    } catch (error) {
      console.warn("Could not close the Kite market-data connection.", error?.message || error);
    }
  }
  connected = false;
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of marketSocketClients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

function startTicker(accessToken) {
  stopTicker();
  const tokens = [...subscriptions.keys()].map(key => instrumentsByKey.get(key)?.instrument_token).filter(Boolean);
  if (!tokens.length) {
    tickerError = "No NSE/BSE equity instruments are available to stream.";
    return;
  }

  tickerError = null;
  let reconnectAttempts = 0;
  let lastStreamError = "";
  let permissionRejected = false;
  const activeTicker = new KiteTicker({ api_key: apiKey, access_token: accessToken, reconnect: false });
  ticker = activeTicker;
  activeTicker.on("connect", () => {
    if (ticker !== activeTicker) return;
    connected = true;
    reconnectAttempts = 0;
    lastStreamError = "";
    tickerError = null;
    const currentTokens = [...subscriptions.keys()].map(key => instrumentsByKey.get(key)?.instrument_token).filter(Boolean);
    if (currentTokens.length) {
      activeTicker.subscribe(currentTokens);
      activeTicker.setMode(activeTicker.modeQuote, currentTokens);
    }
    broadcast({ type: "status", connected: true });
  });
  activeTicker.on("ticks", ticks => {
    if (ticker !== activeTicker) return;
    broadcast({
      type: "ticks",
      data: ticks.map(tick => ({
        token: tick.instrument_token,
        price: tick.last_price,
        change: tick.change,
        ohlc: tick.ohlc ? { open: tick.ohlc.open, high: tick.ohlc.high, low: tick.ohlc.low, close: tick.ohlc.close } : null,
        timestamp: tick.timestamp || tick.last_trade_time || null
      }))
    });
  });
  activeTicker.on("disconnect", error => {
    if (ticker !== activeTicker) return;
    connected = false;
    tickerError = lastStreamError || error?.message || "Market-data connection disconnected.";
    if (!permissionRejected && reconnectAttempts < 5) {
      const delay = 1000 * 2 ** reconnectAttempts;
      reconnectAttempts += 1;
      tickerReconnectTimer = setTimeout(() => {
        tickerReconnectTimer = null;
        if (ticker === activeTicker) {
          lastStreamError = "";
          try {
            activeTicker.connect();
          } catch (error) {
            tickerError = `Market-data reconnect failed: ${error?.message || "Unknown error"}. Reconnect Zerodha to retry.`;
            console.error(tickerError);
            broadcast({ type: "status", connected: false, error: tickerError });
          }
        }
      }, delay);
    } else if (!permissionRejected) {
      tickerError += " Automatic retries exhausted; reconnect Zerodha to retry.";
    }
    broadcast({ type: "status", connected: false, error: tickerError });
  });
  activeTicker.on("error", error => {
    if (ticker !== activeTicker) return;
    connected = false;
    const message = error?.message || "Market-data connection error.";
    permissionRejected = /unexpected server response:\s*403\b/i.test(message);
    lastStreamError = permissionRejected
      ? "Zerodha rejected market data (403). Check your Kite Connect plan, permissions and session, then reconnect."
      : message;
    tickerError = lastStreamError;
    broadcast({ type: "status", connected: false, error: tickerError });
    console.error("Kite market-data stream error:", tickerError);
  });
  activeTicker.connect();
}

function closeWebSocket(client) {
  marketSocketClients.delete(client);
  client.close();
}

function updateTickerSubscriptions({ added, removed }) {
  if (!ticker || !connected) return;
  const removedTokens = removed.map(key => instrumentsByKey.get(key)?.instrument_token).filter(Boolean);
  const addedTokens = added.map(key => instrumentsByKey.get(key)?.instrument_token).filter(Boolean);
  if (removedTokens.length) ticker.unsubscribe(removedTokens);
  if (addedTokens.length) {
    ticker.subscribe(addedTokens);
    ticker.setMode(ticker.modeQuote, addedTokens);
  }
}

app.get("/api/status", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    configured: configured(),
    authenticated: Boolean(kite),
    connected,
    error: tickerError,
    profile: userSummary,
    instrumentCount: instruments.length,
    liveOrdersEnabled: Boolean(kite),
    redirectUrl
  });
});

app.post("/api/research", requireSameOrigin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { symbol, generate } = req.body || {};
  if (!["NSE:JPL", "NSE:JIOFIN"].includes(symbol) || typeof generate !== "boolean") {
    return res.status(400).json({ error: "Select a supported Jio stock and research action." });
  }
  try {
    res.json(await researchService.research(symbol, generate));
  } catch (error) {
    console.error("Filing research failed:", error.message);
    res.status(502).json({ error: error.message || "Filing research failed." });
  }
});

app.post("/api/setup", requireSameOrigin, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (kite || loginInProgress) {
    return res.status(409).json({ error: "Disconnect or wait for the current Zerodha login to finish before changing API setup." });
  }
  if (redirectUrl !== expectedRedirectUrl) {
    return res.status(409).json({ error: `KITE_REDIRECT_URL must be ${expectedRedirectUrl}. Correct the local configuration and restart MarketLens.` });
  }
  const key = req.body?.apiKey;
  const secret = req.body?.apiSecret;
  const validCredential = value => typeof value === "string" && value.length > 0 &&
    value.length <= 256 && /^[\x21-\x7e]+$/.test(value);
  if (!validCredential(key) || !validCredential(secret)) {
    return res.status(400).json({ error: "Enter the Kite Connect API key and API secret without spaces; each must be at most 256 characters." });
  }
  apiKey = key;
  apiSecret = secret;
  loginState = null;
  loginStateExpires = 0;
  res.json({ configured: true });
});

app.get("/api/login", (_req, res) => {
  if (!configured()) {
    return res.status(503).json({ error: `Set KITE_API_KEY and KITE_API_SECRET in .env and register ${expectedRedirectUrl} as the Kite redirect URL.` });
  }
  loginState = crypto.randomBytes(24).toString("hex");
  loginStateExpires = Date.now() + 5 * 60 * 1000;
  const query = new URLSearchParams({
    v: "3",
    api_key: apiKey,
    redirect_params: new URLSearchParams({ state: loginState }).toString()
  });
  res.redirect(`https://kite.zerodha.com/connect/login?${query}`);
});

app.get("/auth/kite/callback", async (req, res) => {
  const returnedState = String(req.query.state || "");
  const expectedState = loginState;
  loginState = null;
  if (!expectedState || Date.now() > loginStateExpires || returnedState !== expectedState) {
    return res.status(400).send("Kite login could not be verified. Return to MarketLens and try again.");
  }
  if (req.query.status !== "success" || typeof req.query.request_token !== "string") {
    return res.status(400).send("Kite login was not completed. Return to MarketLens and try again.");
  }

  loginInProgress = true;
  try {
    scanner.stop();
    analysisCache.clear();
    stopTicker();
    const newKite = new KiteConnect({ api_key: apiKey });
    const session = await newKite.generateSession(req.query.request_token, apiSecret);
    if (typeof session?.access_token !== "string" || !session.access_token) {
      throw new Error("Zerodha did not return an access token. Please sign in again.");
    }
    newKite.setAccessToken(session.access_token);
    kite = newKite;
    userSummary = { name: session.user_name, id: session.user_id, broker: session.broker };
    const [nse, bse] = await Promise.all([
      kite.getInstruments("NSE"),
      kite.getInstruments("BSE")
    ]);
    instruments = [...nse, ...bse]
      .filter(item => ["NSE", "BSE"].includes(item.exchange) &&
        (item.instrument_type === "EQ" || item.segment === "INDICES"))
      .map(item => ({
        instrument_token: Number(item.instrument_token),
        exchange: item.exchange,
        tradingsymbol: item.tradingsymbol,
        name: item.name || item.tradingsymbol,
        tick_size: Number(item.tick_size),
        instrument_type: item.instrument_type,
        isEquity: item.instrument_type === "EQ" && item.segment === item.exchange
      }));
    instrumentsByKey = new Map(instruments.map(item => [`${item.exchange}:${item.tradingsymbol}`, item]));
    const nseKeys = instruments.filter(item => item.isEquity && item.exchange === "NSE").map(item => `NSE:${item.tradingsymbol}`);
    const bseKeys = instruments.filter(item => item.isEquity && item.exchange === "BSE").map(item => `BSE:${item.tradingsymbol}`);
    const scanKeys = [];
    for (let i = 0; i < Math.max(nseKeys.length, bseKeys.length); i += 1) {
      if (nseKeys[i]) scanKeys.push(nseKeys[i]);
      if (bseKeys[i]) scanKeys.push(bseKeys[i]);
    }
    scanner.reset(scanKeys);
    scanner.start();
    subscriptions.reset([...subscriptions.permanentKeys()].filter(key => instrumentsByKey.has(key)));
    startTicker(session.access_token);
    res.redirect("/");
  } catch (error) {
    scanner.reset([]);
    kite = null;
    stopTicker();
    userSummary = null;
    instruments = [];
    instrumentsByKey.clear();
    clientError(res, error);
  } finally {
    loginInProgress = false;
  }
});

app.get("/api/instruments", requireSession, (_req, res) => {
  res.json(instruments.map(item => ({
    exchange: item.exchange,
    symbol: item.tradingsymbol,
    name: item.name,
    tickSize: item.tick_size,
    token: item.instrument_token,
    isEquity: item.isEquity
  })));
});

app.post("/api/market/subscribe", requireSameOrigin, requireSession, (req, res) => {
  const requested = req.body?.symbols;
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 100) {
    return res.status(400).json({ error: "Request between 1 and 100 instrument keys." });
  }
  const keys = [...new Set(requested.map(key => String(key)))];
  if (keys.some(key => !instrumentsByKey.has(key))) {
    return res.status(400).json({ error: "One or more instruments are not available in the current NSE/BSE instrument list." });
  }
  try {
    const change = subscriptions.addPermanent(keys);
    updateTickerSubscriptions(change);
    res.json({ subscribed: keys.length, total: change.total });
  } catch (error) {
    res.status(400).json({ error: `${error.message} Restart the app to clear permanent subscriptions.` });
  }
});

app.get("/api/quotes", requireSession, async (req, res) => {
  const requested = String(req.query.symbols || "").split(",").filter(Boolean);
  if (!requested.length || requested.length > 40) return res.status(400).json({ error: "Request between 1 and 40 exchange:symbol quotes." });
  const validKeys = requested.filter(key => instrumentsByKey.has(key));
  if (!validKeys.length) return res.status(400).json({ error: "No requested symbols are available NSE/BSE equities." });
  try {
    const quotes = await kite.getQuote(validKeys);
    res.json(Object.entries(quotes).map(([key, quote]) => ({
      key,
      price: quote.last_price,
      change: quote.ohlc?.close ? (quote.last_price - quote.ohlc.close) / quote.ohlc.close * 100 : null,
      ohlc: quote.ohlc || null,
      volume: quote.volume || null,
      timestamp: quote.timestamp || quote.last_trade_time || null
    })));
  } catch (error) {
    clientError(res, error);
  }
});

async function loadAnalysis(key, interval) {
  const client = kite;
  const instrument = instrumentsByKey.get(key);
  if (!client || !instrument?.isEquity) throw new Error("The Zerodha session or equity is unavailable.");
  const cacheKey = `${key}|${interval}`;
  const cached = analysisCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < (interval === "day" ? 15 * 60000 : 60000) &&
      (interval !== "5minute" || cached.createdAt >= Math.floor(Date.now() / 300000) * 300000)) return cached.data;
  const queued = historyQueue.then(async () => {
    const wait = Math.max(0, 400 - (Date.now() - lastHistoryRequestAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    if (kite !== client) throw new Error("The Zerodha session changed during analysis.");
    lastHistoryRequestAt = Date.now();
    const { from, to } = historicalRange(interval);
    const history = await client.getHistoricalData(instrument.instrument_token, interval, from, to);
    if (kite !== client) throw new Error("The Zerodha session changed during analysis.");
    const candles = normalizeCandles(history, interval);
    const indicators = calculateIndicators(candles);
    const data = { symbol: key, indicators, candles };
    if (!indicators.error) {
      analysisCache.delete(cacheKey);
      analysisCache.set(cacheKey, { createdAt: Date.now(), data });
      while (analysisCache.size > 100) analysisCache.delete(analysisCache.keys().next().value);
    }
    return data;
  });
  historyQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

app.get("/api/analysis", requireSession, async (req, res) => {
  const key = String(req.query.symbol || "").toUpperCase();
  const startingCapital = Number(req.query.capital || 100000);
  if (!Number.isFinite(startingCapital) || startingCapital < 1000 || startingCapital > 100000000) {
    return res.status(400).json({ error: "Simulation capital must be between ₹1,000 and ₹10 crore." });
  }
  if (!instrumentsByKey.get(key)?.isEquity) return res.status(400).json({ error: "Select a valid NSE or BSE equity." });
  try {
    const data = await loadAnalysis(key, "day");
    if (data.indicators.error) return res.status(422).json({ error: data.indicators.error });
    res.json({ ...data, backtest: backtestTrendStrategy(data.candles, startingCapital) });
  } catch (error) {
    clientError(res, error);
  }
});

app.get("/api/intraday-analysis", requireSession, async (req, res) => {
  const key = String(req.query.symbol || "").toUpperCase();
  if (!instrumentsByKey.get(key)?.isEquity) return res.status(400).json({ error: "Select a valid NSE or BSE equity." });
  try {
    const data = await loadAnalysis(key, "5minute");
    if (data.indicators.error) return res.status(422).json({ error: data.indicators.error });
    res.setHeader("Cache-Control", "no-store");
    res.json(data);
  } catch (error) {
    clientError(res, error);
  }
});

app.get("/api/market-scan", requireSession, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(scanner.snapshot());
});

app.post("/api/market-scan", requireSameOrigin, requireSession, (req, res) => {
  if (!["start", "pause"].includes(req.body?.action)) return res.status(400).json({ error: "Select start or pause." });
  if (req.body.action === "start") scanner.start();
  else scanner.stop();
  res.setHeader("Cache-Control", "no-store");
  res.json(scanner.snapshot());
});

app.get("/api/account", requireSession, async (_req, res) => {
  const results = await Promise.allSettled([
    kite.getProfile(),
    kite.getMargins("equity"),
    kite.getHoldings(),
    kite.getPositions(),
    kite.getOrders(),
    kite.getTrades()
  ]);
  const errors = {};
  const read = (index, key, map) => {
    const result = results[index];
    if (result.status === "rejected") {
      errors[key] = String(result.reason?.message || "Kite Connect request failed.").slice(0, 240);
      return null;
    }
    return map(result.value);
  };
  const profile = read(0, "profile", value => ({
    userId: value.user_id,
    name: value.user_name,
    shortName: value.user_shortname,
    email: value.email,
    userType: value.user_type,
    broker: value.broker,
    exchanges: value.exchanges || [],
    products: value.products || [],
    orderTypes: value.order_types || []
  }));
  const marginData = read(1, "funds", value => {
    const equity = value.equity || value;
    return {
      enabled: Boolean(equity.enabled),
      availableCash: Number(equity.available?.cash || 0),
      liveBalance: Number(equity.available?.live_balance || 0),
      openingBalance: Number(equity.available?.opening_balance || 0),
      collateral: Number(equity.available?.collateral || 0),
      net: Number(equity.net || 0),
      utilised: Number(equity.utilised?.debits || 0)
    };
  });
  const holdings = read(2, "holdings", value => value.map(holding => ({
    exchange: holding.exchange,
    symbol: holding.tradingsymbol,
    quantity: Number(holding.quantity || 0),
    t1Quantity: Number(holding.t1_quantity || 0),
    averagePrice: Number(holding.average_price || 0),
    lastPrice: Number(holding.last_price || 0),
    pnl: Number(holding.pnl || 0),
    dayChange: Number(holding.day_change || 0),
    dayChangePct: Number(holding.day_change_percentage || 0)
  })));
  const positions = read(3, "positions", value => ({
    net: value.net.map(position => ({
      exchange: position.exchange,
      symbol: position.tradingsymbol,
      product: position.product,
      quantity: Number(position.quantity || 0),
      averagePrice: Number(position.average_price || 0),
      lastPrice: Number(position.last_price || 0),
      pnl: Number(position.pnl || 0),
      realised: Number(position.realised || 0),
      unrealised: Number(position.unrealised || 0)
    })),
    day: value.day.map(position => ({
      exchange: position.exchange,
      symbol: position.tradingsymbol,
      product: position.product,
      quantity: Number(position.quantity || 0),
      averagePrice: Number(position.average_price || 0),
      lastPrice: Number(position.last_price || 0),
      pnl: Number(position.pnl || 0),
      realised: Number(position.realised || 0),
      unrealised: Number(position.unrealised || 0)
    }))
  }));
  const orders = read(4, "orders", value => value.map(order => ({
    orderId: order.order_id,
    exchange: order.exchange,
    symbol: order.tradingsymbol,
    side: order.transaction_type,
    status: order.status,
    type: order.order_type,
    product: order.product,
    quantity: Number(order.quantity || 0),
    filledQuantity: Number(order.filled_quantity || 0),
    price: Number(order.price || 0),
    averagePrice: Number(order.average_price || 0),
    timestamp: order.order_timestamp,
    statusMessage: order.status_message
  })));
  const trades = read(5, "trades", value => value.map(trade => ({
    tradeId: trade.trade_id,
    orderId: trade.order_id,
    exchange: trade.exchange,
    symbol: trade.tradingsymbol,
    side: trade.transaction_type,
    product: trade.product,
    quantity: Number(trade.filled || trade.quantity || 0),
    averagePrice: Number(trade.average_price || 0),
    timestamp: trade.fill_timestamp
  })));
  if (Object.keys(errors).length === results.length) {
    return res.status(502).json({ error: `Could not retrieve Zerodha account details: ${Object.values(errors)[0]}` });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    fetchedAt: new Date().toISOString(),
    profile,
    funds: marginData,
    availableCash: marginData?.availableCash ?? 0,
    liveBalance: marginData?.liveBalance ?? 0,
    holdings,
    positions,
    orders,
    trades,
    errors
  });
});

app.post("/api/orders/preview", requireSameOrigin, requireSession, (req, res) => {
  const instrument = instrumentsByKey.get(`${req.body?.exchange}:${req.body?.symbol}`);
  const validation = validateOrderRequest(req.body, instrument && {
    ...instrument,
    isEquity: instrument.isEquity
  });
  if (validation.error) return res.status(400).json({ error: validation.error });

  const id = crypto.randomUUID();
  const expiresAt = Date.now() + 60 * 1000;
  const order = validation.order;
  pendingOrders.set(id, { order, expiresAt });
  res.json({
    id,
    expiresAt,
    order: {
      exchange: order.exchange,
      symbol: order.tradingsymbol,
      transactionType: order.transaction_type,
      quantity: order.quantity,
      product: order.product,
      orderType: order.order_type,
      price: order.price,
      estimatedValue: Number((order.quantity * order.price).toFixed(2)),
      validity: order.validity
    },
    confirmationText: "PLACE ORDER"
  });
});

app.post("/api/orders/confirm", requireSameOrigin, requireSession, async (req, res) => {
  const id = String(req.body?.id || "");
  const pending = pendingOrders.get(id);
  pendingOrders.delete(id);
  if (!pending || Date.now() > pending.expiresAt) {
    return res.status(410).json({ error: "This order preview expired or was already used. Create a fresh preview." });
  }
  if (req.body?.confirmationText !== "PLACE ORDER" || req.body?.accepted !== true) {
    return res.status(400).json({ error: "Review and accept this order, then type PLACE ORDER to confirm it." });
  }
  try {
    const orderId = await kite.placeOrder("regular", pending.order);
    res.json({ orderId });
  } catch (error) {
    clientError(res, error);
  }
});

app.post("/api/logout", requireSameOrigin, requireSession, (_req, res) => {
  scanner.reset([]);
  stopTicker();
  kite = null;
  userSummary = null;
  instruments = [];
  instrumentsByKey.clear();
  analysisCache.clear();
  pendingOrders.clear();
  subscriptions.reset(defaultSubscribedKeys);
  for (const client of marketSocketClients) closeWebSocket(client);
  res.json({ ok: true, message: "Local app session ended. Log out of Kite separately if needed." });
});

app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/app.js", (_req, res) => res.sendFile(path.join(__dirname, "app.js")));
app.get("/styles.css", (_req, res) => res.sendFile(path.join(__dirname, "styles.css")));
app.get("/lib/paper-simulation.js", (_req, res) => res.sendFile(path.join(__dirname, "lib", "paper-simulation.js")));
app.get("/lib/trade-ideas.js", (_req, res) => res.sendFile(path.join(__dirname, "lib", "trade-ideas.js")));
app.get("/lib/price-chart.js", (_req, res) => res.sendFile(path.join(__dirname, "lib", "price-chart.js")));
app.get("/lib/market-analysis.js", (_req, res) => res.sendFile(path.join(__dirname, "lib", "market-analysis.js")));
app.get("/lib/intraday-strategy.js", (_req, res) => res.sendFile(path.join(__dirname, "lib", "intraday-strategy.js")));

httpServer.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws" || request.headers.origin !== origin || !kite) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, client => {
    marketSocketClients.add(client);
    websocketServer.emit("connection", client, request);
    client.send(JSON.stringify({ type: "status", connected, error: tickerError }));
  });
});

websocketServer.on("connection", client => {
  const chartScope = {};
  client.on("message", raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      client.send(JSON.stringify({ type: "search-subscription", error: "Invalid search subscription request." }));
      return;
    }
    if (message?.type === "chart-subscription") {
      const key = message.symbol;
      if (key !== "" && (typeof key !== "string" || !instrumentsByKey.get(key)?.isEquity)) {
        client.send(JSON.stringify({ type: "chart-subscription", requestId: message.requestId, error: "Select an available equity." }));
        return;
      }
      try {
        updateTickerSubscriptions(subscriptions.replaceScope(chartScope, key ? [key] : []));
        client.send(JSON.stringify({ type: "chart-subscription", requestId: message.requestId }));
      } catch (error) {
        client.send(JSON.stringify({ type: "chart-subscription", requestId: message.requestId, error: error.message }));
      }
      return;
    }
    if (message?.type !== "search-subscription") return;
    const keys = message.symbols;
    if (!Array.isArray(keys) || keys.length > 10 || keys.some(key => typeof key !== "string" || !instrumentsByKey.get(key)?.isEquity)) {
      client.send(JSON.stringify({ type: "search-subscription", requestId: message.requestId, error: "Select up to 10 available equities." }));
      return;
    }
    try {
      updateTickerSubscriptions(subscriptions.replaceScope(client, keys));
      client.send(JSON.stringify({ type: "search-subscription", requestId: message.requestId }));
    } catch (error) {
      client.send(JSON.stringify({ type: "search-subscription", requestId: message.requestId, error: error.message }));
    }
  });
  client.on("close", () => {
    marketSocketClients.delete(client);
    updateTickerSubscriptions(subscriptions.replaceScope(client, []));
    updateTickerSubscriptions(subscriptions.replaceScope(chartScope, []));
  });
});

process.on("SIGINT", () => {
  stopTicker();
  websocketServer.close();
  httpServer.close(() => process.exit(0));
});
