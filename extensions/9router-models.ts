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
 *     "timeoutMs": 3000
 *   }
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Cfg = {
	provider: string;
	baseUrl: string;
	apiKey: string;
	include: string[];
	exclude: string[];
	timeoutMs: number;
};

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

const DEFAULTS: Cfg = {
	provider: "9router",
	baseUrl: "http://127.0.0.1:20128/v1",
	apiKey: "$NINEROUTER_API_KEY",
	include: ["combo"],
	exclude: [],
	timeoutMs: 3000,
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

export function toPiModel(m: RouterModel) {
	const c = m.capabilities ?? {};
	const reasoning = !!c.reasoning;
	return {
		id: m.id,
		name: m.owned_by === "combo" ? `${m.id} (9router combo)` : m.id,
		reasoning,
		...(reasoning && c.thinkingCanDisable === false ? { thinkingLevelMap: { off: null } } : {}),
		input: c.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: c.contextWindow ?? m.context_length ?? 128000,
		maxTokens: c.maxOutput ?? m.max_completion_tokens ?? 16384,
	};
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

function writeCache(data: RouterModel[]) {
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date().toISOString(), data }));
		renameSync(tmp, CACHE_PATH);
	} catch {
		/* cache is best-effort */
	}
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
	const models = (raw ?? []).filter((m) => m?.id && selected(m, cfg)).map(toPiModel);
	models.sort((a, b) => a.id.localeCompare(b.id));
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
