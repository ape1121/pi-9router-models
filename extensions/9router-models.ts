/**
 * pi-9router-models — sync Pi's model catalogue from a local 9router instance.
 *
 * At startup (Pi awaits async factories before model resolution) this fetches
 * `GET {baseUrl}/models` from 9router and registers the result as the
 * `9router` provider. 9router becomes the single source of truth: add/remove a
 * combo there and every Pi session (CLI, Pi Web, Paperclip pi_local workers)
 * sees it on next start. `/9router-sync` refreshes a running session.
 *
 * Offline-safe: the last good catalogue is cached and used when 9router is down.
 *
 * Config (optional): ~/.pi/agent/9router.json  (env NINEROUTER_BASE_URL / NINEROUTER_INCLUDE override)
 *   {
 *     "provider": "9router",
 *     "baseUrl": "http://127.0.0.1:20128/v1",
 *     "apiKey": "$NINEROUTER_API_KEY",        // Pi config-value syntax: !cmd, $ENV, literal
 *     "include": ["combo"],                    // owned_by groups and/or id globs, e.g. "cx/gpt-6-*"
 *     "exclude": ["*-review"],
 *     "timeoutMs": 3000,
 *     "pricing": "models.dev",                 // or false; API-equivalent list prices for cost tracking
 *     "combos": { "ape": "cc/claude-opus-5-5" }, // optional: combo -> model whose price to use
 *     "prices": { "ape": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 } } // $/1M overrides
 *   }
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Cfg = {
	provider: string;
	baseUrl: string;
	apiKey: string;
	include: string[];
	exclude: string[];
	timeoutMs: number;
	pricing: string | false;
	combos: Record<string, string>;
	prices: Record<string, Partial<Price>>;
};

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: (Omit<Price, "tiers"> & { inputTokensAbove: number })[] };
const ZERO: Price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type RouterModel = {
	id: string;
	owned_by?: string;
	context_length?: number;
	max_completion_tokens?: number;
	capabilities?: {
		vision?: boolean;
		reasoning?: boolean;
		thinkingCanDisable?: boolean;
		contextWindow?: number;
		maxOutput?: number;
		tools?: boolean;
	};
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(homedir(), ".pi", "agent", "9router.json");
const CACHE_PATH = join(homedir(), ".pi", "agent", "cache", "9router-models.json");
const PRICE_CACHE_PATH = join(homedir(), ".pi", "agent", "cache", "models-dev-prices.json");
const PRICE_TTL_MS = 24 * 3600 * 1000;
const MODELS_DEV_URL = "https://models.dev/api.json";
// 9router provider aliases -> models.dev provider ids (tried first, then any provider)
const ALIAS_PROVIDERS: Record<string, string[]> = {
	cc: ["anthropic"], claude: ["anthropic"], anthropic: ["anthropic"],
	cx: ["openai"], codex: ["openai"], openai: ["openai"], gh: ["openai", "anthropic", "google"],
	ag: ["google", "anthropic", "openai"], gemini: ["google"], gc: ["google"],
	xai: ["xai"], ds: ["deepseek"], deepseek: ["deepseek"],
};
const PREFERRED = ["anthropic", "openai", "google", "xai", "deepseek", "mistral", "moonshotai", "zai"];

const DEFAULTS: Cfg = {
	provider: "9router",
	baseUrl: "http://127.0.0.1:20128/v1",
	apiKey: "$NINEROUTER_API_KEY",
	include: ["combo"],
	exclude: [],
	timeoutMs: 3000,
	pricing: "models.dev",
	combos: {},
	prices: {},
};

function loadConfig(): Cfg {
	let user: Partial<Cfg> = {};
	for (const p of [CONFIG_PATH, join(AGENT_DIR, "9router.json")]) {
		if (existsSync(p)) {
			try {
				user = JSON.parse(readFileSync(p, "utf8"));
				break;
			} catch (e) {
				console.error(`[9router-models] ignoring invalid ${p}: ${(e as Error).message}`);
			}
		}
	}
	const env: Partial<Cfg> = {};
	if (process.env.NINEROUTER_BASE_URL) env.baseUrl = process.env.NINEROUTER_BASE_URL;
	if (process.env.NINEROUTER_INCLUDE) env.include = process.env.NINEROUTER_INCLUDE.split(",").map((s) => s.trim()).filter(Boolean);
	const merged = { ...DEFAULTS, ...user, ...env };
	return { ...merged, baseUrl: merged.baseUrl.replace(/\/+$/, "") };
}

/** Resolve Pi config-value syntax (!command, $ENV/${ENV}, literal) for our own fetch. */
export function resolveValue(v: string): string {
	if (v.startsWith("!")) return execSync(v.slice(1), { encoding: "utf8", timeout: 5000 }).trim();
	return v.replace(/\$\$|\$!|\$\{(\w+)\}|\$(\w+)/g, (m, a, b) =>
		m === "$$" ? "$" : m === "$!" ? "!" : (process.env[a ?? b] ?? ""),
	);
}

export function glob(pattern: string, s: string): boolean {
	const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
	return re.test(s);
}

export function selected(m: RouterModel, cfg: Cfg): boolean {
	const hit = (p: string) => p === m.owned_by || glob(p, m.id);
	return cfg.include.some(hit) && !cfg.exclude.some(hit);
}

export function toPiModel(m: RouterModel, cost: Price = ZERO) {
	const c = m.capabilities ?? {};
	const reasoning = !!c.reasoning;
	return {
		id: m.id,
		name: m.owned_by === "combo" ? `${m.id} (9router combo)` : m.id,
		reasoning,
		...(reasoning && c.thinkingCanDisable === false ? { thinkingLevelMap: { off: null } } : {}),
		input: c.vision ? ["text", "image"] : ["text"],
		cost,
		contextWindow: c.contextWindow ?? m.context_length ?? 128000,
		maxTokens: c.maxOutput ?? m.max_completion_tokens ?? 16384,
	};
}

// ---------------------------------------------------------------------------
// Pricing (API-equivalent list prices so Pi / Paperclip can show dollars)
// ---------------------------------------------------------------------------

type ModelsDev = Record<string, { models?: Record<string, { cost?: Record<string, any> }> }>;

/** models.dev cost block ($/1M) -> Pi cost (with context tiers). */
export function fromModelsDev(c: Record<string, any> | undefined): Price | undefined {
	if (!c || typeof c.input !== "number" || typeof c.output !== "number") return undefined;
	const base = (x: any) => ({
		input: x.input ?? 0,
		output: x.output ?? 0,
		cacheRead: x.cache_read ?? x.input ?? 0,
		cacheWrite: x.cache_write ?? x.input ?? 0,
	});
	const p: Price = base(c);
	const tiers = (c.tiers ?? [])
		.filter((t: any) => t?.tier?.type === "context" && typeof t.tier.size === "number")
		.map((t: any) => ({ ...base(t), inputTokensAbove: t.tier.size }));
	if (tiers.length) p.tiers = tiers;
	return p;
}

/** Find a price for a 9router model id like "cc/claude-opus-5-5" or "gpt-6-astra". */
export function lookupPrice(id: string, db: ModelsDev): Price | undefined {
	const [alias, ...rest] = id.includes("/") ? id.split("/") : ["", id];
	const name = rest.length ? rest.join("/") : id;
	const variants = [...new Set([name, name.replace(/(\d)-(\d)/g, "$1.$2"), name.replace(/(\d)\.(\d)/g, "$1-$2")])];
	const order = [...(ALIAS_PROVIDERS[alias] ?? []), ...PREFERRED, ...Object.keys(db)];
	for (const prov of [...new Set(order)]) {
		const models = db[prov]?.models;
		if (!models) continue;
		for (const v of variants) {
			const p = fromModelsDev(models[v]?.cost);
			if (p) return p;
		}
	}
	return undefined;
}

async function loadModelsDev(cfg: Cfg): Promise<ModelsDev | undefined> {
	let cached: { fetchedAt: number; data: ModelsDev } | undefined;
	try {
		cached = JSON.parse(readFileSync(PRICE_CACHE_PATH, "utf8"));
	} catch {}
	if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) return cached.data;
	try {
		const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(Math.max(cfg.timeoutMs, 8000)) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const full = (await res.json()) as ModelsDev;
		// keep only cost blocks — the full catalogue is ~5 MB
		const data: ModelsDev = {};
		for (const [prov, v] of Object.entries(full)) {
			const models: Record<string, { cost?: any }> = {};
			for (const [mid, m] of Object.entries(v?.models ?? {})) if (m?.cost) models[mid] = { cost: m.cost };
			if (Object.keys(models).length) data[prov] = { models };
		}
		writeJson(PRICE_CACHE_PATH, { fetchedAt: Date.now(), data });
		return data;
	} catch (e) {
		if (process.env.PI_9ROUTER_DEBUG) console.error(`[9router-models] models.dev unavailable: ${(e as Error).message}`);
		return cached?.data;
	}
}

/**
 * Combo membership. /v1/models does not expose it, so read 9router's
 * dashboard API with the same machine-local CLI token the `9router` CLI uses
 * (~/.9router/machine-id + auth/cli-secret; same user, localhost only).
 * Silently skipped when unavailable; `combos` in config always wins.
 */
async function loadCombos(cfg: Cfg): Promise<Record<string, string[]>> {
	const out: Record<string, string[]> = {};
	try {
		const dir = process.env.NINEROUTER_DATA_DIR || join(homedir(), ".9router");
		const raw = readFileSync(join(dir, "machine-id"), "utf8").trim();
		const secret = readFileSync(join(dir, "auth", "cli-secret"), "utf8").trim();
		const token = createHash("sha256").update(raw + "9r-cli-auth" + secret).digest("hex").slice(0, 16);
		const origin = new URL(cfg.baseUrl).origin;
		const res = await fetch(`${origin}/api/combos`, { headers: { "x-9r-cli-token": token }, signal: AbortSignal.timeout(cfg.timeoutMs) });
		if (res.ok) {
			const body = (await res.json()) as { combos?: { name: string; models: string[] }[] };
			for (const c of body.combos ?? []) if (c?.name && Array.isArray(c.models)) out[c.name] = c.models;
		}
	} catch {}
	for (const [k, v] of Object.entries(cfg.combos)) out[k] = [v];
	return out;
}

/** Follow combo -> first member (combos can nest: ape -> opus -> cc/claude-opus-5-5). */
export function primaryModel(id: string, combos: Record<string, string[]>): string {
	const seen = new Set<string>();
	let cur = id;
	while (combos[cur]?.length && !seen.has(cur)) {
		seen.add(cur);
		cur = combos[cur][0];
	}
	return cur;
}

async function buildPrices(cfg: Cfg, ids: string[]): Promise<Record<string, { price: Price; via: string }>> {
	const out: Record<string, { price: Price; via: string }> = {};
	const needLookup = ids.some((id) => !cfg.prices[id]);
	const db = cfg.pricing && needLookup ? await loadModelsDev(cfg) : undefined;
	const combos = cfg.pricing && needLookup ? await loadCombos(cfg) : {};
	for (const id of ids) {
		if (cfg.prices[id]) {
			out[id] = { price: { ...ZERO, ...cfg.prices[id] } as Price, via: "config" };
			continue;
		}
		if (!db) continue;
		const target = primaryModel(id, combos);
		const p = lookupPrice(target, db);
		if (p) out[id] = { price: p, via: target };
	}
	return out;
}

async function fetchModels(cfg: Cfg): Promise<RouterModel[]> {
	const key = resolveValue(cfg.apiKey);
	const res = await fetch(`${cfg.baseUrl}/models`, {
		headers: key ? { Authorization: `Bearer ${key}` } : {},
		signal: AbortSignal.timeout(cfg.timeoutMs),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.json()) as { data?: RouterModel[] };
	if (!Array.isArray(body.data)) throw new Error("unexpected /models payload");
	return body.data;
}

function readCache(): RouterModel[] | undefined {
	try {
		return JSON.parse(readFileSync(CACHE_PATH, "utf8")).data;
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: unknown) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(value));
		renameSync(tmp, path);
	} catch {
		/* cache is best-effort */
	}
}

function writeCache(data: RouterModel[]) {
	writeJson(CACHE_PATH, { fetchedAt: new Date().toISOString(), data });
}

async function catalogue(cfg: Cfg): Promise<{ models: ReturnType<typeof toPiModel>[]; source: string }> {
	let raw: RouterModel[] | undefined;
	let source = "live";
	try {
		raw = await fetchModels(cfg);
		writeCache(raw);
	} catch (e) {
		raw = readCache();
		source = raw ? `cache (9router unreachable: ${(e as Error).message})` : `none (${(e as Error).message})`;
	}
	const picked = (raw ?? []).filter((m) => m?.id && selected(m, cfg));
	const prices = await buildPrices(cfg, picked.map((m) => m.id));
	const models = picked.map((m) => toPiModel(m, prices[m.id]?.price));
	models.sort((a, b) => a.id.localeCompare(b.id));
	if (process.env.PI_9ROUTER_DEBUG)
		for (const m of models) console.error(`[9router-models]   ${m.id}: $${m.cost.input}/$${m.cost.output} per 1M${prices[m.id] ? ` (via ${prices[m.id].via})` : " (no price)"}`);
	return { models, source };
}

function register(pi: ExtensionAPI, cfg: Cfg, models: ReturnType<typeof toPiModel>[]) {
	pi.registerProvider(cfg.provider, {
		name: "9router",
		baseUrl: cfg.baseUrl,
		apiKey: cfg.apiKey,
		api: "openai-completions",
		models,
	} as any);
}

export default async function (pi: ExtensionAPI) {
	const cfg = loadConfig();
	const { models, source } = await catalogue(cfg);
	if (models.length) register(pi, cfg, models);
	else console.error(`[9router-models] no models registered (source: ${source}); keeping models.json definitions`);
	if (process.env.PI_9ROUTER_DEBUG) console.error(`[9router-models] ${models.length} models from ${source}`);

	pi.registerCommand("9router-sync", {
		description: "Refresh the 9router model catalogue from the running router",
		handler: async (_args, ctx) => {
			const next = loadConfig();
			const r = await catalogue(next);
			if (!r.models.length) {
				ctx.ui.notify(`9router: no models (${r.source})`, "error");
				return;
			}
			register(pi, next, r.models);
			ctx.ui.notify(`9router: ${r.models.length} models from ${r.source}: ${r.models.map((m) => m.id).join(", ")}`, "info");
		},
	});
}
