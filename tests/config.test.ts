import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { createWarnOnce, resolveConfig, shouldRoute, parseModel, normalizeReasons } from "../src/config.ts";
import { commandPatch, prepareForRouter, routeCompaction, statusText } from "../src/index.ts";
import { createDiagnosticWriter, serializeDiagnostic, type Diagnostic } from "../src/log.ts";

const model = "some-provider/some-model";
const agentDir = "test-agent";
const settings = (value: unknown) => ({ compactionRouter: value });
const config = (global: unknown = {}, project: unknown = {}, override?: string) =>
    resolveConfig(global, project, { PI_COMPACTION_ROUTER: override }, agentDir);
const enabled = config(settings({ enabled: true, model })).config;
const success: Diagnostic = { event: "success", reason: "manual", provider: "some-provider",
    modelId: "some-model", thinkingLevel: "off", tokensBefore: 100, summaryChars: 10 };

function fixture(aborted = false) {
    const controller = new AbortController();
    if (aborted) controller.abort();
    const notices: string[] = [];
    const statuses: (string | undefined)[] = [];
    const event: SessionBeforeCompactEvent = {
        type: "session_before_compact", reason: "manual", willRetry: false,
        signal: controller.signal, branchEntries: [], preparation: {
            firstKeptEntryId: "kept", messagesToSummarize: [], turnPrefixMessages: [],
            isSplitTurn: false, tokensBefore: 100,
            fileOps: { read: new Set(), written: new Set(), edited: new Set() },
            settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 1000 },
        },
    };
    const registry = {
        find: () => ({ provider: "some-provider", id: "some-model" }),
        getApiKeyAndHeaders: async () => ({ ok: false as const, error: "private error" }),
        streamSimple: () => { throw new Error("must not access network"); },
    };
    const ctx = { cwd: ".", model: registry.find(), modelRegistry: registry,
        isProjectTrusted: () => false,
        ui: { notify: (message: string) => notices.push(message),
            setStatus: (_key: string, value: string | undefined) => statuses.push(value) },
    } as unknown as ExtensionContext;
    const load = async () => ({ config: { ...enabled }, warnings: [] });
    return { event, ctx, notices, statuses, load, controller };
}

const compactSuccess: NonNullable<Parameters<typeof routeCompaction>[3]> = async (preparation) => ({
    summary: "summary", tokensBefore: preparation.tokensBefore, firstKeptEntryId: "kept",
});

test("defaults are disabled, thinking off, all reasons, no reserve override", () => {
    assert.deepEqual(config().config, { enabled: false, model: undefined, thinkingLevel: "off",
        reserveTokens: undefined, onlyForActiveModels: [], reasons: ["manual", "threshold", "overflow"],
        debug: false, debugPath: `${agentDir}/logs/compaction-router.log`,
        source: "default", settingsSource: "default" });
});

test("per-field merge inherits omitted global fields and replaces arrays", () => {
    const result = config(settings({ enabled: true, model, debug: true, reasons: ["manual"] }),
        settings({ thinkingLevel: "high", reasons: ["overflow"] })).config;
    assert.equal(result.model, model);
    assert.equal(result.enabled, true);
    assert.equal(result.debug, true);
    assert.equal(result.thinkingLevel, "high");
    assert.deepEqual(result.reasons, ["overflow"]);
    assert.equal(result.source, "project");
});

test("applies env override after settings", () => {
    for (const malformed of [null, [], "bad", { debug: "bad" }]) {
        const result = config(settings(malformed), {}, "some-provider/env-model");
        assert.equal(result.config.enabled, true);
        assert.equal(result.config.model, "some-provider/env-model");
        assert.equal(result.config.source, "env");
        assert.equal(result.config.settingsSource, "default");
        assert.equal(result.warnings.length, 1);
    }
    assert.equal(config(settings({ enabled: true, model }), {}, "off").config.enabled, false);
    const result = config(settings({ enabled: true, model }), settings({ debug: true }), "off");
    assert.equal(result.config.settingsSource, "project");
    for (const invalid of ["", " ", "bad", "provider/", "/model"]) {
        assert.equal(config(settings({ enabled: true, model }), {}, invalid).config.model, model);
    }
});

test("enabled without model is inactive, retains other fields, and warns once", () => {
    const result = config(settings({ enabled: true, debug: true }));
    assert.equal(result.config.enabled, false);
    assert.equal(result.config.debug, true);
    assert.equal(result.warnings.length, 1);
    const warn = createWarnOnce();
    const notices: string[] = [];
    for (let i = 0; i < 3; i++) warn("config", (msg) => notices.push(msg), result.warnings[0]);
    assert.equal(notices.length, 1);
});

test("validators reject malformed layers rather than silently widening filters", () => {
    const bad = [{ enabled: "true" }, { debug: 1 }, { thinkingLevel: "invalid" },
        { reserveTokens: 1.5 }, { reserveTokens: Infinity }, { reasons: ["unknown"] },
        { onlyForActiveModels: ["invalid"] }, { debugPath: "" }, { debugPath: "x\u0000y" }];
    for (const invalid of bad) {
        const result = config(settings({ enabled: true, model, ...invalid }));
        assert.equal(result.config.enabled, false);
        assert.equal(result.config.source, "default");
        assert.equal(result.warnings.length, 1);
    }
    for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
        assert.equal(config(settings({ thinkingLevel })).config.thinkingLevel, thinkingLevel);
    }
    assert.equal(config(settings({ unknown: true })).warnings.length, 0);
});

test("clamps integers and deduplicates normalized lists preserving order", () => {
    for (const [input, expected] of [[1, 1024], [-3, 1024], [4096, 4096], [2e6, 1e6]]) {
        assert.equal(config(settings({ reserveTokens: input })).config.reserveTokens, expected);
    }
    const result = config(settings({ reasons: ["manual", "manual", "overflow"],
        onlyForActiveModels: [model, ` ${model} `] })).config;
    assert.deepEqual(result.reasons, ["manual", "overflow"]);
    assert.deepEqual(result.onlyForActiveModels, [model]);
    assert.equal(parseModel(" some-provider/group/model "), "some-provider/group/model");
    assert.equal(parseModel("some provider/model"), undefined);
    assert.equal(normalizeReasons(["invalid"]), undefined);
});

test("routes only when enabled, allowed, and reason-matching", () => {
    const filtered = { ...enabled, reasons: ["threshold" as const], onlyForActiveModels: [model] };
    assert.equal(shouldRoute(filtered, model, "threshold", false), true);
    assert.equal(shouldRoute(filtered, model, "manual", false), false);
    assert.equal(shouldRoute(filtered, "another/model", "threshold", false), false);
    assert.equal(shouldRoute(filtered, undefined, "threshold", false), false);
    assert.equal(shouldRoute({ ...filtered, enabled: false }, model, "threshold", false), false);
    assert.equal(shouldRoute(enabled, undefined, "manual", false), true);
    assert.equal(shouldRoute({ ...enabled, reasons: [] }, model, "manual", false), false);
});

test("aborted compaction returns silently", async () => {
    const f = fixture(true);
    const load = async () => { throw new Error("must not load when already aborted"); };
    assert.equal(await routeCompaction(f.event, f.ctx, load, compactSuccess), undefined);
    assert.deepEqual(f.notices, []);
    const active = fixture();
    await routeCompaction(active.event, active.ctx, active.load, async () => {
        throw new DOMException("cancelled", "AbortError");
    });
    assert.equal(active.notices.some((message) => message.includes("falling back")), false);
});

test("auth failure warns once and falls back", async () => {
    const f = fixture();
    const calls: unknown[][] = [];
    const run: typeof compactSuccess = async (...args) => {
        calls.push(args);
        return compactSuccess(...args);
    };
    await routeCompaction(f.event, f.ctx, f.load, run);
    await routeCompaction(f.event, f.ctx, f.load, run);
    assert.ok(f.notices.filter((message) => message.includes("authentication")).length <= 1);
    assert.equal(calls.length, 2);
    for (const args of calls) {
        assert.equal(args[2], undefined);
        assert.equal(args[3], undefined);
        assert.equal(args[6], undefined);
        assert.equal(args[8], undefined);
        assert.equal(typeof args[7], "function");
    }
    assert.notEqual(calls[0][11], calls[1][11]);
});

test("compact error returns undefined", async () => {
    const f = fixture();
    const result = await routeCompaction(f.event, f.ctx, f.load, async () => {
        throw new Error("private provider payload");
    });
    assert.equal(result, undefined);
    assert.ok(f.notices.some((message) => message.includes("falling back")));
    assert.equal(f.notices.some((message) => message.includes("private provider")), false);
});

test("does not mutate preparation", () => {
    const { event } = fixture();
    Object.freeze(event.preparation.settings);
    Object.freeze(event.preparation);
    const result = prepareForRouter(event.preparation, 8192);
    assert.notEqual(result, event.preparation);
    assert.equal(result.settings.reserveTokens, 8192);
    assert.equal(event.preparation.settings.reserveTokens, 4096);
    assert.equal(result.messagesToSummarize, event.preparation.messagesToSummarize);
    assert.equal(result.settings.keepRecentTokens, 1000);
});

test("pairs session_compact_failed diagnostics", () => {
    const record = JSON.parse(serializeDiagnostic({ event: "compact-failed", reason: "overflow",
        fromExtension: true, aborted: true, willRetry: true, errorMessage: "secret /private/path" }));
    assert.equal(record.event, "compact-failed");
    assert.equal(record.reason, "overflow");
    assert.equal(record.aborted, true);
    assert.equal(record.willRetry, true);
    assert.equal(record.fromExtension, true);
    assert.equal(record.errorMessage, "compaction failed");
    assert.equal(typeof record.timestamp, "string");
});

test("clears status on every exit", async () => {
    for (const mode of ["success", "disabled", "abort", "failure", "lookup"]) {
        const f = fixture(mode === "abort");
        if (mode === "lookup") f.ctx.modelRegistry.find = () => undefined;
        const load = async () => ({ config: { ...enabled, enabled: mode !== "disabled" }, warnings: [] });
        await routeCompaction(f.event, f.ctx, load, mode === "failure" ? async () => {
            throw new Error("failed");
        } : compactSuccess);
        assert.equal(f.statuses.at(-1), undefined);
    }
});

test("debug logging never blocks compaction", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const lines: string[] = [];
    const writer = createDiagnosticWriter({ mkdir: () => pending,
        append: async (_path, line) => { lines.push(line); } });
    assert.equal(writer("logs/test.log", success), undefined);
    writer("logs/test.log", { ...success, summaryChars: 20 });
    await setImmediate();
    assert.equal(lines.length, 0);
    release();
    await setImmediate();
    assert.deepEqual(lines.map((line) => JSON.parse(line).summaryChars), [10, 20]);
    let attempts = 0;
    const broken = createDiagnosticWriter({ mkdir: async () => { attempts++; throw Error("disk"); },
        append: async () => assert.fail("must not append after mkdir failure") });
    broken("logs/test.log", success);
    broken("logs/test.log", success);
    await setImmediate();
    broken("logs/test.log", success);
    await setImmediate();
    assert.equal(attempts, 1);
});

test("command patches and status preserve environment provenance", () => {
    assert.deepEqual(commandPatch("reasons manual,threshold manual"),
        { reasons: ["manual", "threshold"] });
    assert.deepEqual(commandPatch("off"), { enabled: false });
    assert.deepEqual(commandPatch(model), { enabled: true, model });
    assert.equal(commandPatch("reasons invalid"), undefined);
    const result = config(settings({ debug: true }), {}, model);
    const text = statusText(result.config);
    assert.ok(text.includes("source=env (settings: global)"));
    assert.ok(text.includes(`debugPath=${agentDir}/logs/compaction-router.log`));
});
