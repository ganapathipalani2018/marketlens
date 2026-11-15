import { calculatePaperOrder, paperDrawdownReached, paperExitReason } from "./lib/paper-simulation.js";
import { tradeIdea } from "./lib/trade-ideas.js";
import { buildPriceChart } from "./lib/price-chart.js";

const featuredKeys = [
  "NSE:RELIANCE", "NSE:TCS", "NSE:INFY", "NSE:HDFCBANK", "NSE:ICICIBANK",
  "NSE:SBIN", "NSE:ITC", "NSE:LT", "NSE:BHARTIARTL", "NSE:AXISBANK",
  "NSE:BAJFINANCE", "NSE:TATAMOTORS"
];
const indexCards = {
  "NSE:NIFTY 50": ["index-nifty", "index-nifty-change"],
  "NSE:NIFTY BANK": ["index-bank", "index-bank-change"],
  "BSE:SENSEX": ["index-sensex", "index-sensex-change"],
  "NSE:NIFTY IT": ["index-it", "index-it-change"]
};
const localStore = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.warn(`Could not read ${key} from browser storage.`, error);
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`Could not save ${key} to browser storage.`, error);
      showToast("Could not save this in your browser.");
      return false;
    }
  }
};

let appStatus = { configured: false, authenticated: false, connected: false };
let instruments = [];
let instrumentsByKey = new Map();
let instrumentsByToken = new Map();
let quotes = new Map();
let analysisBySymbol = new Map();
let analysisRequests = new Map();
let analysisQueue = Promise.resolve();
let lastAnalysisRequestAt = 0;
let watchlist = localStore.read("marketlens-watchlist", ["NSE:RELIANCE", "NSE:TCS"])
  .filter(key => typeof key === "string" && key.includes(":"));
let alerts = localStore.read("marketlens-alerts", [])
  .filter(alert => alert && typeof alert.key === "string" && alert.key.includes(":"));
const savedPaper = localStore.read("marketlens-paper", {}) || {};
let paper = {
  startingCapital: Number(savedPaper.startingCapital) > 0 ? Number(savedPaper.startingCapital) : 100000,
  cash: Number(savedPaper.cash) >= 0 ? Number(savedPaper.cash) : 100000,
  positions: Array.isArray(savedPaper.positions) ? savedPaper.positions.filter(item =>
    item && typeof item.key === "string" && Number(item.quantity) > 0 && Number(item.entryPrice) > 0
  ) : [],
  trades: Array.isArray(savedPaper.trades) ? savedPaper.trades.slice(0, 1000) : [],
  peakEquity: Number(savedPaper.peakEquity) > 0 ? Number(savedPaper.peakEquity) : 100000,
  enabled: false,
  settings: {
    riskPct: Number(savedPaper.settings?.riskPct) || 0.5,
    allocationPct: Number(savedPaper.settings?.allocationPct) || 10,
    maxDrawdownPct: Number(savedPaper.settings?.maxDrawdownPct) || 5
  }
};
let pendingPreview = null;
let marketSocket = null;
let toastTimer;
let accountSnapshot = null;
let activeAccountTab = "funds";
let currentAnalysisKey = "";
let marketSessionGeneration = 0;
let ideasGeneration = 0;
let ideaResults = new Map();
let ideaErrors = new Map();
let ideasLoading = false;
let ideasProgress = "";
let ideaHoldingsError = "";
let accountRefreshing = false;
let ideasStatusError = "";
let marketScan = null;
let scanError = "";
let scanActionBusy = false;
let scanRequestVersion = 0;
const jioKeys = ["NSE:JPL", "NSE:JIOFIN"];
let jioGeneration = 0;
let jioLoading = false;
let jioResults = new Map();
let jioErrors = new Map();

const money = value => new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2
}).format(Number(value));
const shortMoney = value => new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 2
}).format(Number(value));
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const keyFor = instrument => `${instrument.exchange}:${instrument.symbol}`;

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3200);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function setConnectionStatus(status, error = "") {
  const dot = document.getElementById("connection-dot");
  const label = document.getElementById("connection-label");
  dot.classList.remove("status-live", "status-error");
  if (status.connected) {
    dot.classList.add("status-live");
    label.textContent = "LIVE STREAM";
  } else if (error || status.authenticated) {
    dot.classList.add("status-error");
    label.textContent = status.authenticated ? "STREAM UNAVAILABLE" : "CONNECTION ERROR";
  } else if (!status.configured) {
    label.textContent = "SETUP REQUIRED";
  } else {
    label.textContent = "NOT CONNECTED";
  }
  document.getElementById("connect-button").classList.toggle("hidden", status.authenticated);
  document.getElementById("connect-button").disabled = false;
  document.getElementById("connect-button").textContent = status.configured ? "Connect Zerodha" : "Setup Kite API";
  document.getElementById("change-setup-button").classList.toggle("hidden", !status.configured || status.authenticated);
  document.getElementById("logout-button").classList.toggle("hidden", !status.authenticated);
  document.getElementById("account-name").classList.toggle("hidden", !status.profile?.name);
  document.getElementById("account-name").textContent = status.profile?.name || "";
  if (error) document.getElementById("quote-foot").textContent = error;
}

function renderStocks() {
  const body = document.getElementById("stock-rows");
  const query = document.getElementById("stock-search").value.trim().toLowerCase();
  const exchangeFilter = document.getElementById("signal-filter").value;
  const equities = instruments.filter(item => item.isEquity);
  const visible = query
    ? equities.filter(item => `${item.symbol} ${item.name} ${item.exchange}`.toLowerCase().includes(query)).slice(0, 100)
    : featuredKeys.map(key => instrumentsByKey.get(key)).filter(Boolean);

  const sortBy = document.getElementById("stock-sort")?.value || "featured";
  let results = visible.filter(item => exchangeFilter === "all" || item.exchange === exchangeFilter);
  if (sortBy === "score") results = results.sort((left, right) =>
    (analysisBySymbol.get(keyFor(right))?.indicators.score ?? -1) -
    (analysisBySymbol.get(keyFor(left))?.indicators.score ?? -1));
  if (sortBy === "change") results = results.sort((left, right) =>
    (quotes.get(keyFor(right))?.change ?? -Infinity) - (quotes.get(keyFor(left))?.change ?? -Infinity));
  if (sortBy === "name") results = results.sort((left, right) => left.name.localeCompare(right.name));
  body.innerHTML = results.map(item => {
    const key = keyFor(item);
    const quote = quotes.get(key);
    const price = quote ? money(quote.price) : "—";
    const change = Number.isFinite(quote?.change)
      ? `<span class="${quote.change >= 0 ? "positive" : "negative"}">${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}%</span>`
      : "—";
    const ticker = item.symbol.slice(0, 2).toUpperCase();
    const analysis = analysisBySymbol.get(key);
    const indicators = analysis?.indicators;
    const score = indicators ? `<span class="score-pill score-${indicators.score >= 75 ? "high" : indicators.score >= 50 ? "mid" : "low"}" title="Indicator agreement, not a probability or recommendation">${indicators.score}/100</span>` : '<span class="score-pending">Not analyzed</span>';
    return `<tr>
      <td><div class="company-cell"><span class="stock-avatar">${escapeHtml(ticker)}</span><span><span class="company-name">${escapeHtml(item.name)}</span><span class="company-ticker">${escapeHtml(item.symbol)}</span></span></div></td>
      <td class="table-price">${price}</td>
      <td>${change}</td>
      <td><span class="signal-pill ${indicators?.trend === "Uptrend" ? "signal-positive" : indicators?.trend === "Downtrend" ? "signal-negative" : "signal-watch"}">${indicators?.trend || item.exchange}</span></td>
      <td>${score}</td>
      <td><div class="row-actions"><button class="star-button ${watchlist.includes(key) ? "saved" : ""}" data-watch="${escapeHtml(key)}" aria-label="${watchlist.includes(key) ? "Remove" : "Add"} ${escapeHtml(key)} ${watchlist.includes(key) ? "from" : "to"} watchlist">${watchlist.includes(key) ? "★" : "☆"}</button><button class="more-button" data-analysis="${escapeHtml(key)}" aria-label="View ${escapeHtml(key)} analysis">···</button></div></td>
    </tr>`;
  }).join("");

  const empty = document.getElementById("empty-stocks");
  empty.classList.toggle("hidden", results.length > 0);
  empty.textContent = appStatus.authenticated
    ? (query ? "No equities match your search." : "No instrument list is available.")
    : "Connect Zerodha to load live NSE/BSE quotes.";
}

function renderWatchlist() {
  const validItems = watchlist.map(key => ({ key, instrument: instrumentsByKey.get(key) }))
    .filter(item => item.instrument?.isEquity);
  document.getElementById("watchlist-count").textContent = String(validItems.length);
  document.getElementById("watchlist-empty").classList.toggle("hidden", validItems.length > 0);
  document.getElementById("watchlist-items").innerHTML = validItems.map(({ key, instrument }) => {
    const quote = quotes.get(key);
    const change = Number.isFinite(quote?.change) ? `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}%` : "—";
    return `<div class="watch-item" data-open-analysis="${escapeHtml(key)}" tabindex="0" role="button" aria-label="View ${escapeHtml(key)} quote">
      <div class="watch-left"><span class="stock-avatar">${escapeHtml(instrument.symbol.slice(0, 2))}</span><span><span class="watch-ticker">${escapeHtml(instrument.symbol)}</span><span class="watch-name">${instrument.exchange}</span></span></div>
      <span><span class="watch-price">${quote ? money(quote.price) : "—"}</span><span class="watch-change ${quote?.change >= 0 ? "positive" : quote?.change < 0 ? "negative" : ""}">${change}</span></span>
    </div>`;
  }).join("");
  renderBacktestOptions();
  renderPaper();
}

function renderJio() {
  const status = document.getElementById("jio-status");
  const content = document.getElementById("jio-content");
  document.getElementById("refresh-jio").disabled = !appStatus.authenticated || jioLoading || Boolean(ideasStatusError);
  if (ideasStatusError || !appStatus.authenticated) {
    status.textContent = ideasStatusError ? `Connection status unavailable: ${ideasStatusError}` : "Connect Zerodha to load analysis.";
    content.innerHTML = "";
    return;
  }
  status.textContent = jioLoading ? "Loading completed daily candles…" : jioErrors.size
    ? "Some analysis is unavailable; see details below." : "Daily rule analysis loaded; refresh for updates.";
  content.innerHTML = jioKeys.map(key => {
    const result = jioResults.get(key);
    const error = jioErrors.get(key);
    const summary = error || (!result ? "Waiting for analysis" :
      `${result.buyCondition ? "Buy rule met" : "Buy rule not met"} · ${result.sellCondition ? "Sell review rule met" : "Sell review rule not met"}`);
    const details = result ? `<div class="idea-details">Daily close ${money(result.close)} · ${escapeHtml(result.date)}<br>${result.targetPrice === null
      ? "Hypothetical levels unavailable: stop would be non-positive."
      : `Example target ${money(result.targetPrice)} · stop ${money(result.stopPrice)}`}</div>` : "";
    const button = instrumentsByKey.get(key)?.isEquity
      ? `<button class="text-link" data-jio-analysis="${escapeHtml(key)}">View chart and analysis</button>` : "";
    return `<div class="idea-row"><div class="idea-heading"><strong>${escapeHtml(key)}</strong></div><div>${escapeHtml(summary)}</div>${details}${button}</div>`;
  }).join("");
}

async function refreshJio() {
  const generation = ++jioGeneration;
  jioResults = new Map();
  jioErrors = new Map();
  if (!appStatus.authenticated || ideasStatusError) {
    jioLoading = false;
    renderJio();
    return;
  }
  jioLoading = true;
  renderJio();
  for (const [index, key] of jioKeys.entries()) {
    if (index) await new Promise(resolve => window.setTimeout(resolve, 400));
    if (generation !== jioGeneration || !appStatus.authenticated) return;
    if (!instrumentsByKey.get(key)?.isEquity) {
      jioErrors.set(key, "Not available in Zerodha's current NSE equity list.");
      continue;
    }
    try {
      const data = await fetchAnalysis(key);
      if (generation !== jioGeneration || !appStatus.authenticated) return;
      const result = tradeIdea(data.indicators);
      if (result.error) jioErrors.set(key, result.error);
      else jioResults.set(key, result);
    } catch (error) {
      if (generation !== jioGeneration || !appStatus.authenticated) return;
      jioErrors.set(key, error.message);
    }
  }
  if (generation !== jioGeneration || !appStatus.authenticated) return;
  jioLoading = false;
  renderJio();
}

function ideaHoldingKeys() {
  if (ideaHoldingsError || !accountSnapshot?.holdings) return [];
  return [...new Set(accountSnapshot.holdings
    .filter(item => item.quantity > 0 || item.t1Quantity > 0)
    .map(item => `${item.exchange}:${item.symbol}`))];
}

function renderMarketScan() {
  const status = document.getElementById("scan-status");
  const content = document.getElementById("scan-content");
  const toggle = document.getElementById("scan-toggle");
  toggle.disabled = !appStatus.authenticated || !marketScan || scanActionBusy || !marketScan.total;
  toggle.textContent = marketScan?.running ? "Pause" : "Resume";
  if (!appStatus.authenticated) {
    status.textContent = "Connect Zerodha to start the scan.";
    content.innerHTML = "";
    return;
  }
  if (scanError || !marketScan) {
    status.textContent = scanError ? `Market scan unavailable: ${scanError}` : "Loading market scan…";
    content.innerHTML = "";
    return;
  }
  const state = marketScan.running ? "Scanning" : "Paused";
  status.textContent = `${state}: ${marketScan.completed}/${marketScan.total} instruments in cycle ${marketScan.cycle + 1}; ${marketScan.unavailable} unavailable timeframe(s).${marketScan.current ? ` Checking ${marketScan.current}.` : ""}${marketScan.error ? ` ${marketScan.error}` : ""}${marketScan.lastIssue ? ` Latest issue: ${marketScan.lastIssue}` : ""}`;
  const section = (title, items, interval) => {
    const cards = items.map(item => {
      const candleTime = Date.parse(item.date);
      const stale = !Number.isFinite(candleTime) || Date.now() - candleTime > (interval === "5minute" ? 20 * 60000 : 4 * 86400000);
      const candleLabel = interval === "day" ? item.date :
        new Date(candleTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST";
      const scanTime = new Date(item.scannedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      return `<div class="scan-candidate${stale ? " stale" : ""}"><strong>${escapeHtml(item.symbol)}</strong> · ${stale ? "Old candle; verify current data" : "Rule matched"}
        <div>Example entry ${money(item.close)} · example sell target ${money(item.targetPrice)} · stop ${money(item.stopPrice)}</div>
        <div>Candle: ${escapeHtml(candleLabel)} · scanned ${escapeHtml(scanTime)} IST</div>
        <button class="text-link" data-scan-order="${escapeHtml(item.symbol)}">Review buy order</button></div>`;
    }).join("");
    return `<h3 class="ideas-section-title">${title}</h3>${cards || '<p class="account-empty">No matches found in the scanned instruments yet.</p>'}`;
  };
  content.innerHTML = section("Daily · latest matches", marketScan.candidates.day, "day") +
    section("5-minute · latest matches", marketScan.candidates["5minute"], "5minute");
}

async function refreshMarketScan() {
  if (!appStatus.authenticated || scanActionBusy) return;
  const version = ++scanRequestVersion;
  const session = marketSessionGeneration;
  try {
    const result = await requestJson("/api/market-scan");
    if (version !== scanRequestVersion || session !== marketSessionGeneration || !appStatus.authenticated) return;
    marketScan = result;
    scanError = "";
  } catch (error) {
    if (version !== scanRequestVersion || session !== marketSessionGeneration || !appStatus.authenticated) return;
    scanError = error.message;
  }
  renderMarketScan();
}

function renderIdeas() {
  const status = document.getElementById("ideas-status");
  const content = document.getElementById("ideas-content");
  const refresh = document.getElementById("refresh-ideas");
  refresh.disabled = !appStatus.authenticated || ideasLoading || accountRefreshing || Boolean(ideasStatusError);
  if (ideasStatusError) {
    status.textContent = `Connection status unavailable: ${ideasStatusError}`;
    content.innerHTML = "";
    return;
  }
  if (!appStatus.authenticated) {
    status.textContent = "Connect Zerodha to load daily analysis.";
    content.innerHTML = "";
    return;
  }
  status.textContent = ideasLoading ? `Analyzing ${ideasProgress}…` : ideaErrors.size
    ? `Analysis completed with ${ideaErrors.size} unavailable symbol(s). Refresh to retry.`
    : "Daily analysis complete. Refresh to update.";
  const row = (key, side) => {
    const result = ideaResults.get(key);
    const error = ideaErrors.get(key);
    const signal = side === "BUY" ? result?.buyCondition : result?.sellCondition;
    const description = error || (!result ? (ideasLoading ? "Waiting for analysis" : "Not analyzed") :
      side === "BUY" ? (signal ? "Buy rule met" : "Buy rule not met") :
        (signal ? "Sell review rule met" : "Sell review rule not met"));
    const levels = result ? `<div class="idea-details">Daily close ${money(result.close)} · ${escapeHtml(result.date)}<br>${result.targetPrice === null
      ? "Hypothetical levels unavailable: stop would be non-positive."
      : `Example target ${money(result.targetPrice)} · stop ${money(result.stopPrice)}`}</div>` : "";
    const button = signal ? `<button class="text-link" data-idea-order="${escapeHtml(key)}" data-idea-side="${side}">Review ${side.toLowerCase()} order</button>` : "";
    return `<div class="idea-row"><div class="idea-heading"><strong>${escapeHtml(key)}</strong><span class="idea-status ${signal ? (side === "BUY" ? "positive" : "negative") : ""}">${escapeHtml(description)}</span></div>${levels}${button}</div>`;
  };
  const watchKeys = [...new Set(watchlist)];
  const holdingKeys = ideaHoldingKeys();
  const holdingsMessage = ideaHoldingsError
    ? `<p class="account-error">Holdings unavailable: ${escapeHtml(ideaHoldingsError)}</p>`
    : !accountSnapshot?.holdings ? '<p class="account-empty">Refresh the account snapshot to load holdings.</p>'
      : !holdingKeys.length ? '<p class="account-empty">No positive delivery holdings returned by Zerodha.</p>' : "";
  const snapshotTime = accountSnapshot?.fetchedAt && !ideaHoldingsError
    ? `<p class="account-updated">Holdings snapshot: ${escapeHtml(new Date(accountSnapshot.fetchedAt).toLocaleString())}. T+1 shares may not be sellable.</p>` : "";
  content.innerHTML = `<h3 class="ideas-section-title">Buy watchlist</h3>${watchKeys.length
    ? watchKeys.map(key => row(key, "BUY")).join("") : '<p class="account-empty">Add equities to your watchlist.</p>'}
    <h3 class="ideas-section-title">Sell review · holdings</h3>${snapshotTime}${holdingsMessage}${holdingKeys.map(key => row(key, "SELL")).join("")}`;
}

async function refreshIdeas() {
  const generation = ++ideasGeneration;
  ideaResults = new Map();
  ideaErrors = new Map();
  if (!appStatus.authenticated) {
    ideasLoading = false;
    renderIdeas();
    return;
  }
  const keys = [...new Set([...watchlist, ...ideaHoldingKeys()])];
  ideasLoading = true;
  ideasProgress = `0/${keys.length}`;
  renderIdeas();
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) await new Promise(resolve => window.setTimeout(resolve, 400));
    if (generation !== ideasGeneration || !appStatus.authenticated) return;
    const key = keys[index];
    ideasProgress = `${index + 1}/${keys.length}`;
    renderIdeas();
    if (!instrumentsByKey.get(key)?.isEquity) {
      ideaErrors.set(key, "Equity not available in the current instrument list.");
      continue;
    }
    try {
      const data = await fetchAnalysis(key);
      if (generation !== ideasGeneration || !appStatus.authenticated) return;
      const result = tradeIdea(data.indicators);
      if (result.error) ideaErrors.set(key, result.error);
      else ideaResults.set(key, result);
    } catch (error) {
      if (generation !== ideasGeneration || !appStatus.authenticated) return;
      ideaErrors.set(key, error.message);
    }
  }
  if (generation !== ideasGeneration || !appStatus.authenticated) return;
  ideasLoading = false;
  renderIdeas();
}

function renderAlerts() {
  const rows = document.getElementById("alerts-content");
  rows.innerHTML = alerts.map(alert => {
    const instrument = instrumentsByKey.get(alert.key);
    if (!instrument) return "";
    return `<div class="alert-row">
      <span class="alert-stock"><span class="stock-avatar">${escapeHtml(instrument.symbol.slice(0, 2))}</span>${escapeHtml(alert.key)}</span>
      <span class="alert-condition">Price goes ${alert.condition}</span>
      <span class="alert-target">${money(alert.price)}${alert.triggered ? " · Triggered" : ""}</span>
      <button class="delete-alert" data-delete-alert="${escapeHtml(alert.id)}" aria-label="Delete ${escapeHtml(alert.key)} alert">×</button>
    </div>`;
  }).join("");
  document.getElementById("alerts-empty").classList.toggle("hidden", alerts.length > 0);
  document.getElementById("alert-count").textContent = String(alerts.filter(alert => !alert.triggered).length);
}

function renderIndexCards() {
  for (const [key, [priceId, changeId]] of Object.entries(indexCards)) {
    const quote = quotes.get(key);
    document.getElementById(priceId).textContent = quote ? shortMoney(quote.price) : "--";
    const changeNode = document.getElementById(changeId);
    if (!quote) {
      changeNode.textContent = appStatus.connected ? "Awaiting exchange tick" : "Connect for live data";
      changeNode.className = "metric-foot";
      continue;
    }
    changeNode.textContent = Number.isFinite(quote.change)
      ? `${quote.change >= 0 ? "↗" : "↘"} ${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}% today`
      : "Live quote";
    changeNode.className = `metric-foot ${quote.change >= 0 ? "positive" : "negative"}`;
  }
}

function savePaper() {
  localStore.write("marketlens-paper", paper);
}

function paperEquity() {
  return paper.cash + paper.positions.reduce((total, position) =>
    total + (quotes.get(position.key)?.price || position.entryPrice) * position.quantity, 0);
}

function renderPaper() {
  const equity = paperEquity();
  const openPnl = equity - paper.cash - paper.positions.reduce((total, position) =>
    total + position.entryPrice * position.quantity, 0);
  const drawdownPct = paper.peakEquity > 0 ? Math.max(0, (paper.peakEquity - equity) / paper.peakEquity * 100) : 0;
  document.getElementById("paper-equity").textContent = money(equity);
  document.getElementById("paper-cash").textContent = money(paper.cash);
  document.getElementById("paper-pnl").textContent = money(openPnl);
  document.getElementById("paper-pnl").className = openPnl > 0 ? "positive" : openPnl < 0 ? "negative" : "";
  document.getElementById("paper-dd").textContent = `${drawdownPct.toFixed(2)}%`;
  document.getElementById("paper-dd").className = drawdownPct > 0 ? "negative" : "";

  const positions = document.getElementById("paper-positions");
  positions.innerHTML = [
    ...paper.positions.map(position => {
      const currentPrice = quotes.get(position.key)?.price || position.entryPrice;
      const pnl = (currentPrice - position.entryPrice) * position.quantity;
      return `<div class="paper-position"><span><strong>${escapeHtml(position.key)}</strong> · ${position.quantity} shares<br>Entry ${money(position.entryPrice)} · Stop ${money(position.stopPrice)} · Target ${money(position.targetPrice)}</span><strong class="${pnl >= 0 ? "positive" : "negative"}">${money(pnl)}</strong></div>`;
    }),
    ...paper.trades.slice(0, 3).map(trade =>
      `<div class="paper-position"><span>${escapeHtml(trade.key)} ${trade.side} · ${escapeHtml(trade.reason)}<br>${new Date(trade.time).toLocaleString()}</span><strong class="${trade.pnl >= 0 ? "positive" : "negative"}">${money(trade.pnl)}</strong></div>`
    )
  ].join("");

  const ready = appStatus.authenticated && appStatus.connected && watchlist.some(key => instrumentsByKey.get(key)?.isEquity);
  const toggle = document.getElementById("paper-toggle");
  toggle.disabled = !ready || paper.locked;
  toggle.textContent = paper.locked ? "Reset required after drawdown" : paper.enabled ? "Pause paper simulation" : "Start paper simulation";
  const analyzeButton = document.getElementById("analyze-watchlist");
  analyzeButton.disabled = !appStatus.authenticated || !watchlist.length;
  for (const [id, value] of [
    ["paper-capital", paper.startingCapital],
    ["paper-risk", paper.settings.riskPct],
    ["paper-allocation", paper.settings.allocationPct],
    ["paper-drawdown", paper.settings.maxDrawdownPct]
  ]) {
    const input = document.getElementById(id);
    if (document.activeElement !== input) input.value = String(value);
  }
  document.getElementById("paper-capital").disabled = paper.enabled || paper.positions.length > 0 || paper.trades.length > 0;
  const status = document.getElementById("paper-status");
  if (paper.locked) status.textContent = "The maximum drawdown guard paused this simulation. Reset the paper portfolio before starting a new run.";
  else if (paper.enabled) status.textContent = "Paper automation is running on live quotes and daily indicators. No real orders are sent.";
  else if (!appStatus.authenticated) status.textContent = "Connect Zerodha to load quotes and historical candles; paper automation never places real orders.";
  else if (!appStatus.connected) status.textContent = "Wait for the live quote stream before starting the paper simulator.";
  else if (!watchlist.length) status.textContent = "Add one or more equities to your watchlist before starting the simulation.";
  else status.textContent = "Paused. Review the settings; paper trades are simulated only.";
}

function renderBacktestOptions() {
  const options = watchlist.map(key => instrumentsByKey.get(key))
    .filter(instrument => instrument?.isEquity)
    .map(instrument => `<option value="${escapeHtml(keyFor(instrument))}">${escapeHtml(keyFor(instrument))} · ${escapeHtml(instrument.name)}</option>`)
    .join("");
  const select = document.getElementById("backtest-symbol");
  const oldValue = select.value;
  select.innerHTML = options || '<option value="">Add an equity to your watchlist</option>';
  if ([...select.options].some(option => option.value === oldValue)) select.value = oldValue;
  document.getElementById("run-backtest").disabled = !appStatus.authenticated || !options;
}

function renderAccount() {
  const updated = document.getElementById("account-updated");
  const container = document.getElementById("account-tab-content");
  document.querySelectorAll("[data-account-tab]").forEach(button => {
    const active = button.dataset.accountTab === activeAccountTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  container.setAttribute("aria-labelledby", `account-tab-${activeAccountTab}`);
  if (!accountSnapshot) {
    updated.textContent = appStatus.authenticated ? "Loading account information…" : "Connect Zerodha to retrieve account details.";
    container.innerHTML = `<p class="account-empty">${appStatus.authenticated ? "Requesting your read-only Kite account data." : "Your profile, funds, holdings, positions, orders and trades will appear here after connecting."}</p>`;
    return;
  }
  const errors = accountSnapshot.errors || {};
  const errorCount = Object.keys(errors).length;
  const fetchedAt = accountSnapshot.fetchedAt ? new Date(accountSnapshot.fetchedAt) : null;
  updated.textContent = `${errorCount ? `${errorCount} account section${errorCount === 1 ? "" : "s"} unavailable` : "All account sections loaded"}${fetchedAt && !Number.isNaN(fetchedAt.valueOf()) ? ` · Updated ${fetchedAt.toLocaleTimeString()}` : ""}.`;
  const accountError = key => errors[key]
    ? `<p class="account-error">${escapeHtml(errors[key])}</p>`
    : "";
  const empty = text => `<p class="account-empty">${text}</p>`;
  const table = (headers, rows, emptyText) => rows?.length
    ? `<div class="account-table-wrap"><table class="account-table"><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
    : empty(emptyText);
  const text = value => escapeHtml(value ?? "—");
  const price = value => Number.isFinite(Number(value)) ? money(value) : "—";
  const quantity = value => Number.isFinite(Number(value)) ? shortMoney(value) : "—";
  const pnl = value => `<span class="${Number(value) >= 0 ? "positive" : "negative"}">${price(value)}</span>`;
  const timestamp = value => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "—" : escapeHtml(date.toLocaleString());
  };
  const selectedErrorKey = activeAccountTab === "funds" ? "funds" : activeAccountTab;

  if (activeAccountTab === "funds") {
    const funds = accountSnapshot.funds;
    container.innerHTML = `${accountError(selectedErrorKey)}${funds ? `
      <div class="account-balance"><span>Available equity cash</span><strong>${money(funds.availableCash)}</strong><small>Live balance ${money(funds.liveBalance)} · Read-only. Add/withdraw funds in Zerodha.</small></div>
      ${table(["Equity funds"], [
        ["Net available", price(funds.net)],
        ["Opening balance", price(funds.openingBalance)],
        ["Collateral", price(funds.collateral)],
        ["Utilised", price(funds.utilised)],
        ["Equity segment", funds.enabled ? "Enabled" : "Not enabled"]
      ], "No equity-funds data returned.")}` : empty("Funds data is unavailable. Check the section error above or refresh.")}`;
  } else if (activeAccountTab === "holdings") {
    const holdings = accountSnapshot.holdings;
    const rows = holdings?.map(item => [
      text(`${item.exchange}:${item.symbol}`), quantity(item.quantity), quantity(item.t1Quantity),
      price(item.averagePrice), price(item.lastPrice), pnl(item.pnl), `${quantity(item.dayChangePct)}%`
    ]);
    container.innerHTML = `${accountError(selectedErrorKey)}${table(["Instrument", "Qty", "T+1", "Avg price", "Last price", "P&L", "Day %"], rows, "No delivery holdings were returned by Zerodha.")}`;
  } else if (activeAccountTab === "positions") {
    const positionRows = items => items?.map(item => [
      text(`${item.exchange}:${item.symbol}`), text(item.product), quantity(item.quantity),
      price(item.averagePrice), price(item.lastPrice), pnl(item.pnl),
      `Realised ${price(item.realised)}<br>Unrealised ${price(item.unrealised)}`
    ]);
    const positions = accountSnapshot.positions;
    container.innerHTML = `${accountError(selectedErrorKey)}${positions ? `
      <h3 class="account-section-title">Net positions</h3>${table(["Instrument", "Product", "Qty", "Avg price", "Last price", "P&L", "Breakdown"], positionRows(positions.net), "No net positions returned.")}
      <h3 class="account-section-title">Day positions</h3>${table(["Instrument", "Product", "Qty", "Avg price", "Last price", "P&L", "Breakdown"], positionRows(positions.day), "No day positions returned.")}` : empty("Position data is unavailable. Check the section error above or refresh.")}`;
  } else if (activeAccountTab === "orders") {
    const rows = accountSnapshot.orders?.map(item => [
      text(item.symbol ? `${item.exchange}:${item.symbol}` : item.symbol), text(item.side), text(item.status),
      `${quantity(item.filledQuantity)} / ${quantity(item.quantity)}`, text(item.type), text(item.product),
      price(item.price), price(item.averagePrice), timestamp(item.timestamp),
      item.statusMessage ? `<span title="${text(item.statusMessage)}">${text(item.statusMessage)}</span>` : "—"
    ]);
    container.innerHTML = `${accountError(selectedErrorKey)}${table(["Instrument", "Side", "Status", "Filled / qty", "Type", "Product", "Limit", "Average", "Time", "Message"], rows, "No orders were returned for today.")}`;
  } else if (activeAccountTab === "trades") {
    const rows = accountSnapshot.trades?.map(item => [
      text(`${item.exchange}:${item.symbol}`), text(item.side), quantity(item.quantity),
      price(item.averagePrice), text(item.product), text(item.tradeId), text(item.orderId), timestamp(item.timestamp)
    ]);
    container.innerHTML = `${accountError(selectedErrorKey)}${table(["Instrument", "Side", "Qty", "Fill price", "Product", "Trade ID", "Order ID", "Time"], rows, "No trades were returned for today.")}`;
  } else {
    const profile = accountSnapshot.profile;
    const rows = profile ? [
      ["Name", text(profile.name)],
      ["Short name", text(profile.shortName)],
      ["Kite user ID", text(profile.userId)],
      ["Email", text(profile.email)],
      ["Broker", text(profile.broker)],
      ["Account type", text(profile.userType)],
      ["Enabled exchanges", text(profile.exchanges?.join(", "))],
      ["Enabled products", text(profile.products?.join(", "))],
      ["Enabled order types", text(profile.orderTypes?.join(", "))]
    ] : [];
    container.innerHTML = `${accountError(selectedErrorKey)}${rows.length
      ? `<dl class="account-profile">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>`
      : empty("Profile data is unavailable. Check the section error above or refresh.")}`;
  }
}

async function refreshAccount() {
  if (!appStatus.authenticated) {
    showToast("Connect Zerodha to view available equity funds.");
    return;
  }
  if (accountRefreshing) return;
  accountRefreshing = true;
  const refreshButton = document.getElementById("refresh-account");
  const sessionGeneration = marketSessionGeneration;
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing…";
  renderIdeas();
  if (!accountSnapshot) renderAccount();
  try {
    const snapshot = await requestJson("/api/account");
    if (sessionGeneration !== marketSessionGeneration || !appStatus.authenticated) return;
    accountSnapshot = snapshot;
    ideaHoldingsError = accountSnapshot.errors?.holdings || "";
    renderAccount();
    void refreshIdeas();
    const accountValue = document.getElementById("account-value");
    const availableCash = accountSnapshot.funds?.availableCash;
    if (document.activeElement !== accountValue && availableCash > 0) {
      accountValue.value = String(Math.floor(availableCash));
      updatePlanner();
    }
  } catch (error) {
    if (sessionGeneration !== marketSessionGeneration || !appStatus.authenticated) return;
    ideaHoldingsError = error.message;
    void refreshIdeas();
    document.getElementById("account-updated").textContent = `Account refresh failed: ${error.message}`;
    if (!accountSnapshot) {
      document.getElementById("account-tab-content").innerHTML =
        `<p class="account-error">${escapeHtml(error.message)}</p>`;
    }
    showToast(`Could not load account information: ${error.message}`);
  } finally {
    accountRefreshing = false;
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh";
    renderIdeas();
  }
}

async function fetchAnalysis(key, capital = 100000) {
  const requestKey = `${key}|${capital}`;
  if (analysisRequests.has(requestKey)) return analysisRequests.get(requestKey);
  const sessionGeneration = marketSessionGeneration;
  const queued = analysisQueue.then(async () => {
    const wait = Math.max(0, 400 - (Date.now() - lastAnalysisRequestAt));
    if (wait) await new Promise(resolve => window.setTimeout(resolve, wait));
    if (sessionGeneration !== marketSessionGeneration || !appStatus.authenticated) {
      throw new Error("Zerodha session changed during analysis.");
    }
    lastAnalysisRequestAt = Date.now();
    return requestJson(`/api/analysis?symbol=${encodeURIComponent(key)}&capital=${encodeURIComponent(capital)}`);
  });
  analysisQueue = queued.then(() => undefined, () => undefined);
  const request = queued
    .then(data => {
      if (sessionGeneration !== marketSessionGeneration || !appStatus.authenticated) {
        throw new Error("Zerodha session changed during analysis.");
      }
      analysisBySymbol.set(key, data);
      renderStocks();
      return data;
    })
    .finally(() => {
      if (analysisRequests.get(requestKey) === request) analysisRequests.delete(requestKey);
    });
  analysisRequests.set(requestKey, request);
  return request;
}

function renderBacktestResult(data) {
  const result = data.backtest;
  document.getElementById("backtest-empty").classList.add("hidden");
  const container = document.getElementById("backtest-results");
  if (result.error) {
    container.innerHTML = `<p class="analysis-error">${escapeHtml(result.error)}</p>`;
    container.classList.remove("hidden");
    return;
  }
  container.innerHTML = `
    <div class="backtest-stat"><span>Historical simulated return</span><strong class="${result.totalReturnPct >= 0 ? "positive" : "negative"}">${result.totalReturnPct.toFixed(2)}%</strong></div>
    <div class="backtest-stat"><span>Maximum drawdown</span><strong>${result.maxDrawdownPct.toFixed(2)}%</strong></div>
    <div class="backtest-stat"><span>Closed trades / win rate</span><strong>${result.tradeCount} / ${result.winRatePct.toFixed(1)}%</strong></div>
    <div class="backtest-stat"><span>Ending equity (incl. open P&amp;L)</span><strong>${money(result.finalEquity)}</strong></div>
    <p class="backtest-note">Data range ${escapeHtml(result.startDate)} to ${escapeHtml(result.endDate)}. ${escapeHtml(result.assumptions)} Backtest performance is hypothetical and can differ materially from live results.</p>`;
  container.classList.remove("hidden");
}

async function runHistoricalCheck(key, capital) {
  const button = document.getElementById("run-backtest");
  button.disabled = true;
  button.textContent = "Loading daily data…";
  try {
    const data = await fetchAnalysis(key, capital);
    renderBacktestResult(data);
    return true;
  } catch (error) {
    const container = document.getElementById("backtest-results");
    container.innerHTML = `<p class="analysis-error">${escapeHtml(error.message)}</p>`;
    container.classList.remove("hidden");
    document.getElementById("backtest-empty").classList.add("hidden");
    return false;
  } finally {
    button.textContent = "Run historical check";
    button.disabled = !appStatus.authenticated || !watchlist.includes(key);
  }
}

async function startPaperSimulation() {
  if (!appStatus.connected) {
    showToast("Connect the live quote stream before starting paper automation.");
    return;
  }
  if (!document.getElementById("paper-form").reportValidity()) return;
  const keys = watchlist.filter(key => instrumentsByKey.get(key)?.isEquity).slice(0, 10);
  if (!keys.length) {
    showToast("Add at least one NSE/BSE equity to your watchlist first.");
    return;
  }
  const capital = Number(document.getElementById("paper-capital").value);
  const riskPct = Number(document.getElementById("paper-risk").value);
  const allocationPct = Number(document.getElementById("paper-allocation").value);
  const maxDrawdownPct = Number(document.getElementById("paper-drawdown").value);
  if (capital < 1000 || capital > 100000000 || riskPct < 0.1 || riskPct > 1 ||
      allocationPct < 1 || allocationPct > 20 || maxDrawdownPct < 1 || maxDrawdownPct > 20) {
    showToast("Check capital and risk settings; values exceed the paper simulator limits.");
    return;
  }

  const button = document.getElementById("paper-toggle");
  button.disabled = true;
  button.textContent = "Loading analysis…";
  try {
    for (const key of keys) await fetchAnalysis(key);
    if (!paper.positions.length && !paper.trades.length) {
      paper.startingCapital = capital;
      paper.cash = capital;
      paper.peakEquity = capital;
    }
    paper.settings = { riskPct, allocationPct, maxDrawdownPct };
    paper.enabled = true;
    savePaper();
    for (const key of keys) {
      const currentPrice = quotes.get(key)?.price;
      if (currentPrice) processPaperQuote(key, currentPrice);
    }
    showToast("Paper simulation started. It cannot place real orders.");
  } catch (error) {
    showToast(`Could not load strategy data: ${error.message}`);
  } finally {
    button.disabled = false;
    renderPaper();
  }
}

function closePaperPosition(position, price, reason) {
  const proceeds = price * position.quantity;
  const pnl = (price - position.entryPrice) * position.quantity;
  paper.cash += proceeds;
  paper.positions = paper.positions.filter(item => item.key !== position.key);
  paper.trades.unshift({
    key: position.key,
    side: "SELL",
    quantity: position.quantity,
    price,
    pnl,
    reason,
    time: Date.now()
  });
  paper.trades = paper.trades.slice(0, 1000);
  savePaper();
  showToast(`Paper position ${position.key} closed: ${reason} (${money(pnl)} P&L).`);
}

function processPaperQuote(key, price) {
  if (!paper.enabled || !appStatus.connected) return;
  const equity = paperEquity();
  paper.peakEquity = Math.max(paper.peakEquity, equity);
  const drawdownPct = paper.peakEquity > 0 ? (paper.peakEquity - equity) / paper.peakEquity * 100 : 0;
  if (paperDrawdownReached(paper.peakEquity, equity, paper.settings.maxDrawdownPct)) {
    paper.enabled = false;
    paper.locked = true;
    savePaper();
    showToast("Paper simulation paused at its drawdown limit. Reset before restarting.");
    renderPaper();
    return;
  }

  const position = paper.positions.find(item => item.key === key);
  if (position) {
    const analysis = analysisBySymbol.get(key)?.indicators;
    const reason = paperExitReason(price, position, analysis?.sma20);
    if (reason) closePaperPosition(position, price, reason);
    renderPaper();
    return;
  }

  const instrument = instrumentsByKey.get(key);
  const indicators = analysisBySymbol.get(key)?.indicators;
  if (!instrument?.isEquity || !indicators?.entryCondition ||
      paper.positions.length >= 5 || !Number.isFinite(indicators.atr14) || indicators.atr14 <= 0) return;

  const order = calculatePaperOrder({
    equity,
    cash: paper.cash,
    price,
    atr: indicators.atr14,
    riskPct: paper.settings.riskPct,
    allocationPct: paper.settings.allocationPct
  });
  if (order.error) return;

  paper.cash -= order.cost;
  paper.positions.push({
    key,
    quantity: order.quantity,
    entryPrice: price,
    stopPrice: order.stopPrice,
    targetPrice: order.targetPrice,
    openedAt: Date.now()
  });
  savePaper();
  showToast(`Paper BUY ${key}: ${order.quantity} shares at ${money(price)}. No broker order sent.`);
  renderPaper();
}

function updatePlanner() {
  const account = Number(document.getElementById("account-value").value);
  const riskPercent = Number(document.getElementById("risk-percent").value);
  const entry = Number(document.getElementById("entry-price").value);
  const stop = Number(document.getElementById("stop-price").value);
  const result = document.getElementById("shares-result");
  const detail = document.getElementById("risk-result");
  if (![account, riskPercent, entry, stop].every(Number.isFinite) || account <= 0 ||
      riskPercent < 0.1 || riskPercent > 5 || entry <= stop || stop <= 0) {
    result.textContent = "Check your inputs";
    detail.textContent = "Entry must exceed stop; risk must be 0.1–5%.";
    return;
  }
  const risk = account * riskPercent / 100;
  const shares = Math.floor(risk / (entry - stop));
  result.textContent = `${shares.toLocaleString("en-IN")} ${shares === 1 ? "share" : "shares"}`;
  detail.textContent = `About ${money(risk)} at risk if the stop is reached`;
}

function updateOrderControls() {
  const available = appStatus.authenticated && instruments.some(item => item.isEquity);
  for (const id of ["order-symbol", "order-quantity", "order-price", "order-side", "preview-order"]) {
    document.getElementById(id).disabled = !available;
  }
  if (available && !document.getElementById("order-symbol").value) {
    document.getElementById("order-symbol").value = "NSE:RELIANCE";
  }
}

function populateInstrumentOptions() {
  const equities = instruments.filter(item => item.isEquity);
  document.getElementById("instrument-options").innerHTML = equities.map(item =>
    `<option value="${escapeHtml(keyFor(item))}">${escapeHtml(item.name)}</option>`
  ).join("");
}

function recordQuote(key, quote) {
  if (!key || !Number.isFinite(Number(quote.price))) return;
  const normalized = {
    price: Number(quote.price),
    change: Number.isFinite(Number(quote.change)) ? Number(quote.change) : null,
    ohlc: quote.ohlc || null,
    volume: quote.volume || null,
    timestamp: quote.timestamp || null
  };
  quotes.set(key, normalized);
  processPaperQuote(key, normalized.price);
  const instrument = instrumentsByKey.get(key);
  if (instrument && normalized.price > 0) {
    document.getElementById("order-price").placeholder = `e.g. ${normalized.price.toFixed(2)}`;
  }
  checkAlerts(key, normalized.price);
}

function checkAlerts(key, price) {
  let changed = false;
  for (const alert of alerts) {
    if (alert.key !== key || alert.triggered) continue;
    const reached = alert.condition === "above" ? price >= alert.price : price <= alert.price;
    if (reached) {
      alert.triggered = true;
      changed = true;
      showToast(`${key} crossed your ${alert.condition} ${money(alert.price)} alert.`);
      if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        new Notification("MarketLens price alert", { body: `${key} crossed ${money(alert.price)}.` });
      }
    }
  }
  if (changed) {
    localStore.write("marketlens-alerts", alerts);
    renderAlerts();
  }
}

async function subscribeToKeys(keys) {
  if (!appStatus.authenticated || !keys.length) return false;
  try {
    await requestJson("/api/market/subscribe", {
      method: "POST",
      body: JSON.stringify({ symbols: [...new Set(keys)] })
    });
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

function connectMarketSocket() {
  if (marketSocket) marketSocket.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  marketSocket = new WebSocket(`${protocol}//${location.host}/ws`);
  marketSocket.addEventListener("message", event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      console.warn("Ignored malformed market-data message.", error);
      return;
    }
    if (message.type === "status") {
      appStatus.connected = Boolean(message.connected);
      setConnectionStatus(appStatus, message.error || "");
      renderIndexCards();
      renderPaper();
    }
    if (message.type === "ticks") {
      for (const tick of message.data || []) {
        const instrument = instrumentsByToken.get(Number(tick.token));
        if (instrument) recordQuote(keyFor(instrument), tick);
      }
      renderStocks();
      renderWatchlist();
      renderIndexCards();
    }
  });
  marketSocket.addEventListener("close", () => {
    if (appStatus.authenticated) {
      appStatus.connected = false;
      setConnectionStatus(appStatus);
      renderIndexCards();
    }
  });
  marketSocket.addEventListener("error", () => {
    showToast("Live quote stream could not connect. Check the local app and Kite session.");
  });
}

async function loadAuthenticatedData() {
  instruments = await requestJson("/api/instruments");
  instrumentsByKey = new Map(instruments.map(item => [keyFor(item), item]));
  instrumentsByToken = new Map(instruments.map(item => [Number(item.token), item]));
  populateInstrumentOptions();
  renderStocks();
  renderWatchlist();
  renderAlerts();
  renderAccount();
  updateOrderControls();
  connectMarketSocket();
  void refreshMarketScan();
  void refreshJio();
  await refreshAccount();

  const quoteKeys = [...new Set([
    ...Object.keys(indexCards),
    ...featuredKeys,
    ...watchlist,
    ...alerts.map(alert => alert.key)
  ])].filter(key => instrumentsByKey.has(key)).slice(0, 40);
  await subscribeToKeys(quoteKeys);
  if (quoteKeys.length) {
    try {
      const snapshot = await requestJson(`/api/quotes?symbols=${encodeURIComponent(quoteKeys.join(","))}`);
      for (const item of snapshot) recordQuote(item.key, item);
      renderStocks();
      renderWatchlist();
      renderIndexCards();
    } catch (error) {
      showToast(`Live quote snapshot unavailable: ${error.message}`);
    }
  }
}

async function refreshStatus() {
  try {
    const previousAuth = appStatus.authenticated;
    appStatus = await requestJson("/api/status");
    const recoveringIdeas = Boolean(ideasStatusError);
    ideasStatusError = "";
    if (previousAuth !== appStatus.authenticated) marketSessionGeneration += 1;
    setConnectionStatus(appStatus, appStatus.error || "");
    if (appStatus.authenticated && (!previousAuth || !instruments.length)) {
      await loadAuthenticatedData();
    } else if (!appStatus.authenticated && previousAuth) {
      instruments = [];
      instrumentsByKey.clear();
      instrumentsByToken.clear();
      quotes.clear();
      analysisBySymbol.clear();
      analysisRequests.clear();
      accountSnapshot = null;
      ideaHoldingsError = "";
      marketScan = null;
      scanError = "";
      scanRequestVersion += 1;
      renderMarketScan();
      void refreshIdeas();
      void refreshJio();
      renderStocks();
      renderWatchlist();
      renderAlerts();
      renderIndexCards();
      renderAccount();
      renderIdeas();
      updateOrderControls();
    } else if (recoveringIdeas && appStatus.authenticated) {
      void refreshAccount();
      void refreshJio();
    } else if (recoveringIdeas) {
      renderIdeas();
      renderJio();
    }
    if (!appStatus.authenticated && !appStatus.configured) {
      document.getElementById("quote-foot").textContent = "Set up a Kite Connect app and local credentials to load live data.";
    }
    renderPaper();
  } catch (error) {
    ideasGeneration += 1;
    ideasLoading = false;
    ideasStatusError = error.message;
    renderIdeas();
    jioGeneration += 1;
    jioLoading = false;
    renderJio();
    setConnectionStatus({ configured: false, authenticated: false, connected: false }, error.message);
    renderPaper();
  }
}

function openAlertDialog(key = "") {
  if (!appStatus.authenticated) {
    showToast("Connect Zerodha to create a live price alert.");
    return;
  }
  document.getElementById("alert-symbol").value = key || watchlist[0] || "";
  document.getElementById("alert-price").value = "";
  document.getElementById("alert-error").classList.add("hidden");
  document.getElementById("alert-dialog").showModal();
  document.getElementById("alert-price").focus();
}

function openAnalysis(key) {
  const instrument = instrumentsByKey.get(key);
  if (!instrument) return;
  currentAnalysisKey = key;
  document.getElementById("analysis-content").innerHTML = renderAnalysisHtml(key, null, "");
  document.getElementById("analysis-dialog").showModal();
  if (!appStatus.authenticated) return;
  document.getElementById("analysis-content").innerHTML = renderAnalysisHtml(key, null, "Loading up to 180 days of daily indicators…");
  fetchAnalysis(key).then(data => {
    if (document.getElementById("analysis-dialog").open && currentAnalysisKey === key) {
      document.getElementById("analysis-content").innerHTML = renderAnalysisHtml(key, data, "");
    }
  }).catch(error => {
    if (document.getElementById("analysis-dialog").open && currentAnalysisKey === key) {
      document.getElementById("analysis-content").innerHTML = renderAnalysisHtml(key, null, error.message);
    }
  });
}

function renderPriceChart(data) {
  const chart = buildPriceChart(data.candles, data.backtest);
  if (chart.error) return `<p class="analysis-error">${escapeHtml(chart.error)}</p>`;
  const left = 60, right = 480, top = 20, bottom = 200;
  const x = index => left + index / (chart.points.length - 1) * (right - left);
  const y = value => bottom - (value - chart.min) / (chart.max - chart.min) * (bottom - top);
  const line = field => chart.points.map((point, index) =>
    Number.isFinite(point[field]) ? `${x(index).toFixed(1)},${y(point[field]).toFixed(1)}` : "").filter(Boolean).join(" ");
  const marker = item => `<circle cx="${x(item.index).toFixed(1)}" cy="${y(item.price).toFixed(1)}" r="4" fill="${item.side === "buy" ? "#128765" : "#c34659"}"><title>Simulated ${item.side} ${escapeHtml(item.date)} at ${escapeHtml(money(item.price))}</title></circle>`;
  return `<figure class="chart-wrap">
    <svg viewBox="0 0 500 235" role="img" aria-label="Daily closing prices with 20 and 50 day moving averages and historical simulated trade markers">
      <line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="#cdd4e0"/><line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#cdd4e0"/>
      <text x="0" y="${top + 4}">${escapeHtml(money(chart.max))}</text><text x="0" y="${bottom}">${escapeHtml(money(chart.min))}</text>
      <polyline fill="none" stroke="#4867db" stroke-width="2" points="${line("close")}"/>
      <polyline fill="none" stroke="#dd9c28" stroke-width="1.5" points="${line("sma20")}"/>
      <polyline fill="none" stroke="#8c63c7" stroke-width="1.5" points="${line("sma50")}"/>
      ${chart.markers.map(marker).join("")}
      <text x="${left}" y="223">${escapeHtml(chart.points[0].date)}</text><text x="${right}" y="223" text-anchor="end">${escapeHtml(chart.points.at(-1).date)}</text>
    </svg>
    <figcaption class="chart-caption">Blue: daily close · orange: SMA 20 · purple: SMA 50. Green/red dots: historical simulated buy/sell fills, not real trades or future signals. Shows up to 90 completed daily candles. Past results do not predict returns.</figcaption>
  </figure>`;
}

function renderAnalysisHtml(key, analysisData, analysisMessage) {
  const instrument = instrumentsByKey.get(key);
  if (!instrument) return "";
  const quote = quotes.get(key);
  const change = Number.isFinite(quote?.change) ? `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}%` : "—";
  const indicators = analysisData?.indicators;
  const signalSection = indicators ? `
    <div class="analysis-stat-grid extended-stat-grid">
      <div class="analysis-stat"><span>Indicator agreement</span><strong>${indicators.score}/100 · ${escapeHtml(indicators.trend)}</strong></div>
      <div class="analysis-stat"><span>SMA 20 / 50</span><strong>${money(indicators.sma20)} / ${money(indicators.sma50)}</strong></div>
      <div class="analysis-stat"><span>RSI (14)</span><strong>${indicators.rsi14.toFixed(1)}</strong></div>
      <div class="analysis-stat"><span>MACD histogram</span><strong>${money(indicators.macd.histogram)}</strong></div>
      <div class="analysis-stat"><span>ATR (14)</span><strong>${money(indicators.atr14)}</strong></div>
      <div class="analysis-stat"><span>Last daily candle</span><strong>${escapeHtml(indicators.latestDate)}</strong></div>
    </div>
    <p class="analysis-copy"><strong>Score components:</strong> close above SMA 20 ${indicators.components.priceAboveSma20 ? "✓" : "—"}; SMA 20 above SMA 50 ${indicators.components.sma20AboveSma50 ? "✓" : "—"}; MACD histogram positive ${indicators.components.macdPositive ? "✓" : "—"}; RSI between 45 and 70 ${indicators.components.rsiInNeutralRange ? "✓" : "—"}. This is a fixed indicator checklist, not a probability, forecast, or buy/sell recommendation.</p>
    ${analysisData.backtest && !analysisData.backtest.error ? `<div class="analysis-backtest"><strong>Historical rule simulation:</strong> ${analysisData.backtest.tradeCount} closed trades · return ${analysisData.backtest.totalReturnPct.toFixed(2)}% · max drawdown ${analysisData.backtest.maxDrawdownPct.toFixed(2)}%<br><small>${escapeHtml(analysisData.backtest.assumptions)}</small></div>` : ""}
  ` : "";
  const statusMessage = analysisMessage
    ? `<p class="analysis-copy ${analysisMessage.startsWith("Loading") ? "" : "analysis-error"}">${escapeHtml(analysisMessage)}</p>`
    : "";
  return `
    <p class="eyebrow">LIVE KITE CONNECT QUOTE</p>
    <div class="analysis-content-head">
      <span class="stock-avatar">${escapeHtml(instrument.symbol.slice(0, 2))}</span>
      <span><h2 class="analysis-title">${escapeHtml(instrument.name)}</h2><p class="analysis-subtitle">${escapeHtml(key)} · ${quote ? "Quote received" : "Waiting for quote"}</p></span>
      <span class="analysis-price">${quote ? money(quote.price) : "--"}</span>
    </div>
    <div class="analysis-stat-grid">
      <div class="analysis-stat"><span>Day change</span><strong>${change}</strong></div>
      <div class="analysis-stat"><span>Day high / low</span><strong>${quote?.ohlc ? `${money(quote.ohlc.high)} / ${money(quote.ohlc.low)}` : "—"}</strong></div>
      <div class="analysis-stat"><span>Volume</span><strong>${quote?.volume ? Number(quote.volume).toLocaleString("en-IN") : "—"}</strong></div>
    </div>
    ${analysisData ? renderPriceChart(analysisData) : ""}${signalSection}${statusMessage}
    <div class="analysis-warning"><strong>Risk notice:</strong> Live market quotes are not guaranteed execution prices. Prices can move, orders can be rejected or partially filled, and you can lose money. Use the broker's order book to verify any submitted order.</div>
    <div class="analysis-actions"><button class="button button-secondary" data-modal-watch="${escapeHtml(key)}">${watchlist.includes(key) ? "★ In watchlist" : "☆ Add to watchlist"}</button><button class="button button-secondary" data-modal-alert="${escapeHtml(key)}">＋ Set price alert</button><button class="button button-secondary" data-modal-backtest="${escapeHtml(key)}">Run backtest</button><button class="button button-primary" data-modal-order="${escapeHtml(key)}">Review order</button></div>`;
}

function resetConfirmButton() {
  const enabled = document.getElementById("confirm-order-checkbox").checked &&
    document.getElementById("confirm-order-text").value === "PLACE ORDER";
  document.getElementById("confirm-order-button").disabled = !enabled || !pendingPreview;
}

document.getElementById("market-date").textContent = new Intl.DateTimeFormat("en-IN", {
  weekday: "short", day: "numeric", month: "short", year: "numeric"
}).format(new Date());
renderStocks();
renderWatchlist();
renderAlerts();
renderIndexCards();
renderAccount();
renderJio();
updatePlanner();
refreshStatus();
window.setInterval(refreshStatus, 20000);
window.setInterval(() => void refreshMarketScan(), 15000);
window.setInterval(() => { if (!jioLoading && appStatus.authenticated && !ideasStatusError) void refreshJio(); }, 15 * 60 * 1000);

function openSetup() {
  document.getElementById("setup-redirect").textContent = `${location.origin}/auth/kite/callback`;
  document.getElementById("setup-error").classList.add("hidden");
  document.getElementById("setup-dialog").showModal();
}

document.getElementById("connect-button").addEventListener("click", () => {
  if (!appStatus.configured) {
    openSetup();
    return;
  }
  location.assign("/api/login");
});
document.getElementById("change-setup-button").addEventListener("click", openSetup);
document.getElementById("cancel-setup").addEventListener("click", () => document.getElementById("setup-dialog").close());
document.getElementById("setup-dialog").addEventListener("close", () => {
  document.getElementById("setup-form").reset();
  document.getElementById("setup-error").textContent = "";
  document.getElementById("setup-error").classList.add("hidden");
});
document.getElementById("setup-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = document.getElementById("save-setup");
  const errorNode = document.getElementById("setup-error");
  button.disabled = true;
  errorNode.classList.add("hidden");
  try {
    await requestJson("/api/setup", {
      method: "POST",
      body: JSON.stringify({
        apiKey: document.getElementById("setup-api-key").value,
        apiSecret: document.getElementById("setup-api-secret").value
      })
    });
    document.getElementById("setup-dialog").close();
    appStatus.configured = true;
    setConnectionStatus(appStatus);
    showToast("API setup saved for this session. Select Connect Zerodha to sign in.");
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.classList.remove("hidden");
  } finally {
    button.disabled = false;
  }
});
document.getElementById("logout-button").addEventListener("click", async () => {
  try {
    await requestJson("/api/logout", { method: "POST", body: "{}" });
    showToast("Disconnected from this app. Log out of Kite separately if needed.");
    await refreshStatus();
  } catch (error) {
    showToast(error.message);
  }
});
document.getElementById("stock-search").addEventListener("input", renderStocks);
document.getElementById("signal-filter").addEventListener("change", renderStocks);
document.getElementById("stock-sort").addEventListener("change", renderStocks);
document.getElementById("refresh-jio").addEventListener("click", () => void refreshJio());
let researchSelectionVersion = 0;
document.getElementById("research-symbol").addEventListener("change", () => {
  researchSelectionVersion += 1;
  document.getElementById("research-result").textContent = "";
});
async function runFilingResearch(generate) {
  const buttons = [document.getElementById("research-evidence"), document.getElementById("research-generate")];
  const result = document.getElementById("research-result");
  const selectionVersion = researchSelectionVersion;
  const symbol = document.getElementById("research-symbol").value;
  buttons.forEach(button => { button.disabled = true; });
  result.textContent = generate ? "Retrieving public evidence and generating summary…" : "Retrieving official filing evidence…";
  try {
    const data = await requestJson("/api/research", {
      method: "POST",
      body: JSON.stringify({ symbol, generate })
    });
    if (selectionVersion !== researchSelectionVersion) return;
    const source = data.source;
    result.innerHTML = `<div class="research-result"><p><strong>${escapeHtml(source.title)}</strong><br>${escapeHtml(source.period)} · retrieved ${escapeHtml(new Date(data.retrievedAt).toLocaleString())}<br><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">Open official filing</a></p>
      ${data.warning ? `<p class="account-error">${escapeHtml(data.warning)}</p>` : ""}
      ${data.summary ? `<p class="research-summary"><strong>AI summary (${escapeHtml(data.provider)}) · verify against sources</strong><br>${escapeHtml(data.summary)}</p>` : ""}
      ${data.evidence.map(item => `<div class="research-evidence"><strong>[${escapeHtml(item.id)}] Page ${item.page}</strong><br>${escapeHtml(item.excerpt)}</div>`).join("")}
      <p>Text extraction can omit table structure. Verify claims in the filing; these excerpts are not a complete analysis.</p></div>`;
  } catch (error) {
    if (selectionVersion === researchSelectionVersion) result.innerHTML = `<p class="account-error">${escapeHtml(error.message)}</p>`;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}
document.getElementById("research-evidence").addEventListener("click", () => void runFilingResearch(false));
document.getElementById("research-generate").addEventListener("click", () => void runFilingResearch(true));
document.getElementById("jio-content").addEventListener("click", event => {
  const button = event.target.closest("[data-jio-analysis]");
  if (button) openAnalysis(button.dataset.jioAnalysis);
});
document.getElementById("refresh-ideas").addEventListener("click", () => void refreshAccount());
document.getElementById("scan-toggle").addEventListener("click", async () => {
  if (!marketScan || scanActionBusy) return;
  const session = marketSessionGeneration;
  scanRequestVersion += 1;
  scanActionBusy = true;
  renderMarketScan();
  try {
    const result = await requestJson("/api/market-scan", {
      method: "POST",
      body: JSON.stringify({ action: marketScan.running ? "pause" : "start" })
    });
    if (session === marketSessionGeneration && appStatus.authenticated) {
      marketScan = result;
      scanError = "";
    }
  } catch (error) {
    if (session === marketSessionGeneration && appStatus.authenticated) scanError = error.message;
  } finally {
    scanActionBusy = false;
    renderMarketScan();
  }
});
document.getElementById("scan-content").addEventListener("click", event => {
  const button = event.target.closest("[data-scan-order]");
  if (!button || !appStatus.authenticated) return;
  document.getElementById("order-symbol").value = button.dataset.scanOrder;
  document.getElementById("order-side").value = "BUY";
  document.getElementById("order-quantity").value = "1";
  document.getElementById("order-price").value = "";
  document.getElementById("order-ticket").scrollIntoView({ behavior: "smooth", block: "center" });
  document.getElementById("order-price").focus();
});
document.getElementById("ideas-content").addEventListener("click", event => {
  const button = event.target.closest("[data-idea-order]");
  if (!button || !appStatus.authenticated) return;
  document.getElementById("order-symbol").value = button.dataset.ideaOrder;
  document.getElementById("order-side").value = button.dataset.ideaSide;
  document.getElementById("order-quantity").value = "1";
  document.getElementById("order-price").value = "";
  document.getElementById("order-ticket").scrollIntoView({ behavior: "smooth", block: "center" });
  document.getElementById("order-price").focus();
});
document.getElementById("analyze-watchlist").addEventListener("click", async () => {
  const keys = watchlist.filter(key => instrumentsByKey.get(key)?.isEquity).slice(0, 10);
  if (!keys.length) {
    showToast("Add equities to your watchlist before analyzing them.");
    return;
  }
  const button = document.getElementById("analyze-watchlist");
  button.disabled = true;
  try {
    for (let index = 0; index < keys.length; index += 1) {
      button.textContent = `Analyzing ${index + 1}/${keys.length}…`;
      await fetchAnalysis(keys[index]);
    }
    document.getElementById("stock-sort").value = "score";
    renderStocks();
    showToast("Watchlist analysis updated. Scores summarize indicator agreement, not expected returns.");
  } catch (error) {
    showToast(`Could not complete analysis: ${error.message}`);
  } finally {
    button.textContent = "Analyze watchlist";
    button.disabled = !appStatus.authenticated || !watchlist.length;
  }
});
document.getElementById("stock-rows").addEventListener("click", event => {
  const watchButton = event.target.closest("[data-watch]");
  const analysisButton = event.target.closest("[data-analysis]");
  if (watchButton) {
    const key = watchButton.dataset.watch;
    watchlist = watchlist.includes(key) ? watchlist.filter(item => item !== key) : [...watchlist, key];
    localStore.write("marketlens-watchlist", watchlist);
    subscribeToKeys([key]);
    renderStocks();
    renderWatchlist();
    void refreshIdeas();
  } else if (analysisButton) openAnalysis(analysisButton.dataset.analysis);
});
document.getElementById("watchlist-items").addEventListener("click", event => {
  const item = event.target.closest("[data-open-analysis]");
  if (item) openAnalysis(item.dataset.openAnalysis);
});
document.getElementById("watchlist-items").addEventListener("keydown", event => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-open-analysis]")) {
    event.preventDefault();
    openAnalysis(event.target.dataset.openAnalysis);
  }
});
document.getElementById("planner-form").addEventListener("input", updatePlanner);
document.getElementById("planner-form").addEventListener("submit", event => {
  event.preventDefault();
  updatePlanner();
  if (!document.getElementById("shares-result").textContent.includes("Check")) showToast("Position estimate updated");
});
document.getElementById("refresh-account").addEventListener("click", refreshAccount);
const accountTabs = document.querySelector(".account-tabs");
accountTabs.addEventListener("click", event => {
  const button = event.target.closest("[data-account-tab]");
  if (!button) return;
  activeAccountTab = button.dataset.accountTab;
  renderAccount();
});
accountTabs.addEventListener("keydown", event => {
  const buttons = [...accountTabs.querySelectorAll("[data-account-tab]")];
  const currentIndex = buttons.indexOf(event.target);
  if (currentIndex < 0) return;
  const nextIndex = event.key === "ArrowRight" ? (currentIndex + 1) % buttons.length
    : event.key === "ArrowLeft" ? (currentIndex - 1 + buttons.length) % buttons.length
      : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
  if (nextIndex < 0) return;
  event.preventDefault();
  activeAccountTab = buttons[nextIndex].dataset.accountTab;
  renderAccount();
  buttons[nextIndex].focus();
});
document.getElementById("paper-toggle").addEventListener("click", async () => {
  if (paper.enabled) {
    paper.enabled = false;
    savePaper();
    renderPaper();
    showToast("Paper simulation paused. Open paper positions remain open.");
    return;
  }
  await startPaperSimulation();
});
document.getElementById("paper-capital").addEventListener("input", event => {
  const capital = Number(event.currentTarget.value);
  if (paper.enabled || paper.positions.length || paper.trades.length ||
      !Number.isFinite(capital) || capital < 1000 || capital > 100000000) return;
  paper.startingCapital = capital;
  paper.cash = capital;
  paper.peakEquity = capital;
  savePaper();
  renderPaper();
});
document.getElementById("paper-reset").addEventListener("click", () => {
  if (!window.confirm("Reset the paper portfolio? This deletes its simulated positions and trade history. No broker account changes are made.")) return;
  const capital = Number(document.getElementById("paper-capital").value);
  if (!Number.isFinite(capital) || capital < 1000 || capital > 100000000) {
    showToast("Starting paper cash must be between ₹1,000 and ₹10 crore.");
    return;
  }
  paper = {
    startingCapital: capital,
    cash: capital,
    positions: [],
    trades: [],
    peakEquity: capital,
    enabled: false,
    locked: false,
    settings: {
      riskPct: Number(document.getElementById("paper-risk").value) || 0.5,
      allocationPct: Number(document.getElementById("paper-allocation").value) || 10,
      maxDrawdownPct: Number(document.getElementById("paper-drawdown").value) || 5
    }
  };
  savePaper();
  renderPaper();
});
document.getElementById("backtest-form").addEventListener("submit", async event => {
  event.preventDefault();
  const key = document.getElementById("backtest-symbol").value;
  const capital = Number(document.getElementById("backtest-capital").value);
  if (!key || !Number.isFinite(capital) || capital < 1000 || capital > 100000000) {
    showToast("Select a watchlist equity and enter simulation capital from ₹1,000 to ₹10 crore.");
    return;
  }
  await runHistoricalCheck(key, capital);
});
["create-alert-top", "create-alert-inline", "create-alert-empty"].forEach(id => {
  document.getElementById(id).addEventListener("click", () => openAlertDialog());
});
document.getElementById("cancel-alert").addEventListener("click", () => document.getElementById("alert-dialog").close());
document.getElementById("alert-form").addEventListener("submit", async event => {
  event.preventDefault();
  const key = document.getElementById("alert-symbol").value.trim().toUpperCase();
  const condition = document.getElementById("alert-condition").value;
  const price = Number(document.getElementById("alert-price").value);
  const error = document.getElementById("alert-error");
  const instrument = instrumentsByKey.get(key);
  if (!instrument?.isEquity || !Number.isFinite(price) || price <= 0) {
    error.textContent = "Choose an NSE/BSE equity and enter a target price above zero.";
    error.classList.remove("hidden");
    return;
  }
  alerts = [{ id: crypto.randomUUID(), key, condition, price, triggered: false }, ...alerts];
  if (await subscribeToKeys([key]) && localStore.write("marketlens-alerts", alerts)) {
    renderAlerts();
    document.getElementById("alert-dialog").close();
    showToast("Price alert saved. It will trigger while this app is open and connected.");
  }
});
document.getElementById("alerts-content").addEventListener("click", event => {
  const button = event.target.closest("[data-delete-alert]");
  if (!button) return;
  alerts = alerts.filter(alert => alert.id !== button.dataset.deleteAlert);
  localStore.write("marketlens-alerts", alerts);
  renderAlerts();
});
document.getElementById("analysis-content").addEventListener("click", event => {
  const watchButton = event.target.closest("[data-modal-watch]");
  const alertButton = event.target.closest("[data-modal-alert]");
  const orderButton = event.target.closest("[data-modal-order]");
  const backtestButton = event.target.closest("[data-modal-backtest]");
  if (watchButton) {
    const key = watchButton.dataset.modalWatch;
    watchlist = watchlist.includes(key) ? watchlist.filter(item => item !== key) : [...watchlist, key];
    localStore.write("marketlens-watchlist", watchlist);
    subscribeToKeys([key]);
    renderStocks();
    renderWatchlist();
    void refreshIdeas();
    openAnalysis(key);
  } else if (alertButton) {
    const key = alertButton.dataset.modalAlert;
    document.getElementById("analysis-dialog").close();
    openAlertDialog(key);
  } else if (orderButton) {
    const key = orderButton.dataset.modalOrder;
    document.getElementById("analysis-dialog").close();
    document.getElementById("order-symbol").value = key;
    document.getElementById("order-ticket").scrollIntoView({ behavior: "smooth", block: "center" });
    document.getElementById("order-price").focus();
  } else if (backtestButton) {
    const key = backtestButton.dataset.modalBacktest;
    document.getElementById("analysis-dialog").close();
    if (!watchlist.includes(key)) {
      watchlist = [key, ...watchlist];
      localStore.write("marketlens-watchlist", watchlist);
      subscribeToKeys([key]);
      renderWatchlist();
      renderStocks();
      void refreshIdeas();
    }
    document.getElementById("backtest-symbol").value = key;
    document.getElementById("strategy-lab").scrollIntoView({ behavior: "smooth", block: "start" });
    runHistoricalCheck(key, Number(document.getElementById("backtest-capital").value));
  }
});

document.getElementById("order-form").addEventListener("submit", async event => {
  event.preventDefault();
  const key = document.getElementById("order-symbol").value.trim().toUpperCase();
  const [exchange, ...symbolParts] = key.split(":");
  const symbol = symbolParts.join(":");
  const quantity = Number(document.getElementById("order-quantity").value);
  const price = Number(document.getElementById("order-price").value);
  const instrument = instrumentsByKey.get(`${exchange}:${symbol}`);
  const result = document.getElementById("order-result");
  if (!instrument?.isEquity) {
    showToast("Choose a valid NSE/BSE equity from the instrument list.");
    return;
  }
  try {
    const preview = await requestJson("/api/orders/preview", {
      method: "POST",
      body: JSON.stringify({
        exchange: instrument.exchange,
        symbol: instrument.symbol,
        transactionType: document.getElementById("order-side").value,
        quantity,
        price
      })
    });
    pendingPreview = preview;
    document.getElementById("order-review").innerHTML = `
      <div><strong>${escapeHtml(preview.order.transactionType)} ${escapeHtml(preview.order.exchange)}:${escapeHtml(preview.order.symbol)}</strong></div>
      <div>Order type: <strong>${preview.order.orderType}</strong> · Product: <strong>${preview.order.product}</strong></div>
      <div>Quantity: <strong>${preview.order.quantity}</strong> · Limit price: <strong>${money(preview.order.price)}</strong></div>
      <div class="review-total">Estimated order value: <strong>${money(preview.order.estimatedValue)}</strong></div>
      <div>Preview expires in 60 seconds. Final margin, fees, taxes and execution are determined by Zerodha.</div>`;
    document.getElementById("confirm-order-checkbox").checked = false;
    document.getElementById("confirm-order-text").value = "";
    document.getElementById("confirm-order-text").disabled = false;
    document.getElementById("order-error").classList.add("hidden");
    document.getElementById("confirm-order-button").textContent = "Submit real order";
    document.getElementById("confirm-order-dialog").showModal();
    resetConfirmButton();
  } catch (error) {
    result.textContent = error.message;
    result.classList.remove("hidden");
  }
});
document.getElementById("confirm-order-checkbox").addEventListener("change", resetConfirmButton);
document.getElementById("confirm-order-text").addEventListener("input", resetConfirmButton);
document.getElementById("cancel-order").addEventListener("click", () => {
  pendingPreview = null;
  document.getElementById("confirm-order-dialog").close();
});
document.getElementById("confirm-order-button").addEventListener("click", async event => {
  if (!pendingPreview) return;
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Submitting…";
  try {
    const response = await requestJson("/api/orders/confirm", {
      method: "POST",
      body: JSON.stringify({
        id: pendingPreview.id,
        confirmationText: document.getElementById("confirm-order-text").value,
        accepted: document.getElementById("confirm-order-checkbox").checked
      })
    });
    pendingPreview = null;
    document.getElementById("confirm-order-dialog").close();
    const result = document.getElementById("order-result");
    result.textContent = `Order submitted to Zerodha. Order ID: ${response.orderId}. Check the Kite order book to verify its status.`;
    result.classList.remove("hidden");
    showToast("Order sent. Verify the status in Kite.");
    refreshAccount();
  } catch (error) {
    document.getElementById("order-error").textContent = error.message;
    document.getElementById("order-error").classList.remove("hidden");
    button.textContent = "Submit real order";
    resetConfirmButton();
  }
});
document.getElementById("confirm-order-dialog").addEventListener("close", () => {
  if (pendingPreview) {
    pendingPreview = null;
    document.getElementById("confirm-order-checkbox").checked = false;
    document.getElementById("confirm-order-text").value = "";
  }
});
document.getElementById("dismiss-notice").addEventListener("click", () => document.querySelector(".notice-banner").remove());
document.getElementById("help-button").addEventListener("click", () => {
  showToast("Quotes require Kite Connect; orders are live limit/CNC only and require two explicit confirmations.");
});
document.getElementById("view-all").addEventListener("click", event => {
  event.preventDefault();
  document.getElementById("stock-search").value = "";
  document.getElementById("signal-filter").value = "all";
  renderStocks();
});
