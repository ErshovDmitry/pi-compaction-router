import type {
    ExtensionAPI, ExtensionContext, ExtensionCommandContext,
    SessionBeforeCompactEvent, SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
    createWarnOnce, isRecord, loadEffectiveConfig, normalizeReasons, parseModel, shouldRoute,
    type EffectiveConfig, type RouterSettings,
} from "./config.ts";
import { writeDiagnostic, type Diagnostic } from "./log.ts";

type Compact = typeof import("@earendil-works/pi-coding-agent").compact;

const STATUS_KEY = "compaction-router";
const warnOnce = createWarnOnce();
type NoticeType = "info" | "warning" | "error";
const safeNotify = (ctx: { ui: { notify: (message: string, type?: NoticeType) => void } },
    message: string, type?: "info" | "warning" | "error"): void => {
    try {
        ctx.ui.notify(message, type);
    } catch {
        // UI failures must not affect compaction.
    }
};
const safeSetStatus = (ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } },
    value: string | undefined): void => {
    try {
        ctx.ui.setStatus(STATUS_KEY, value);
    } catch {
        // UI failures must not affect compaction.
    }
};
let diagnosticWriter: (path: string, entry: Diagnostic) => void = writeDiagnostic;

/** Replace diagnostic I/O for tests; omit the writer to restore the process-local default. */
export function setDiagnosticWriterForTests(
    writer: typeof diagnosticWriter = writeDiagnostic,
): void {
    diagnosticWriter = writer;
}

const log = (config: EffectiveConfig, entry: Diagnostic): void => {
    if (config.debug) diagnosticWriter(config.debugPath, entry);
};

/** Redact sensitive error details before showing them in the UI. */
export function sanitizeErrorText(error: unknown): string {
    try {
        const detail = isRecord(error) ? error.message : undefined;
        const message = typeof detail === "string" ? detail : String(error);
        let safe = message.replace(/\s+/g, " ").trim();
        safe = safe.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/g,
            "$1[redacted]@");
        safe = safe.replace(/(sk|gho|ghp|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g,
            "[redacted]");
        safe = safe.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
        safe = safe.replace(/\b(key|token|secret|password|api[-_]?key)\b\s*[:=]\s*\S+/gi,
            "$1=[redacted]");
        safe = safe.replace(/(?:AKIA|ASIA)[0-9A-Z]{16}/g, "[redacted]");
        safe = safe.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
        return safe.length > 300 ? `${safe.slice(0, 300)}…` : safe;
    } catch {
        return "error";
    }
}

/** Render all effective fields, including the settings source hidden by an env override. */
export function statusText(config: EffectiveConfig): string {
    const source = config.source === "env"
        ? `env (settings: ${config.settingsSource})` : config.source;
    return `enabled=${config.enabled}, model=${config.model ?? "none"}, ` +
        `thinkingLevel=${config.thinkingLevel}, ` +
        `reserveTokens=${config.reserveTokens ?? "pi default"}, ` +
        `onlyForActiveModels=${config.onlyForActiveModels.join(",") || "all"}, ` +
        `reasons=${config.reasons.join(",") || "none"}, debug=${config.debug}, ` +
        `debugPath=${config.debugPath}, source=${source}`;
}

/** Parse only supported mutations; undefined means invalid command syntax. */
export function commandPatch(args: string): RouterSettings | undefined {
    const value = args.trim();
    if (value === "off") return { enabled: false };
    if (/^reasons\s/.test(value)) {
        const reasons = normalizeReasons(value.slice(7).trim().split(/[\s,]+/));
        return reasons ? { reasons } : undefined;
    }
    const model = parseModel(value);
    return model ? { enabled: true, model } : undefined;
}

async function readTarget(path: string): Promise<Record<string, unknown>> {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return {};
        throw new Error("Cannot read settings; file unchanged");
    }
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || (parsed.compactionRouter !== undefined &&
        !isRecord(parsed.compactionRouter))) throw new Error("Malformed settings; file unchanged");
    return parsed;
}

/** Preserve unrelated keys and replace only the selected settings file atomically. */
export async function persistSettings(path: string, patch: RouterSettings): Promise<void> {
    const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
    await withFileMutationQueue(path, async () => {
        const settings = await readTarget(path);
        const current = isRecord(settings.compactionRouter) ? settings.compactionRouter : {};
        const next = { ...settings, compactionRouter: { ...current, ...patch } };
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const tempPath = `${path}.${randomUUID()}.tmp`;
        let created = false;
        try {
            await writeFile(tempPath, `${JSON.stringify(next, null, 4)}\n`, {
                encoding: "utf8", flag: "wx", mode: 0o600,
            });
            created = true;
            await rename(tempPath, path);
        } finally {
            if (created) await unlink(tempPath).catch(() => { /* Renamed or already removed. */ });
        }
    });
}

async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const notify = (message: string, type?: "info" | "warning" | "error") =>
        safeNotify(ctx, message, type);
    try {
        if (!args.trim() || args.trim() === "status") {
            const { config } = await loadEffectiveConfig(
                ctx.cwd, notify, process.env, ctx.isProjectTrusted(),
            );
            notify(`compaction-router: ${statusText(config)}`, "info");
            return;
        }
        const patch = commandPatch(args);
        if (!patch) {
            notify("usage: /compact-router [status | off | provider/model | reasons list]",
                "error");
            return;
        }
        const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
        const trusted = ctx.isProjectTrusted();
        const path = trusted ? join(ctx.cwd, ".pi", "settings.json")
            : join(getAgentDir(), "settings.json");
        await persistSettings(path, patch);
        const { config } = await loadEffectiveConfig(ctx.cwd, notify, process.env, trusted);
        const suffix = config.source === "env"
            ? "; PI_COMPACTION_ROUTER still overrides settings" : "";
        notify(`compaction-router: saved ${path}${trusted ? "" : " (untrusted project: global)"}` +
            suffix, "info");
    } catch {
        notify("compaction-router: could not save/read settings; check JSON and permissions",
            "error");
    }
}

/** Copy only the overridden preparation/settings layers, preserving all other fields. */
export function prepareForRouter(
    preparation: SessionBeforeCompactEvent["preparation"], reserveTokens: number | undefined,
): SessionBeforeCompactEvent["preparation"] {
    if (reserveTokens === undefined) return preparation;
    return { ...preparation, settings: { ...preparation.settings, reserveTokens } };
}

async function runCompact(
    event: SessionBeforeCompactEvent, ctx: ExtensionContext, config: EffectiveConfig,
    model: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>,
    compactFn: Compact,
) {
    const notify = (message: string, type?: "info" | "warning" | "error") =>
        safeNotify(ctx, message, type);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (event.signal.aborted) return undefined;
    if (!auth.ok) {
        warnOnce("auth", notify, "authentication resolution failed; retrying through pi's stream");
        log(config, { event: "auth-failed", provider: model.provider, modelId: model.id,
            error: "authentication failed" });
    }
    const headers = auth.ok && auth.headers ? Object.fromEntries(
        Object.entries(auth.headers).filter(
            (entry): entry is [string, string] => entry[1] !== null),
    ) : undefined;
    const streamFn = ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry) as
        Parameters<Compact>[7];
    safeSetStatus(ctx, `summarizing via ${config.model}…`);
    const result = await compactFn(
        prepareForRouter(event.preparation, config.reserveTokens), model,
        auth.ok ? auth.apiKey : undefined, headers, event.customInstructions, event.signal,
        config.thinkingLevel === "off" ? undefined : config.thinkingLevel,
        streamFn, auth.ok ? auth.env : undefined, undefined, undefined, randomUUID(),
    );
    if (event.signal.aborted) return undefined;
    log(config, { event: "success", reason: event.reason,
        provider: model.provider, modelId: model.id,
        thinkingLevel: config.thinkingLevel, tokensBefore: result.tokensBefore,
        summaryChars: result.summary.length, outputTokens: result.usage?.output });
    const usage = result.usage?.output;
    notify(`compaction-router: ${config.model} — ${result.tokensBefore} tokens → ` +
        `${result.summary.length} chars${usage === undefined ? "" : `, ${usage} output tokens`}`,
        "info");
    return { compaction: result };
}

/** Injectable pi boundary for offline runtime-behavior tests. */
export async function routeCompaction(
    event: SessionBeforeCompactEvent, ctx: ExtensionContext,
    load = loadEffectiveConfig, compactFn?: Compact,
): Promise<SessionBeforeCompactResult | undefined> {
    let config: EffectiveConfig | undefined;
    try {
        if (event.signal.aborted) return undefined;
        config = (await load(ctx.cwd, (message, type) => safeNotify(ctx, message, type),
            process.env, ctx.isProjectTrusted())).config;
        const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        if (!event.signal.aborted && config.enabled && config.reasons.includes(event.reason) &&
            config.onlyForActiveModels.length > 0 && active !== undefined &&
            !config.onlyForActiveModels.includes(active)) {
            log(config, { event: "skipped", reason: event.reason, provider: ctx.model!.provider,
                modelId: ctx.model!.id });
        }
        if (!shouldRoute(config, active, event.reason, event.signal.aborted)) return undefined;
        const slash = config.model!.indexOf("/");
        const model = ctx.modelRegistry.find(config.model!.slice(0, slash),
            config.model!.slice(slash + 1));
        if (!model) {
            safeNotify(ctx, `compaction-router: model ${config.model} not found`, "warning");
            return undefined;
        }
        if (!compactFn) {
            const { compact } = await import("@earendil-works/pi-coding-agent");
            compactFn = compact;
        }
        return await runCompact(event, ctx, config, model, compactFn);
    } catch (error) {
        if (event.signal.aborted ||
            (isRecord(error) && error.name === "AbortError")) return undefined;
        if (config) {
            const slash = config.model?.indexOf("/") ?? -1;
            log(config, { event: "error", reason: event.reason,
                provider: config.model?.slice(0, slash) ?? "unknown",
                modelId: config.model?.slice(slash + 1) ?? "unknown", error: "compaction failed" });
        }
        safeNotify(ctx, `compaction-router: failed (${sanitizeErrorText(error)}); ` +
            "falling back to default compaction", "error");
        return undefined;
    } finally {
        safeSetStatus(ctx, undefined);
    }
}

/** Register native compaction routing, failure diagnostics, and the settings command. */
export default function register(pi: ExtensionAPI): void {
    pi.on("session_before_compact", (event, ctx) => routeCompaction(event, ctx));
    pi.on("session_compact_failed", async (event, ctx) => {
        try {
            const { config } = await loadEffectiveConfig(ctx.cwd,
                (message, type) => safeNotify(ctx, message, type), process.env,
                ctx.isProjectTrusted());
            log(config, { event: "compact-failed", reason: event.reason,
                fromExtension: event.fromExtension, errorMessage: event.errorMessage,
                aborted: event.aborted, willRetry: event.willRetry });
        } catch {
            // Failure diagnostics must never disrupt pi's compaction lifecycle.
        }
    });
    pi.registerCommand("compact-router", {
        description: "Inspect or configure compaction model routing",
        handler: handleCommand,
    });
}
