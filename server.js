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

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const expectedRedirectUrl = `http://${host}:${port}/auth/kite/callback`;
const redirectUrl = process.env.KITE_REDIRECT_URL || expectedRedirectUrl;
const apiKey = process.env.KITE_API_KEY;
const apiSecret = process.env.KITE_API_SECRET;
const origin = `http://${host}:${port}`;
const app = express();
const httpServer = app.listen(port, host, () => {
  console.log(`MarketLens running at ${origin}`);
  if (!apiKey || !apiSecret) console.log("Add KITE_API_KEY and KITE_API_SECRET to .env to connect Kite Connect.");
});
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });

let kite = null;
let ticker = null;
let connected = false;
let tickerError = null;
let instruments = [];
let instrumentsByKey = new Map();
let subscribedKeys = new Set([
  "NSE:NIFTY 50", "NSE:NIFTY BANK", "NSE:NIFTY IT", "BSE:SENSEX",
  "NSE:RELIANCE", "NSE:TCS", "NSE:INFY", "NSE:HDFCBANK",
  "NSE:ICICIBANK", "NSE:SBIN", "NSE:ITC", "NSE:LT"
]);
let loginState = null;
let loginStateExpires = 0;
const pendingOrders = new Map();
const marketSocketClients = new Set();
const analysisCache = new Map();
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
  if (ticker) {
    try {
      ticker.disconnect();
    } catch (error) {
      console.warn("Could not close the Kite market-data connection.", error?.message || error);
    }
  }
  ticker = null;
  connected = false;
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of marketSocketClients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

function startTicker() {
  stopTicker();
  const tokens = [...subscribedKeys].map(key => instrumentsByKey.get(key)?.instrument_token).filter(Boolean);
  if (!tokens.length) {
    tickerError = "No NSE/BSE equity instruments are available to stream.";
    return;
  }

  tickerError = null;
  ticker = new KiteTicker({ api_key: apiKey, access_token: kite.getAccessToken() });
  ticker.on("connect", () => {
    connected = true;
    ticker.subscribe(tokens);
    ticker.setMode(ticker.modeQuote, tokens);
    broadcast({ type: "status", connected: true });
  });
  ticker.on("ticks", ticks => {
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
  ticker.on("disconnect", error => {
    connected = false;
    tickerError = error?.message || "Market-data connection disconnected.";
    broadcast({ type: "status", connected: false, error: tickerError });
  });
  ticker.on("error", error => {
    connected = false;
    tickerError = error?.message || "Market-data connection error.";
    broadcast({ type: "status", connected: false, error: tickerError });
    console.error("Kite market-data stream error:", tickerError);
  });
  ticker.connect();
}

function closeWebSocket(client) {
  marketSocketClients.delete(client);
  client.close();
}

app.get("/api/status", (_req, res) => {
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

  try {
    stopTicker();
    const newKite = new KiteConnect({ api_key: apiKey });
    const session = await newKite.generateSession(req.query.request_token, apiSecret);
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
    subscribedKeys = new Set([...subscribedKeys].filter(key => instrumentsByKey.has(key)));
    startTicker();
    res.redirect("/");
  } catch (error) {
    kite = null;
    stopTicker();
    userSummary = null;
    instruments = [];
    instrumentsByKey.clear();
    clientError(res, error);
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
  const newKeys = keys.filter(key => !subscribedKeys.has(key));
  if (subscribedKeys.size + newKeys.length > 150) {
    return res.status(400).json({ error: "This local app can stream up to 150 symbols at once. Remove alerts/watchlist entries and restart to clear subscriptions." });
  }
  newKeys.forEach(key => subscribedKeys.add(key));
  const tokens = newKeys.map(key => instrumentsByKey.get(key).instrument_token);
  if (ticker && connected && tokens.length) {
    ticker.subscribe(tokens);
    ticker.setMode(ticker.modeQuote, tokens);
  }
  res.json({ subscribed: keys.length, total: subscribedKeys.size });
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

app.get("/api/analysis", requireSession, async (req, res) => {
  const key = String(req.query.symbol || "").toUpperCase();
  const startingCapital = Number(req.query.capital || 100000);
  if (!Number.isFinite(startingCapital) || startingCapital < 1000 || startingCapital > 100000000) {
    return res.status(400).json({ error: "Simulation capital must be between ₹1,000 and ₹10 crore." });
  }
  const instrument = instrumentsByKey.get(key);
  if (!instrument?.isEquity) return res.status(400).json({ error: "Select a valid NSE or BSE equity." });

  const cached = analysisCache.get(key);
  if (cached && Date.now() - cached.createdAt < 15 * 60 * 1000) {
    return res.json({
      ...cached.data,
      backtest: backtestTrendStrategy(cached.data.candles, startingCapital)
    });
  }

  try {
    const todayIST = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
    const yesterday = new Date(`${todayIST}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const endDate = `${yesterday.toISOString().slice(0, 10)} 23:59:59`;
    const startDateObject = new Date(yesterday);
    startDateObject.setUTCDate(startDateObject.getUTCDate() - 180);
    const startDate = `${startDateObject.toISOString().slice(0, 10)} 00:00:00`;
    const history = await kite.getHistoricalData(instrument.instrument_token, "day", startDate, endDate);
    const candles = history.map(candle => ({
      date: candle.date instanceof Date ? candle.date.toISOString().slice(0, 10) : String(candle.date).slice(0, 10),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume || 0)
    })).filter(candle =>
      Number.isFinite(candle.open) && Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) && Number.isFinite(candle.close)
    );
    const indicators = calculateIndicators(candles);
    if (indicators.error) return res.status(422).json({ error: indicators.error });

    const data = {
      symbol: key,
      indicators,
      candles
    };
    analysisCache.set(key, { createdAt: Date.now(), data });
    res.json({ ...data, backtest: backtestTrendStrategy(candles, startingCapital) });
  } catch (error) {
    clientError(res, error);
  }
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
  stopTicker();
  kite = null;
  userSummary = null;
  instruments = [];
  instrumentsByKey.clear();
  analysisCache.clear();
  pendingOrders.clear();
  subscribedKeys = new Set([
    "NSE:NIFTY 50", "NSE:NIFTY BANK", "NSE:NIFTY IT", "BSE:SENSEX",
    "NSE:RELIANCE", "NSE:TCS", "NSE:INFY", "NSE:HDFCBANK",
    "NSE:ICICIBANK", "NSE:SBIN", "NSE:ITC", "NSE:LT"
  ]);
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

websocketServer.on("connection", client => client.on("close", () => marketSocketClients.delete(client)));

process.on("SIGINT", () => {
  stopTicker();
  websocketServer.close();
  httpServer.close(() => process.exit(0));
});
