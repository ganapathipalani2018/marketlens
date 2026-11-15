import { tradeIdea } from "./trade-ideas.js";

export function createMarketScanner({ analyze, schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  let generation = 0;
  let timer = null;
  let running = false;
  let symbols = [];
  let index = 0;
  let cycle = 0;
  let failures = 0;
  let unavailable = 0;
  let error = "";
  let lastIssue = "";
  let current = "";
  const candidates = { day: new Map(), "5minute": new Map() };

  function snapshot() {
    return {
      running, total: symbols.length, completed: index, cycle, current, unavailable, error, lastIssue,
      candidates: Object.fromEntries(Object.entries(candidates).map(([interval, items]) =>
        [interval, [...items.values()].sort((a, b) => b.scannedAt - a.scannedAt).slice(0, 10)]))
    };
  }

  function stop() {
    generation += 1;
    running = false;
    current = "";
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function reset(newSymbols) {
    stop();
    symbols = [...new Set(newSymbols)];
    index = 0;
    cycle = 0;
    failures = 0;
    unavailable = 0;
    error = "";
    lastIssue = "";
    candidates.day.clear();
    candidates["5minute"].clear();
  }

  async function runBatch(activeGeneration) {
    timer = null;
    for (let count = 0; count < 10 && running && activeGeneration === generation; count += 1) {
      const symbol = symbols[index];
      current = symbol;
      let failed = false;
      for (const interval of ["day", "5minute"]) {
        try {
          const indicators = await analyze(symbol, interval);
          if (!running || activeGeneration !== generation) return;
          const idea = tradeIdea(indicators);
          candidates[interval].delete(symbol);
          if (idea.error) {
            unavailable += 1;
            lastIssue = `${symbol} (${interval}): ${idea.error}`;
          } else if (idea.buyCondition && idea.targetPrice !== null) {
            candidates[interval].set(symbol, { symbol, ...idea, scannedAt: now() });
            while (candidates[interval].size > 100) candidates[interval].delete(candidates[interval].keys().next().value);
          }
        } catch (failure) {
          if (!running || activeGeneration !== generation) return;
          candidates[interval].delete(symbol);
          failed = true;
          unavailable += 1;
          lastIssue = `${symbol} (${interval}): historical data request failed.`;
          console.warn("Market scan historical-data request failed:", failure?.message || "Unknown error");
        }
      }
      failures = failed ? failures + 1 : 0;
      index += 1;
      if (failures >= 3) {
        error = "Repeated historical-data requests failed. Check Kite permissions and connectivity, then resume.";
        stop();
        return;
      }
      if (index >= symbols.length) {
        index = 0;
        cycle += 1;
        break;
      }
    }
    current = "";
    if (running && activeGeneration === generation) {
      timer = schedule(() => void runBatch(activeGeneration), 60000);
    }
  }

  function start() {
    if (running || !symbols.length) return;
    running = true;
    failures = 0;
    error = "";
    const activeGeneration = ++generation;
    timer = schedule(() => void runBatch(activeGeneration), 0);
  }

  return { reset, start, stop, snapshot };
}
