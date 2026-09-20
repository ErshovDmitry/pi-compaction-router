import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { join } from "node:path";

/** Supported compaction triggers. */
export const REASONS = ["manual", "threshold", "overflow"] as const;
/** A pi compaction trigger. */
export type CompactionReason = (typeof REASONS)[number];
/** Recognized settings fields; untrusted values must pass runtime validation. */
export interface RouterSettings {
    enabled?: boolean;
    model?: string;
    thinkingLevel?: ModelThinkingLevel;
    reserveTokens?: number;
    onlyForActiveModels?: string[];
    reasons?: CompactionReason[];
    debug?: boolean;
    debugPath?: string;
}
/** Origin of the normalized settings layer. */
export type SettingsSource = "global" | "project" | "default";
/** Validated configuration and its provenance. */
export interface EffectiveConfig {
    enabled: boolean;
    model?: string;
    thinkingLevel: ModelThinkingLevel;
    reserveTokens?: number;
    onlyForActiveModels: string[];
    reasons: CompactionReason[];
    debug: boolean;
    debugPath: string;
    source: SettingsSource | "env";
    settingsSource: SettingsSource;
}
/** Resolution is pure; the caller decides whether to surface warnings. */
export interface ConfigResolution { config: EffectiveConfig; warnings: string[] }
/** Notification callback supported by pi. */
export type Notify = (message: string, type?: "info" | "warning" | "error") => void;
type Environment = Record<string, string | undefined>;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const KEYS = ["enabled", "model", "thinkingLevel", "reserveTokens", "onlyForActiveModels",
    "reasons", "debug", "debugPath"];

/** Reject null, arrays, and primitive settings containers. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Split on the first slash; model IDs may themselves contain slashes. */
export function parseModel(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const model = value.trim();
    return /^[^/\s\x00-\x1f\x7f]+\/[^\s\x00-\x1f\x7f]+$/.test(model) ? model : undefined;
}

/** Validate a reason list and deduplicate it without changing order. */
export function normalizeReasons(value: unknown): CompactionReason[] | undefined {
    if (!Array.isArray(value) || !value.every((item) => REASONS.includes(item))) return undefined;
    return [...new Set(value)] as CompactionReason[];
}

function validFields(value: Record<string, unknown>): boolean {
    if (["enabled", "debug"].some((key) => key in value && typeof value[key] !== "boolean")) {
        return false;
    }
    if ("thinkingLevel" in value && !THINKING_LEVELS.includes(String(value.thinkingLevel))) {
        return false;
    }
    if ("reserveTokens" in value && !Number.isInteger(value.reserveTokens)) return false;
    if ("reasons" in value && normalizeReasons(value.reasons) === undefined) return false;
    if ("onlyForActiveModels" in value && (!Array.isArray(value.onlyForActiveModels) ||
        !value.onlyForActiveModels.every((item) => parseModel(item) !== undefined))) return false;
    if ("debugPath" in value && (typeof value.debugPath !== "string" ||
        !value.debugPath.trim() || /[\x00-\x1f\x7f]/.test(value.debugPath))) return false;
    // A missing/invalid target makes an enabled router inactive, not a malformed layer.
    return true;
}

function settingsLayer(globalSettings: unknown, projectSettings: unknown) {
    const global = isRecord(globalSettings) ? globalSettings.compactionRouter : undefined;
    const project = isRecord(projectSettings) ? projectSettings.compactionRouter : undefined;
    const malformed = [global, project].some((value) => value !== undefined && !isRecord(value));
    const merged = { ...(isRecord(global) ? global : {}), ...(isRecord(project) ? project : {}) };
    const hasFields = (value: unknown) => isRecord(value) && KEYS.some((key) => key in value);
    const source: SettingsSource = hasFields(project) ? "project" : hasFields(global)
        ? "global" : "default";
    if (malformed || !validFields(merged)) {
        return { values: {} as RouterSettings, source: "default" as const,
            warnings: ["malformed compactionRouter settings; using defaults"] };
    }
    return { values: merged as RouterSettings, source, warnings: [] as string[] };
}

/** Resolve explicit settings and environment without pi, filesystem, or notification calls. */
export function resolveConfig(
    globalSettings: unknown,
    projectSettings: unknown,
    env: Environment,
    agentDir = ".",
): ConfigResolution {
    const { values, source: settingsSource, warnings } = settingsLayer(globalSettings, projectSettings);
    const model = parseModel(values.model);
    if (values.enabled && !model) warnings.push("enabled router has no valid model; inactive");
    const config: EffectiveConfig = {
        enabled: values.enabled === true && model !== undefined, model,
        thinkingLevel: values.thinkingLevel ?? "off",
        reserveTokens: values.reserveTokens === undefined ? undefined
            : Math.min(1_000_000, Math.max(1024, values.reserveTokens)),
        onlyForActiveModels: [...new Set(values.onlyForActiveModels?.map((item) => item.trim()))],
        reasons: normalizeReasons(values.reasons) ?? [...REASONS],
        debug: values.debug ?? false,
        debugPath: values.debugPath?.trim() ?? join(agentDir, "logs", "compaction-router.log"),
        source: settingsSource, settingsSource,
    };
    const override = env.PI_COMPACTION_ROUTER?.trim();
    if (override === "off") return { config: { ...config, enabled: false, source: "env" }, warnings };
    const envModel = parseModel(override);
    if (envModel) return {
        config: { ...config, enabled: true, model: envModel, source: "env" }, warnings,
    };
    return { config, warnings };
}

/** Deduplicate warnings by category within one extension instance. */
export function createWarnOnce() {
    const warned = new Set<string>();
    return (key: string, notify: Notify, message: string): void => {
        if (warned.has(key)) return;
        warned.add(key);
        notify(`compaction-router: ${message}`, "warning");
    };
}
const warnOnce = createWarnOnce();

/** Reload settings for every invocation; never enable untrusted project settings. */
export async function loadEffectiveConfig(
    cwd: string, notify: Notify, env: Environment = process.env, projectTrusted = false,
): Promise<ConfigResolution> {
    const { getAgentDir, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const agentDir = getAgentDir();
    try {
        const manager = SettingsManager.create(cwd, agentDir, { projectTrusted });
        const result = resolveConfig(
            manager.getGlobalSettings(), manager.getProjectSettings(), env, agentDir,
        );
        if (manager.drainErrors().length) {
            result.warnings.push("could not read settings; unavailable settings ignored");
        }
        for (const warning of result.warnings) warnOnce("config", notify, warning);
        return result;
    } catch {
        warnOnce("config", notify, "could not load settings; using defaults");
        return resolveConfig({}, {}, env, agentDir);
    }
}

/** Decide whether to route without mutating inputs or emitting notifications. */
export function shouldRoute(
    config: EffectiveConfig, activeModel: string | undefined,
    reason: CompactionReason, aborted: boolean,
): boolean {
    if (aborted || !config.enabled || !config.model || !config.reasons.includes(reason)) return false;
    return config.onlyForActiveModels.length === 0 ||
        (activeModel !== undefined && config.onlyForActiveModels.includes(activeModel));
}
