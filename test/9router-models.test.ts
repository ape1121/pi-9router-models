import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate HOME so the extension reads/writes a throwaway ~/.pi/agent.
const home = mkdtempSync(join(tmpdir(), "pi9r-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
process.env.NINEROUTER_API_KEY = "sk-test";

const ext = await import("../extensions/9router-models.ts");
const { glob, selected, toPiModel, resolveValue } = ext;

const MODELS = [
  { id: "ape", owned_by: "combo", capabilities: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { id: "fable", owned_by: "combo", capabilities: { vision: true, reasoning: true, thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 } },
  { id: "cx/gpt-6-astra", owned_by: "cx", capabilities: { reasoning: true, contextWindow: 272000, maxOutput: 128000 } },
  { id: "cx/gpt-6-astra-review", owned_by: "cx", capabilities: {} },
  { id: "ag/flash", owned_by: "ag", context_length: 1048576, max_completion_tokens: 65536 },
];

function fakePi() {
  const calls = { providers: [] as any[], commands: new Map<string, any>() };
  return {
    calls,
    registerProvider: (name: string, cfg: any) => calls.providers.push({ name, cfg }),
    registerCommand: (name: string, def: any) => calls.commands.set(name, def),
  } as any;
}

async function withRouter(handler: (req: any, res: any) => void, fn: (url: string) => Promise<void>) {
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as any;
  try { await fn(`http://127.0.0.1:${port}/v1`); } finally { srv.close(); }
}

const cfg = (over = {}) => ({ provider: "9router", baseUrl: "x", apiKey: "", include: ["combo"], exclude: [], timeoutMs: 1000, ...over });

test("glob matching", () => {
  assert.ok(glob("cx/gpt-6-*", "cx/gpt-6-astra"));
  assert.ok(!glob("cx/gpt-6-*", "cx/gpt-5.6-sol"));
  assert.ok(glob("*(ultra)", "cx/gpt-6-astra(ultra)"));
  assert.ok(glob("a.b", "a.b") && !glob("a.b", "axb"));
});

test("selection by owned_by group, glob, and exclude", () => {
  const ids = (c: any) => MODELS.filter((m) => selected(m, c)).map((m) => m.id);
  assert.deepEqual(ids(cfg()), ["ape", "fable"]);
  assert.deepEqual(ids(cfg({ include: ["combo", "cx/*"], exclude: ["*-review"] })), ["ape", "fable", "cx/gpt-6-astra"]);
});

test("capability mapping", () => {
  const ape = toPiModel(MODELS[0]);
  assert.equal(ape.contextWindow, 1000000);
  assert.equal(ape.maxTokens, 128000);
  assert.deepEqual(ape.input, ["text", "image"]);
  assert.equal(ape.reasoning, true);
  assert.equal((ape as any).thinkingLevelMap, undefined);
  assert.deepEqual((toPiModel(MODELS[1]) as any).thinkingLevelMap, { off: null });
  const flash = toPiModel(MODELS[4]);
  assert.equal(flash.contextWindow, 1048576);
  assert.equal(flash.maxTokens, 65536);
  assert.deepEqual(flash.input, ["text"]);
});

test("config value resolution", () => {
  process.env.FOO_KEY = "abc";
  assert.equal(resolveValue("$FOO_KEY"), "abc");
  assert.equal(resolveValue("${FOO_KEY}-x"), "abc-x");
  assert.equal(resolveValue("$$lit"), "$lit");
  assert.equal(resolveValue("!echo hi"), "hi");
  assert.equal(resolveValue("plain"), "plain");
});

test("factory registers live models, sends auth, and caches", async () => {
  let auth = "";
  await withRouter((req, res) => {
    auth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: MODELS }));
  }, async (url) => {
    process.env.NINEROUTER_BASE_URL = url + "/";
    const pi = fakePi();
    await ext.default(pi);
    assert.equal(auth, "Bearer sk-test");
    assert.equal(pi.calls.providers.length, 1);
    const { name, cfg: p } = pi.calls.providers[0];
    assert.equal(name, "9router");
    assert.equal(p.baseUrl, url);
    assert.equal(p.api, "openai-completions");
    assert.deepEqual(p.models.map((m: any) => m.id), ["ape", "fable"]);
    assert.ok(pi.calls.commands.has("9router-sync"));
    assert.ok(existsSync(join(home, ".pi", "agent", "cache", "9router-models.json")));
  });
});

test("falls back to cache when router is unreachable", async () => {
  process.env.NINEROUTER_BASE_URL = "http://127.0.0.1:1/v1";
  const pi = fakePi();
  await ext.default(pi);
  assert.deepEqual(pi.calls.providers[0].cfg.models.map((m: any) => m.id), ["ape", "fable"]);
});

test("NINEROUTER_INCLUDE env overrides filter", async () => {
  process.env.NINEROUTER_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.NINEROUTER_INCLUDE = "cx/*";
  const pi = fakePi();
  await ext.default(pi);
  delete process.env.NINEROUTER_INCLUDE;
  assert.deepEqual(pi.calls.providers[0].cfg.models.map((m: any) => m.id), ["cx/gpt-6-astra", "cx/gpt-6-astra-review"]);
});

test("registers nothing without router or cache (keeps models.json)", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "pi9r-empty-"));
  process.env.HOME = fresh;
  const mod = await import("../extensions/9router-models.ts?fresh=1");
  process.env.NINEROUTER_BASE_URL = "http://127.0.0.1:1/v1";
  const pi = fakePi();
  const origErr = console.error; console.error = () => {};
  try { await mod.default(pi); } finally { console.error = origErr; process.env.HOME = home; }
  assert.equal(pi.calls.providers.length, 0);
  assert.ok(pi.calls.commands.has("9router-sync"));
});

test("config file is honoured", async () => {
  const cfgHome = mkdtempSync(join(tmpdir(), "pi9r-cfg-"));
  const agent = join(cfgHome, ".pi", "agent");
  (await import("node:fs")).mkdirSync(agent, { recursive: true });
  await withRouter((_q, res) => res.end(JSON.stringify({ data: MODELS })), async (url) => {
    writeFileSync(join(agent, "9router.json"), JSON.stringify({ provider: "router", baseUrl: url, include: ["ag"] }));
    delete process.env.NINEROUTER_BASE_URL;
    process.env.HOME = cfgHome;
    const mod = await import("../extensions/9router-models.ts?cfg=1");
    const pi = fakePi();
    try { await mod.default(pi); } finally { process.env.HOME = home; }
    assert.equal(pi.calls.providers[0].name, "router");
    assert.deepEqual(pi.calls.providers[0].cfg.models.map((m: any) => m.id), ["ag/flash"]);
  });
});
