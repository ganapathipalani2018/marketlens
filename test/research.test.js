import test from "node:test";
import assert from "node:assert/strict";
import { createResearchService, selectEvidence } from "../lib/research.js";

const pages = [
  { page: 1, text: "General information about the company." },
  { page: 2, text: "Quarterly revenue and profit growth in the financial business." }
];
const pdf = () => new Response("mock pdf", { headers: { "content-type": "application/pdf" } });
const aiResponse = text => Response.json({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text }] }]
});

test("evidence ranks relevant pages and rejects unsupported symbols", async () => {
  const evidence = selectEvidence(pages);
  assert.equal(evidence[0].page, 2);
  assert.equal(evidence[0].id, "S1");
  assert.ok(evidence.every(item => item.excerpt.length <= 800));
  const service = createResearchService({ fetchImpl: () => { throw new Error("unexpected fetch"); } });
  for (const symbol of ["NSE:OTHER", "toString"]) {
    await assert.rejects(service.research(symbol, false), /only for NSE:JPL and NSE:JIOFIN/);
  }
});

test("evidence retrieval uses fixed sources, coalesces requests and caches results without AI calls", async () => {
  const calls = [];
  let extractions = 0;
  const service = createResearchService({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return pdf();
    },
    extractPages: async () => { extractions += 1; return pages; },
    env: { RESEARCH_AI_PROVIDER: "openai", OPENAI_API_KEY: "test-key", OPENAI_MODEL: "test-model" }
  });
  const [first, second] = await Promise.all([
    service.research("NSE:JIOFIN", false),
    service.research("NSE:JIOFIN", false)
  ]);
  assert.deepEqual(first, second);
  assert.equal((await service.research("NSE:JIOFIN", false)).symbol, "NSE:JIOFIN");
  assert.equal(calls.length, 1);
  assert.equal(extractions, 1);
  assert.equal(new URL(calls[0].url).hostname, "www.bseindia.com");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(first.evidence[0].page, 2);
  await service.research("NSE:JPL", false);
  assert.equal(new URL(calls[1].url).hostname, "myjiostatic.cdn.jio.com");
});

test("filing failures surface and are not cached", async () => {
  const responses = [
    () => { throw new Error("network details"); },
    () => new Response("", { status: 403 }),
    () => new Response("not a PDF", { headers: { "content-type": "text/html" } }),
    () => new Response("", { headers: { "content-type": "application/pdf", "content-length": String(9 * 1024 * 1024) } }),
    () => pdf(),
    () => pdf()
  ];
  let extractionCount = 0;
  const service = createResearchService({
    fetchImpl: async () => responses.shift()(),
    extractPages: async () => ++extractionCount === 1 ? [] : pages
  });
  for (const message of [/securely download/, /HTTP 403/, /did not return a PDF/, /size limit/, /No searchable text/]) {
    await assert.rejects(service.research("NSE:JPL", false), message);
  }
  assert.ok((await service.research("NSE:JPL", false)).evidence.length);
});

test("filing download enforces its limit even without a content length", async () => {
  const service = createResearchService({
    fetchImpl: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
      headers: { "content-type": "application/pdf" }
    }),
    extractPages: async () => { throw new Error("oversized PDF should not be parsed"); }
  });
  await assert.rejects(service.research("NSE:JPL", false), /size limit/);
});

test("OpenAI generation sends only public evidence and fixed instructions on explicit request", async () => {
  const calls = [];
  const service = createResearchService({
    env: { RESEARCH_AI_PROVIDER: "openai", OPENAI_MODEL: "test-model", OPENAI_API_KEY: "test-key", KITE_API_SECRET: "private-broker-secret" },
    extractPages: async () => pages,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.startsWith("https://api.openai.com/") ? aiResponse("Revenue grew [S1].") : pdf();
    }
  });
  const result = await service.research("NSE:JIOFIN", true);
  assert.equal(result.summary, "Revenue grew [S1].");
  assert.equal(result.provider, "openai");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.redirect, "error");
  const payload = JSON.parse(calls[1].options.body);
  assert.equal(payload.store, false);
  assert.match(payload.input, /\[S1\] Page 2/);
  assert.doesNotMatch(calls[1].options.body, /private-broker-secret|test-key/);
  assert.match(payload.instructions, /untrusted data/);
});

test("provider configuration and errors are surfaced; auto fallback is disclosed", async () => {
  const create = (env, providerResponse) => createResearchService({
    env,
    extractPages: async () => pages,
    fetchImpl: async url => {
      if (url.startsWith("http://127.0.0.1:11434/")) throw new Error("local unavailable");
      if (url.startsWith("https://api.openai.com/")) return providerResponse;
      return pdf();
    }
  });
  await assert.rejects(create({}, null).research("NSE:JPL", true), /not configured/);
  await assert.rejects(create({ RESEARCH_AI_PROVIDER: "openai" }, null).research("NSE:JPL", true), /OPENAI_MODEL and OPENAI_API_KEY/);
  const settings = { RESEARCH_AI_PROVIDER: "auto", RESEARCH_OLLAMA_MODEL: "test", OPENAI_MODEL: "test", OPENAI_API_KEY: "test" };
  const result = await create(settings, aiResponse("Summary [S1]")).research("NSE:JPL", true);
  assert.equal(result.provider, "openai");
  assert.match(result.warning, /sent to OpenAI/);
  await assert.rejects(create(settings, new Response("", { status: 401 })).research("NSE:JPL", true), /HTTP 401/);
});

test("Ollama generation stays local and reports empty responses", async () => {
  const calls = [];
  let text = "Local summary [S1]";
  const service = createResearchService({
    env: { RESEARCH_AI_PROVIDER: "ollama", RESEARCH_OLLAMA_MODEL: "test-model" },
    extractPages: async () => pages,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.startsWith("http://127.0.0.1:11434/") ? Response.json({ response: text }) : pdf();
    }
  });
  assert.equal((await service.research("NSE:JPL", true)).summary, text);
  assert.equal(calls[1].url, "http://127.0.0.1:11434/api/generate");
  assert.equal(calls[1].options.redirect, "error");
  text = " ";
  await assert.rejects(service.research("NSE:JPL", true), /returned no text/);
  assert.equal(calls.length, 3);
});
