import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CompactionReason } from "./config.ts";

/** Only allowlisted metadata is accepted; never pass provider payloads. */
export type Diagnostic =
    | { event: "success"; reason: CompactionReason; provider: string; modelId: string;
        thinkingLevel: string; tokensBefore: number; summaryChars: number; outputTokens?: number }
    | { event: "error"; reason: CompactionReason; provider: string; modelId: string; error: string }
    | { event: "auth-failed"; provider: string; modelId: string; error: string }
    | { event: "compact-failed"; reason: CompactionReason; fromExtension: boolean;
        errorMessage?: string; aborted: boolean; willRetry: boolean };

function safeIdentifier(value: string): string {
    return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value) &&
        !value.includes("://") && !value.includes("..") ? value : "[redacted]";
}

/** Discard free-form errors rather than trying to recognize every possible secret. */
export function serializeDiagnostic(entry: Diagnostic): string {
    const timestamp = new Date().toISOString();
    if (entry.event === "compact-failed") return JSON.stringify({
        timestamp, event: entry.event, reason: entry.reason,
        fromExtension: entry.fromExtension,
        errorMessage: entry.errorMessage === undefined ? undefined : "compaction failed",
        aborted: entry.aborted, willRetry: entry.willRetry,
    }) + "\n";
    const target = { provider: safeIdentifier(entry.provider), modelId: safeIdentifier(entry.modelId) };
    if (entry.event === "success") return JSON.stringify({
        timestamp, event: entry.event, reason: entry.reason, ...target,
        thinkingLevel: entry.thinkingLevel, tokensBefore: entry.tokensBefore,
        summaryChars: entry.summaryChars, outputTokens: entry.outputTokens ?? null,
    }) + "\n";
    return JSON.stringify({ timestamp, event: entry.event, ...target,
        ...(entry.event === "error" ? { reason: entry.reason } : {}),
        error: entry.event === "auth-failed" ? "authentication failed" : "compaction failed",
    }) + "\n";
}

/** Injectable filesystem boundary for deterministic queue tests. */
export interface LogIO {
    mkdir(path: string): Promise<unknown>;
    append(path: string, line: string): Promise<unknown>;
}

/** One serialized queue; a failed write permanently disables this writer. */
export function createDiagnosticWriter(io: LogIO = {
    mkdir: (path) => mkdir(path, { recursive: true, mode: 0o700 }),
    append: (path, line) => appendFile(path, line, { encoding: "utf8", mode: 0o600 }),
}) {
    let queue = Promise.resolve();
    let dirReady: string | undefined;
    let disabled = false;
    return (path: string, diagnostic: Diagnostic): void => {
        if (disabled) return;
        queue = queue.then(async () => {
            if (disabled) return;
            const directory = dirname(path);
            if (dirReady !== directory) {
                await io.mkdir(directory);
                dirReady = directory;
            }
            await io.append(path, serializeDiagnostic(diagnostic));
        }).catch(() => { disabled = true; });
    };
}

/** Process-local best-effort writer; compaction must never await its queue. */
export const writeDiagnostic = createDiagnosticWriter();
