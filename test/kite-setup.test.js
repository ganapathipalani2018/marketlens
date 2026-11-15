import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";

test("in-app setup and mocked Kite login preserve credentials and start the ticker safely", async t => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  let server;
  const start = async (mockKite = false, missingToken = false, streamRejected = false) => {
    const mockScript = `
      import { KiteConnect, KiteTicker } from "kiteconnect";
      KiteConnect.prototype.generateSession = async () => ({ access_token: process.env.MOCK_MISSING_TOKEN ? "" : "mock-access-token", user_name: "Test", user_id: "TEST", broker: "Test" });
      KiteConnect.prototype.getInstruments = async exchange => exchange === "NSE"
        ? [
          { exchange: "NSE", tradingsymbol: "NIFTY 50", instrument_token: 123, instrument_type: "INDEX", segment: "INDICES" },
          { exchange: "NSE", tradingsymbol: "MOCK", instrument_token: 124, instrument_type: "EQ", segment: "NSE" }
        ]
        : [];
      KiteConnect.prototype.getHistoricalData = async (token, interval) => Array.from({ length: 70 }, (_, index) => {
        const close = 100 + Math.floor(index / 2) * 0.1 + (index % 2 ? -0.2 : 0);
        return { date: new Date(Date.now() - (70 - index) * (interval === "day" ? 86400000 : 300000)), open: close, high: close + 0.5, low: close - 0.5, close, volume: 1000 };
      });
      KiteTicker.prototype.autoReconnect = function (enabled) {
        if (enabled !== false) throw new Error("SDK auto-reconnect can terminate the server");
      };
      KiteTicker.prototype.on = function (event, handler) {
        this.mockHandlers = this.mockHandlers || {};
        this.mockHandlers[event] = handler;
      };
      KiteTicker.prototype.connect = function () {
        if (this.access_token !== "mock-access-token") throw new Error("Ticker did not receive the session token");
        if (process.env.MOCK_STREAM_REJECTED) {
          this.mockHandlers.error(new Error("Unexpected server response: 403"));
          this.mockHandlers.disconnect({});
        }
      };
      KiteTicker.prototype.disconnect = function () {};
      await import("./server.js");
    `;
    const args = mockKite ? ["--input-type=module", "-e", mockScript] : ["server.js"];
    server = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        KITE_API_KEY: "",
        KITE_API_SECRET: "",
        KITE_REDIRECT_URL: `${origin}/auth/kite/callback`,
        MOCK_MISSING_TOKEN: missingToken ? "1" : "",
        MOCK_STREAM_REJECTED: streamRejected ? "1" : ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await Promise.race([
      once(server.stdout, "data"),
      once(server, "exit").then(([code]) => { throw new Error(`Test server exited with code ${code}`); })
    ]);
  };
  const stop = async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
  };
  t.after(stop);
  const setup = (body, requestOrigin = origin) => fetch(`${origin}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: requestOrigin },
    body: JSON.stringify(body)
  });

  await start();
  assert.equal((await fetch(`${origin}/api/status`).then(response => response.json())).configured, false);
  const researchRequest = (body, requestOrigin = origin) => fetch(`${origin}/api/research`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: requestOrigin },
    body: JSON.stringify(body)
  });
  assert.equal((await researchRequest({ symbol: "NSE:JPL", generate: false }, "https://example.com")).status, 403);
  assert.equal((await researchRequest({ symbol: "NSE:OTHER", generate: false })).status, 400);
  assert.equal((await researchRequest({ symbol: "NSE:JPL", generate: "true" })).status, 400);
  assert.equal((await setup({ apiKey: "test-key", apiSecret: "test-secret" }, "https://example.com")).status, 403);
  assert.equal((await setup({ apiKey: "test-key", apiSecret: " " })).status, 400);
  assert.equal((await fetch(`${origin}/api/status`).then(response => response.json())).configured, false);

  const saved = await setup({ apiKey: "test-key", apiSecret: "test-secret" });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { configured: true });
  const status = await fetch(`${origin}/api/status`);
  assert.equal(status.headers.get("cache-control"), "no-store");
  const statusText = await status.text();
  assert.equal(JSON.parse(statusText).authenticated, false);
  assert.doesNotMatch(statusText, /test-key|test-secret/);

  const login = await fetch(`${origin}/api/login`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const loginUrl = new URL(login.headers.get("location"));
  const oldState = new URLSearchParams(loginUrl.searchParams.get("redirect_params")).get("state");
  assert.ok(oldState);
  assert.equal((await setup({ apiKey: "replacement-key", apiSecret: "replacement-secret" })).status, 200);
  const callback = await fetch(`${origin}/auth/kite/callback?status=success&request_token=fake&state=${oldState}`);
  assert.equal(callback.status, 400);

  await stop();
  await start();
  const restartedStatus = await fetch(`${origin}/api/status`).then(response => response.json());
  assert.equal(restartedStatus.configured, false);
  assert.equal(restartedStatus.authenticated, false);

  await stop();
  await start(true, true);
  assert.equal((await setup({ apiKey: "test-key", apiSecret: "test-secret" })).status, 200);
  const missingTokenLogin = await fetch(`${origin}/api/login`, { redirect: "manual" });
  const missingTokenUrl = new URL(missingTokenLogin.headers.get("location"));
  const missingTokenState = new URLSearchParams(missingTokenUrl.searchParams.get("redirect_params")).get("state");
  const missingTokenResponse = await fetch(`${origin}/auth/kite/callback?status=success&request_token=fake&state=${missingTokenState}`);
  assert.equal(missingTokenResponse.status, 502);
  assert.match((await missingTokenResponse.json()).error, /did not return an access token/);
  assert.equal((await fetch(`${origin}/api/status`).then(response => response.json())).authenticated, false);

  await stop();
  await start(true);
  assert.equal((await setup({ apiKey: "test-key", apiSecret: "test-secret" })).status, 200);
  const newLogin = await fetch(`${origin}/api/login`, { redirect: "manual" });
  const newLoginUrl = new URL(newLogin.headers.get("location"));
  const state = new URLSearchParams(newLoginUrl.searchParams.get("redirect_params")).get("state");
  const success = await fetch(`${origin}/auth/kite/callback?status=success&request_token=fake&state=${state}`, { redirect: "manual" });
  assert.equal(success.status, 302);
  assert.equal(success.headers.get("location"), "/");
  assert.equal((await fetch(`${origin}/api/status`).then(response => response.json())).authenticated, true);
  let scan;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    scan = await fetch(`${origin}/api/market-scan`).then(response => response.json());
    if (scan.cycle > 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(scan.total, 1);
  assert.equal(scan.cycle, 1);
  assert.equal(scan.candidates.day[0].symbol, "NSE:MOCK");
  assert.equal(scan.candidates["5minute"][0].symbol, "NSE:MOCK");
  const controlScan = (action, requestOrigin = origin) => fetch(`${origin}/api/market-scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: requestOrigin },
    body: JSON.stringify({ action })
  });
  assert.equal((await controlScan("pause", "https://example.com")).status, 403);
  assert.equal((await controlScan("invalid")).status, 400);
  assert.equal((await (await controlScan("pause")).json()).running, false);
  assert.equal((await (await controlScan("start")).json()).running, true);

  await stop();
  await start(true, false, true);
  assert.equal((await setup({ apiKey: "test-key", apiSecret: "test-secret" })).status, 200);
  const rejectedLogin = await fetch(`${origin}/api/login`, { redirect: "manual" });
  const rejectedUrl = new URL(rejectedLogin.headers.get("location"));
  const rejectedState = new URLSearchParams(rejectedUrl.searchParams.get("redirect_params")).get("state");
  const rejectedCallback = await fetch(`${origin}/auth/kite/callback?status=success&request_token=fake&state=${rejectedState}`, { redirect: "manual" });
  assert.equal(rejectedCallback.status, 302);
  const rejectedStatus = await fetch(`${origin}/api/status`).then(response => response.json());
  assert.equal(rejectedStatus.authenticated, true);
  assert.equal(rejectedStatus.connected, false);
  assert.match(rejectedStatus.error, /market data \(403\).*plan, permissions/i);
});
