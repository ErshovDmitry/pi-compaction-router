import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { resolveConfig, type EffectiveConfig } from "../src/config.ts";
import {
    routeCompaction, sanitizeErrorText, setDiagnosticWriterForTests,
} from "../src/index.ts";
import { serializeDiagnostic } from "../src/log.ts";

const model = { provider: "provider", id: "model" };
const compactResult = { summary: "summary", tokensBefore: 10, firstKeptEntryId: "kept" };

function event(): SessionBeforeCompactEvent {
    return {
        type: "session_before_compact", reason: "manual", willRetry: false,
        signal: new AbortController().signal, branchEntries: [], customInstructions: undefined,
        preparation: {
            firstKeptEntryId: "kept", messagesToSummarize: [], turnPrefixMessages: [],
            isSplitTurn: false, tokensBefore: 10,
            fileOps: { read: new Set(), written: new Set(), edited: new Set() },
            settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 1000 },
        },
    };
}

function context(notices: string[]): ExtensionContext {
    const registry = {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
        streamSimple: () => { throw new Error("network access is not expected"); },
    };
    return {
        cwd: ".", model, modelRegistry: registry,
        isProjectTrusted: () => false,
        ui: { notify: (message: string) => notices.push(message), setStatus: () => undefined },
    } as unknown as ExtensionContext;
}

function loadConfig(config: EffectiveConfig) {
    return async () => ({ config, warnings: [] });
}

function routedConfig(): EffectiveConfig {
    return { ...resolveConfig({}, {}, {}).config, enabled: true,
        model: "provider/model", debug: true, debugPath: "memory/router.log" };
}

function captureDiagnostics(t: { after: (fn: () => void) => void }): string[] {
    const lines: string[] = [];
    setDiagnosticWriterForTests((path, entry) => {
        assert.equal(path, "memory/router.log");
        lines.push(serializeDiagnostic(entry));
    });
    t.after(() => setDiagnosticWriterForTests());
    return lines;
}

function assertRecord(line: string, expected: Record<string, unknown>): void {
    const record = JSON.parse(line);
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(record, { timestamp: record.timestamp, ...expected });
}

const sanitizerCases = [
    ["https://user:pass@example.com", "https://[redacted]@example.com"],
    ["sk-proj-123456789", "[redacted]"],
    ["gho_123456789", "[redacted]"],
    ["ghp_123456789", "[redacted]"],
    ["ghs-123456789", "[redacted]"],
    ["github_pat_123456789", "[redacted]"],
    ["github_pat-123456789", "[redacted]"],
    ["xoxb-123456789", "[redacted]"],
    ["Bearer secret-token", "Bearer [redacted]"],
    ["bearer secret-token", "Bearer [redacted]"],
    ["Bearer  tok en", "Bearer [redacted] en"],
    ["Bearer\n\tsecret-token", "Bearer [redacted]"],
    ["line one\nsecret: multiline-value", "line one secret=[redacted]"],
    ["KEY = value", "KEY=[redacted]"],
    ["key=value token: value api-key=other", "key=[redacted] token=[redacted] api-key=[redacted]"],
    ["AKIA0123456789ABCDEF", "[redacted]"],
    ["ASIA0123456789ABCDEF", "[redacted]"],
    ["Ab9_-".repeat(7), "[redacted]"],
    ["x".repeat(500), "[redacted]"],
    ["plain message", "plain message"],
] as const;

for (const [input, expected] of sanitizerCases) {
    test(`sanitizeErrorText: ${JSON.stringify(input.slice(0, 60))}`, () => {
        assert.equal(sanitizeErrorText(input), expected);
        assert.equal(sanitizeErrorText(new Error(input)), expected);
    });
}

test("sanitizer redacts a token crossing the truncation boundary before truncating", () => {
    const prefix = "word ".repeat(58);
    for (const secret of ["ghp_12345678901234567890", "Ab9_-".repeat(7)]) {
        assert.equal(sanitizeErrorText(`${prefix}${secret} trailing detail`),
            `${prefix}[redacted]…`);
    }
    const long = "word ".repeat(100);
    assert.equal(sanitizeErrorText(long), `${long.slice(0, 300)}…`);
});

const hostileErrors: unknown[] = [
    { get message(): string { throw new Error("getter secret"); } },
    { toString(): string { throw new Error("coercion secret"); } },
    { message: Symbol("message"), toString(): string { throw new Error("secret"); } },
];

test("sanitizer cannot throw on getters, coercion, or symbols", () => {
    for (const error of hostileErrors) assert.equal(sanitizeErrorText(error), "error");
    assert.equal(sanitizeErrorText(Symbol("plain")), "Symbol(plain)");
    let reads = 0;
    assert.equal(sanitizeErrorText({ get message() {
        if (reads++) throw new Error("second access");
        return "plain message";
    } }), "plain message");
    assert.equal(reads, 1);
});

test("failure UI is sanitized and entire error/auth diagnostic payloads are fixed", async (t) => {
    const lines = captureDiagnostics(t);
    const notices: string[] = [];
    const ctx = context(notices);
    ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false,
        error: "private authentication payload sk-proj-123456789" });
    const result = await routeCompaction(event(), ctx, loadConfig(routedConfig()), async () => {
        throw new Error("provider failed sk-proj-123456789");
    });
    assert.equal(result, undefined);
    assert.equal(notices.at(-1), "compaction-router: failed (provider failed [redacted]); " +
        "falling back to default compaction");
    assert.equal(lines.length, 2);
    assertRecord(lines[0], { event: "auth-failed", provider: "provider", modelId: "model",
        error: "authentication failed" });
    assertRecord(lines[1], { event: "error", reason: "manual", provider: "provider",
        modelId: "model", error: "compaction failed" });
});

test("hostile errors still return fallback and a fixed notification", async (t) => {
    const lines = captureDiagnostics(t);
    for (const error of hostileErrors) {
        const notices: string[] = [];
        const result = await routeCompaction(event(), context(notices),
            loadConfig(routedConfig()), async () => { throw error; });
        assert.equal(result, undefined);
        assert.deepEqual(notices, ["compaction-router: failed (error); " +
            "falling back to default compaction"]);
    }
    assert.equal(lines.length, hostileErrors.length);
    for (const line of lines) assertRecord(line, { event: "error", reason: "manual",
        provider: "provider", modelId: "model", error: "compaction failed" });
});

for (const active of [model, { provider: "../evil", id: "x".repeat(300) }]) {
    test(`allowlist miss: ${active.provider} logs only sanitized metadata`, async (t) => {
        const lines = captureDiagnostics(t);
        const notices: string[] = [];
        const ctx = context(notices);
        ctx.model = { ...ctx.model!, ...active };
        const config = { ...routedConfig(), onlyForActiveModels: ["other/active"] };
        const result = await routeCompaction(event(), ctx, loadConfig(config), async () => {
            assert.fail("allowlist miss must not compact");
        });
        assert.equal(result, undefined);
        assert.deepEqual(notices, []);
        assert.equal(lines.length, 1);
        const unsafe = active !== model;
        assertRecord(lines[0], { event: "skipped", reason: "manual",
            provider: unsafe ? "[redacted]" : active.provider,
            modelId: unsafe ? "[redacted]" : active.id });
        if (unsafe) {
            assert.equal(lines[0].includes(active.provider), false);
            assert.equal(lines[0].includes(active.id), false);
        }
    });
}

const negativeCases: {
    name: string; patch?: Partial<EffectiveConfig>; aborted?: boolean;
    noModel?: boolean; routes?: boolean;
}[] = [
    { name: "disabled", patch: { enabled: false } },
    { name: "disallowed reason", patch: { reasons: ["threshold"] } },
    { name: "aborted", aborted: true },
    { name: "missing active model", noModel: true },
    { name: "empty allowlist", patch: { onlyForActiveModels: [] }, routes: true },
    { name: "allowlisted model", patch: { onlyForActiveModels: ["provider/model"] }, routes: true },
    { name: "debug disabled", patch: { debug: false } },
];

for (const scenario of negativeCases) {
    test(`no skipped diagnostic: ${scenario.name}`, async (t) => {
        const lines = captureDiagnostics(t);
        const notices: string[] = [];
        const ctx = context(notices);
        if (scenario.noModel) ctx.model = undefined;
        const input = event();
        if (scenario.aborted) input.signal = AbortSignal.abort();
        const config = { ...routedConfig(), onlyForActiveModels: ["other/active"],
            ...scenario.patch };
        let calls = 0;
        const result = await routeCompaction(input, ctx, loadConfig(config), async () => {
            calls++;
            return compactResult;
        });
        assert.equal(calls, scenario.routes ? 1 : 0);
        assert.deepEqual(result, scenario.routes ? { compaction: compactResult } : undefined);
        assert.deepEqual(notices, scenario.routes
            ? ["compaction-router: provider/model — 10 tokens → 7 chars"] : []);
        assert.equal(lines.some((line) => JSON.parse(line).event === "skipped"), false);
        if (!scenario.routes) {
            assert.deepEqual(lines, []);
            return;
        }
        assert.equal(lines.length, 1);
        assertRecord(lines[0], { event: "success", reason: "manual", provider: "provider",
            modelId: "model", thinkingLevel: "off", tokensBefore: 10, summaryChars: 7 });
    });
}
