import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { C64AnalysisState, C6510Decoder, createViceMonitorServer, MonitorClient } from "../src/index.js";
import * as liveCapture from "../src/analysis-engine/c64-live-capture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.restoreAllMocks();
});

async function setup() {
    const monitor = new MonitorClient();
    const execute = vi.spyOn(monitor, "execute");
    const server = createViceMonitorServer(monitor);
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => {
        await client.close();
        await server.close();
    });
    return { client, execute };
}

function text(result: unknown): string {
    if (
        typeof result !== "object" ||
        result === null ||
        !("content" in result) ||
        !Array.isArray(result.content) ||
        typeof result.content[0]?.text !== "string"
    ) {
        throw new Error("Expected text result.");
    }
    return result.content[0].text;
}

async function files() {
    const directory = await mkdtemp(join(tmpdir(), "cbm-query-"));
    cleanup.push(() => rm(directory, { recursive: true }));
    const prg = join(directory, "test.prg");
    const saved = join(directory, "state.json");
    const bytes = Uint8Array.of(0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60);
    await writeFile(prg, Uint8Array.of(0x00, 0x10, ...bytes));
    const state = new C64AnalysisState("saved");
    const graph = state.analyze(new C6510Decoder(bytes, 0x1000), "ram", [{ address: 0x1000, source: "user" }]);
    state.addLabel(graph, 0x1000, "main", "code");
    state.addAnnotation(graph, "entry", 0x1000, "Border setup", "Sets screen border");
    await writeFile(saved, state.serialize());
    return { prg, saved };
}

describe("offline analysis MCP tools", () => {
    it("reports analysis identity and guards substantial live code changes without discarding notes", async () => {
        const { client, execute } = await setup();
        const status = () => client.callTool({ name: "vice_analysis_status", arguments: {} });
        expect(JSON.parse(text(await status()))).toEqual({ active: false });
        expect(execute).not.toHaveBeenCalled();

        const bytes = new Uint8Array(65536);
        bytes.fill(0xea, 0x1000, 0x10a0);
        bytes[0x10a0] = 0x60;
        const captured = {
            bytes,
            pc: 0xb000,
            direction: 0x2f,
            port: 0x37,
            banking: { cartridge: "unknown" as const, direction: 0x2f, data: 0x37 },
            capturedAt: new Date().toISOString(),
            labels: [{ address: 0x1000, name: ".old_game" }],
        };
        const spy = vi.spyOn(liveCapture, "captureC64Ram").mockResolvedValue(captured);
        const capture = (arguments_: Record<string, unknown>) =>
            client.callTool({ name: "vice_analysis_capture", arguments: { machine: "c64", ...arguments_ } });
        const initial = await capture({ programId: "first", entryPoints: [4096] });
        expect(initial.isError, text(initial)).not.toBe(true);
        const snapshotId = JSON.parse(text(initial)).snapshotId as string;
        expect(JSON.parse(text(await status()))).toMatchObject({
            active: true,
            programId: "first",
            snapshotId,
            identityVerified: false,
        });
        const edited = await client.callTool({
            name: "vice_analysis_edit",
            arguments: {
                snapshotId,
                action: "annotation_add",
                annotationKind: "entry",
                address: 4096,
                name: "First game",
            },
        });
        expect(edited.isError, text(edited)).not.toBe(true);

        const mismatchName = await capture({ snapshotId, programId: "second" });
        expect(mismatchName.isError).toBe(true);
        expect(text(mismatchName)).toContain("Omit snapshotId");
        expect(spy).toHaveBeenCalledTimes(1);

        const changed = bytes.slice();
        changed.fill(0x60, 0x1000, 0x1064);
        spy.mockResolvedValue({ ...captured, bytes: changed });
        const mismatch = await capture({ snapshotId });
        expect(mismatch.isError).toBe(true);
        expect(text(mismatch)).toContain("100 of 161");
        expect(text(mismatch)).toContain("previous analysis was preserved");
        expect(JSON.parse(text(await status()))).toMatchObject({ programId: "first", snapshotId });
        const notes = await client.callTool({
            name: "vice_analysis_search",
            arguments: { snapshotId, kind: "annotation", text: "*" },
        });
        expect(JSON.parse(text(notes)).items).toHaveLength(1);

        const confirmed = await capture({ snapshotId, programId: "first", confirmSameProgram: true });
        expect(confirmed.isError, text(confirmed)).not.toBe(true);
        expect(JSON.parse(text(confirmed))).toMatchObject({
            programId: "first",
            codeComparison: { compared: 161, changed: 100, possibleProgramChange: true },
        });
        const confirmedId = JSON.parse(text(confirmed)).snapshotId as string;
        const preserved = await client.callTool({
            name: "vice_analysis_search",
            arguments: { snapshotId: confirmedId, kind: "annotation", text: "*" },
        });
        expect(JSON.parse(text(preserved)).items).toHaveLength(1);

        const replacement = await capture({ programId: "second", entryPoints: [4096], importViceLabels: false });
        expect(replacement.isError, text(replacement)).not.toBe(true);
        expect(JSON.parse(text(replacement))).toMatchObject({ programId: "second", labelsImported: 0 });
        const secondId = JSON.parse(text(replacement)).snapshotId as string;
        expect(secondId).not.toBe(confirmedId);
        const freshNotes = await client.callTool({
            name: "vice_analysis_search",
            arguments: { snapshotId: secondId, kind: "annotation", text: "*" },
        });
        expect(JSON.parse(text(freshNotes)).items).toEqual([]);
        const freshLabels = await client.callTool({
            name: "vice_analysis_search",
            arguments: { snapshotId: secondId, kind: "label", text: "old_game" },
        });
        expect(JSON.parse(text(freshLabels)).items).toEqual([]);
        expect(
            (
                await client.callTool({
                    name: "vice_analysis_search",
                    arguments: { snapshotId: confirmedId, kind: "annotation", text: "*" },
                })
            ).isError,
        ).toBe(true);
    });

    it("allows small changes, treats the threshold as strict, and preserves state if fresh capture fails", async () => {
        const { client } = await setup();
        const bytes = new Uint8Array(65536);
        bytes.fill(0xea, 0x1000, 0x107f);
        bytes[0x107f] = 0x60;
        const captured = {
            bytes,
            pc: 0xb000,
            direction: 0x2f,
            port: 0x37,
            banking: { cartridge: "unknown" as const, direction: 0x2f, data: 0x37 },
            capturedAt: new Date().toISOString(),
            labels: [],
        };
        const spy = vi.spyOn(liveCapture, "captureC64Ram").mockResolvedValue(captured);
        const first = await client.callTool({
            name: "vice_analysis_capture",
            arguments: { machine: "c64", programId: "game", entryPoints: [4096] },
        });
        const snapshotId = JSON.parse(text(first)).snapshotId as string;
        const aboveThreshold = bytes.slice();
        aboveThreshold.fill(0x60, 0x1000, 0x1041);
        spy.mockResolvedValue({ ...captured, bytes: aboveThreshold });
        const rejected = await client.callTool({
            name: "vice_analysis_capture",
            arguments: { machine: "c64", snapshotId },
        });
        expect(rejected.isError).toBe(true);
        expect(text(rejected)).toContain("65 of 128");
        const changed = bytes.slice();
        changed.fill(0x60, 0x1000, 0x1040);
        spy.mockResolvedValue({ ...captured, bytes: changed });
        const next = await client.callTool({
            name: "vice_analysis_capture",
            arguments: { machine: "c64", snapshotId },
        });
        expect(next.isError, text(next)).not.toBe(true);
        expect(JSON.parse(text(next))).toMatchObject({
            codeComparison: { compared: 128, changed: 64, possibleProgramChange: false },
        });
        const nextId = JSON.parse(text(next)).snapshotId as string;
        spy.mockRejectedValueOnce(new Error("capture failed"));
        const failed = await client.callTool({
            name: "vice_analysis_capture",
            arguments: { machine: "c64", programId: "other" },
        });
        expect(failed.isError).toBe(true);
        const status = await client.callTool({ name: "vice_analysis_status", arguments: {} });
        expect(JSON.parse(text(status))).toMatchObject({ programId: "game", snapshotId: nextId });
    });

    it("requires at least 64 changed candidate bytes before warning", async () => {
        const { client } = await setup();
        const bytes = new Uint8Array(65536);
        bytes.fill(0xea, 0x1000, 0x1063);
        bytes[0x1063] = 0x60;
        const captured = {
            bytes,
            pc: 0xb000,
            direction: 0x2f,
            port: 0x37,
            banking: { cartridge: "unknown" as const, direction: 0x2f, data: 0x37 },
            capturedAt: new Date().toISOString(),
            labels: [],
        };
        const spy = vi.spyOn(liveCapture, "captureC64Ram").mockResolvedValue(captured);
        const capture = (arguments_: Record<string, unknown>) =>
            client.callTool({ name: "vice_analysis_capture", arguments: { machine: "c64", ...arguments_ } });
        const initial = await capture({ programId: "game", entryPoints: [4096] });
        const snapshotId = JSON.parse(text(initial)).snapshotId as string;
        const changed = bytes.slice();
        changed.fill(0x60, 0x1000, 0x1040);
        spy.mockResolvedValue({ ...captured, bytes: changed });
        expect((await capture({ snapshotId })).isError).toBe(true);
        changed[0x103f] = 0xea;
        const next = await capture({ snapshotId });
        expect(next.isError, text(next)).not.toBe(true);
        expect(JSON.parse(text(next))).toMatchObject({
            codeComparison: { compared: 100, changed: 63, possibleProgramChange: false },
        });
    });

    it("defaults to documented opcodes and persists explicit opt-in edits", async () => {
        const { prg, saved } = await files();
        await writeFile(prg, Uint8Array.of(0x00, 0x10, 0xea, 0x02));
        const { client } = await setup();
        const created = await client.callTool({
            name: "vice_analysis_create",
            arguments: { path: prg, format: "prg", entryPoints: [4096] },
        });
        const summary = JSON.parse(text(created)) as { snapshotId: string; includeIllegalOpcodes: boolean };
        expect(summary.includeIllegalOpcodes).toBe(false);
        const search = () =>
            client.callTool({
                name: "vice_analysis_search",
                arguments: { snapshotId: summary.snapshotId, kind: "instruction", text: "KIL" },
            });
        expect(JSON.parse(text(await search())).items).toEqual([]);
        const toggle = await client.callTool({
            name: "vice_analysis_edit",
            arguments: { snapshotId: summary.snapshotId, action: "set_illegal_opcodes", enabled: true },
        });
        expect(JSON.parse(text(toggle))).toMatchObject({ includeIllegalOpcodes: true });
        expect(JSON.parse(text(await search()))).toMatchObject({
            includeIllegalOpcodes: true,
            items: [{ illegal: true, text: "KIL" }],
        });
        const path = `${saved}.policy`;
        expect(
            (
                await client.callTool({
                    name: "vice_analysis_save",
                    arguments: { snapshotId: summary.snapshotId, path, confirm: true },
                })
            ).isError,
        ).not.toBe(true);
        const restored = await client.callTool({
            name: "vice_analysis_create",
            arguments: { path, format: "state", viewId: "prg-payload" },
        });
        expect(JSON.parse(text(restored))).toMatchObject({ includeIllegalOpcodes: true });
        const disabled = await client.callTool({
            name: "vice_analysis_edit",
            arguments: { snapshotId: summary.snapshotId, action: "set_illegal_opcodes", enabled: false },
        });
        expect(JSON.parse(text(disabled))).toMatchObject({ includeIllegalOpcodes: false });
        expect(JSON.parse(text(await search())).items).toEqual([]);
        const optIn = await client.callTool({
            name: "vice_analysis_create",
            arguments: { path: prg, format: "prg", entryPoints: [4096], includeIllegalOpcodes: true },
        });
        expect(JSON.parse(text(optIn))).toMatchObject({ includeIllegalOpcodes: true });
    });

    it("lists candidate memory regions and exports reversible unused-range omissions", async () => {
        const { prg, saved } = await files();
        const { client } = await setup();
        const created = await client.callTool({
            name: "vice_analysis_create",
            arguments: { path: prg, format: "prg", entryPoints: [4096] },
        });
        const snapshotId = (JSON.parse(text(created)) as { snapshotId: string }).snapshotId;
        const regions = await client.callTool({
            name: "vice_analysis_regions",
            arguments: { snapshotId, kind: "code", limit: 1 },
        });
        const page = JSON.parse(text(regions));
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({ start: 4096, kind: "code", basicOverlap: false });
        expect(page.items[0]).not.toHaveProperty("bytes");
        const excluded = await client.callTool({
            name: "vice_analysis_edit",
            arguments: {
                snapshotId,
                action: "data_add",
                start: 4098,
                end: 4100,
                dataType: "unused",
                description: "Test omission",
            },
        });
        expect(excluded.isError, text(excluded)).not.toBe(true);
        const path = `${saved}.listing`;
        const exported = await client.callTool({
            name: "vice_analysis_export",
            arguments: { snapshotId, path, confirm: true },
        });
        expect(exported.isError, text(exported)).not.toBe(true);
        expect(await readFile(path, "utf8")).not.toContain("    STA ");
        const full = await client.callTool({
            name: "vice_analysis_export",
            arguments: { snapshotId, path, confirm: true, overwrite: true, includeUnused: true },
        });
        expect(full.isError, text(full)).not.toBe(true);
        expect(await readFile(path, "utf8")).toContain("    STA ");
        const instructions = await client.callTool({
            name: "vice_analysis_search",
            arguments: { snapshotId, kind: "instruction", text: "STA" },
        });
        expect(JSON.parse(text(instructions)).items).toHaveLength(1);
    });

    it("reconciles live recaptures and keeps prior state on failed edits or captures", async () => {
        const { client } = await setup();
        const bytes = new Uint8Array(65536);
        bytes.set([0xa9, 0x01, 0x60], 0x1000);
        const spy = vi.spyOn(liveCapture, "captureC64Ram");
        const captured = {
            bytes,
            pc: 0xb000,
            direction: 0x2f,
            port: 0x37,
            banking: { cartridge: "unknown" as const, direction: 0x2f, data: 0x37 },
            capturedAt: new Date().toISOString(),
            labels: [{ address: 0x1000, name: ".vice_start" }],
        };
        spy.mockResolvedValue(captured);
        const first = await client.callTool({
            name: "vice_analysis_capture",
            arguments: { machine: "c64", programId: "game", includeIllegalOpcodes: true },
        });
        expect(first.isError, text(first)).not.toBe(true);
        expect(JSON.parse(text(first))).toMatchObject({ includeIllegalOpcodes: true });
        const snapshotId = (JSON.parse(text(first)) as { snapshotId: string }).snapshotId;
        const edit = (args: Record<string, unknown>, id = snapshotId) =>
            client.callTool({
                name: "vice_analysis_edit",
                arguments: { snapshotId: id, ...args },
            });
        expect((await edit({ action: "entry_add", address: 4096 })).isError).not.toBe(true);
        const data = await edit({ action: "data_add", start: 4097, end: 4097, dataType: "sprite" });
        const dataId = (JSON.parse(text(data)) as { id: string }).id;
        const correction = await edit({ action: "exclude_add", start: 4100, end: 4100 });
        const correctionId = (JSON.parse(text(correction)) as { id: string }).id;
        expect((await edit({ action: "data_update", id: dataId, dataType: "" })).isError).toBe(true);
        const changed = bytes.slice();
        changed[0x1001] = 2;
        spy.mockResolvedValueOnce({ ...captured, bytes: changed });
        const next = await client.callTool({
            name: "vice_analysis_capture",
            arguments: { machine: "c64", snapshotId },
        });
        expect(next.isError, text(next)).not.toBe(true);
        expect(JSON.parse(text(next))).toMatchObject({ includeIllegalOpcodes: true });
        const nextId = (JSON.parse(text(next)) as { snapshotId: string }).snapshotId;
        expect(nextId).not.toBe(snapshotId);
        const search = (id: string, kind: string) =>
            client.callTool({
                name: "vice_analysis_search",
                arguments: { snapshotId: id, kind, text: "*" },
            });
        expect(JSON.parse(text(await search(nextId, "data")))).toMatchObject({
            items: [{ id: dataId, status: "stale" }],
        });
        expect(JSON.parse(text(await search(nextId, "correction")))).toMatchObject({
            items: [{ id: correctionId, status: "active" }],
        });
        expect(JSON.parse(text(await search(nextId, "label"))).items).toContainEqual(
            expect.objectContaining({ text: ".vice_start", source: "vice" }),
        );
        expect(JSON.parse(text(await search(nextId, "entry"))).items).toContainEqual(
            expect.objectContaining({ address: 4096, source: "user" }),
        );
        expect((await edit({ action: "data_reattach", id: dataId, start: 4097, end: 4097 }, nextId)).isError).not.toBe(
            true,
        );
        expect(JSON.parse(text(await search(nextId, "data")))).toMatchObject({
            items: [{ id: dataId, status: "active" }],
        });
        spy.mockRejectedValueOnce(new Error("capture failed"));
        expect(
            (
                await client.callTool({
                    name: "vice_analysis_capture",
                    arguments: { machine: "c64", snapshotId: nextId },
                })
            ).isError,
        ).toBe(true);
        expect((await search(nextId, "data")).isError).not.toBe(true);
        expect((await search(snapshotId, "data")).isError).toBe(true);
        const overridden = await client.callTool({
            name: "vice_analysis_capture",
            arguments: { machine: "c64", snapshotId: nextId, includeIllegalOpcodes: false },
        });
        expect(overridden.isError, text(overridden)).not.toBe(true);
        expect(JSON.parse(text(overridden))).toMatchObject({ includeIllegalOpcodes: false });
    });

    it("edits session knowledge, exports it and explicitly saves and restores the state", async () => {
        const { prg, saved } = await files();
        const { client } = await setup();
        const created = await client.callTool({
            name: "vice_analysis_create",
            arguments: { path: prg, format: "prg", entryPoints: [4096] },
        });
        const { snapshotId } = JSON.parse(text(created)) as { snapshotId: string };
        const edit = async (args: Record<string, unknown>) => {
            const result = await client.callTool({ name: "vice_analysis_edit", arguments: { snapshotId, ...args } });
            expect(result.isError, text(result)).not.toBe(true);
            return JSON.parse(text(result)) as { id?: string };
        };
        const label = await edit({ action: "label_add", address: 4096, name: "display_start", labelKind: "code" });
        const note = await edit({
            action: "annotation_add",
            address: 4096,
            name: "Initialize display",
            description: "Writes a color\rAnother hint\nFinal hint",
            annotationKind: "block",
        });
        const data = await edit({
            action: "data_add",
            start: 4101,
            end: 4101,
            dataType: "sprite",
            description: "Possible sprite data",
        });
        expect(label.id).toBeTruthy();
        expect(note.id).toBeTruthy();
        expect(data.id).toBeTruthy();
        const result = await client.callTool({
            name: "vice_analysis_search",
            arguments: { snapshotId, kind: "data", text: "sprite" },
        });
        expect(JSON.parse(text(result))).toMatchObject({
            items: [{ id: data.id, status: "active", dataType: "sprite" }],
        });
        const exportPath = `${saved}.asm`;
        const exported = await client.callTool({
            name: "vice_analysis_export",
            arguments: { snapshotId, path: exportPath, confirm: true },
        });
        expect(exported.isError, text(exported)).not.toBe(true);
        const listing = await readFile(exportPath, "utf8");
        expect(listing).toContain("not reassemblable source");
        expect(listing).toContain("display_start:");
        expect(listing).toContain("Initialize display");
        expect(listing).toContain("Writes a color");
        expect(listing).toMatch(/; +Writes a color\n; +Another hint\n; +Final hint/);
        expect(listing).toContain("$1005-$1005 sprite [active]");
        expect(listing).toContain("Possible sprite data");
        expect(
            (
                await client.callTool({
                    name: "vice_analysis_export",
                    arguments: { snapshotId, path: exportPath, confirm: true },
                })
            ).isError,
        ).toBe(true);
        expect(await readFile(exportPath, "utf8")).toBe(listing);
        expect(
            (
                await client.callTool({
                    name: "vice_analysis_save",
                    arguments: { snapshotId, path: saved, confirm: true },
                })
            ).isError,
        ).toBe(true);
        expect(
            (
                await client.callTool({
                    name: "vice_analysis_save",
                    arguments: { snapshotId, path: saved, confirm: true, overwrite: true },
                })
            ).isError,
        ).not.toBe(true);
        const restored = await client.callTool({
            name: "vice_analysis_create",
            arguments: { path: saved, format: "state", viewId: "prg-payload" },
        });
        const restoredId = (JSON.parse(text(restored)) as { snapshotId: string }).snapshotId;
        const restoredData = await client.callTool({
            name: "vice_analysis_search",
            arguments: { snapshotId: restoredId, kind: "data", text: "sprite" },
        });
        expect(JSON.parse(text(restoredData))).toMatchObject({ items: [{ id: data.id, status: "active" }] });
        await edit({ action: "data_update", id: data.id, dataType: "text", description: "Updated" });
        const updated = await client.callTool({
            name: "vice_analysis_search",
            arguments: { snapshotId: restoredId, kind: "data", text: "text" },
        });
        expect(JSON.parse(text(updated))).toMatchObject({ items: [{ id: data.id, dataType: "text" }] });
        await edit({ action: "label_rename", id: label.id, name: "renamed" });
        await edit({ action: "annotation_update", id: note.id, name: "Renamed block", description: "New hint" });
        await edit({ action: "data_remove", id: data.id });
        await edit({ action: "annotation_remove", id: note.id });
        await edit({ action: "label_remove", id: label.id });
    });

    it("discovers BASIC SYS targets by default and reports unresolved expressions", async () => {
        const { prg } = await files();
        await writeFile(
            prg,
            Uint8Array.of(0x01, 0x08, 0x0e, 0x08, 10, 0, 0x9e, 0x32, 0x30, 0x36, 0x34, 0x3a, 0x9e, 0x41, 0, 0, 0, 0x60),
        );
        const { client } = await setup();
        const created = await client.callTool({
            name: "vice_analysis_create",
            arguments: { path: prg, format: "prg" },
        });
        expect(created.isError).not.toBe(true);
        const summary = JSON.parse(text(created)) as { snapshotId: string };
        expect(JSON.parse(text(created))).toMatchObject({
            unresolvedBasicSys: 1,
            basicPrograms: 1,
            entryPoints: [{ address: 0x0810, source: "basic-sys" }],
        });
        const caller = await client.callTool({
            name: "vice_analysis_routine",
            arguments: { snapshotId: summary.snapshotId, entry: 0x0810 },
        });
        expect(JSON.parse(text(caller)).items).toContainEqual(
            expect.objectContaining({ kind: "caller", edge: "basic-sys", target: 0x0810 }),
        );
        const regions = await client.callTool({
            name: "vice_analysis_regions",
            arguments: { snapshotId: summary.snapshotId, kind: "unknown" },
        });
        expect(JSON.parse(text(regions)).items).toContainEqual(expect.objectContaining({ basicOverlap: true }));
    });

    it("creates and paginates PRG queries without touching the monitor", async () => {
        const { prg } = await files();
        const { client, execute } = await setup();
        const created = await client.callTool({
            name: "vice_analysis_create",
            arguments: { path: prg, format: "prg", entryPoints: [4096] },
        });
        expect(created.isError).not.toBe(true);
        const summary = JSON.parse(text(created)) as {
            snapshotId: string;
            banking: { cartridge: string };
            instructions: number;
        };
        expect(summary).toMatchObject({ instructions: 3, banking: { cartridge: "none" } });
        const search = await client.callTool({
            name: "vice_analysis_search",
            arguments: { snapshotId: summary.snapshotId, text: "STA", kind: "instruction", limit: 1 },
        });
        expect(JSON.parse(text(search))).toMatchObject({
            snapshotId: summary.snapshotId,
            total: 1,
            items: [{ address: 4098 }],
        });
        const refs = await client.callTool({
            name: "vice_analysis_references",
            arguments: { snapshotId: summary.snapshotId, start: 53280 },
        });
        expect(JSON.parse(text(refs))).toMatchObject({
            total: 1,
            items: [{ kind: "memory", match: "direct", reference: { access: "write" } }],
        });
        const routine = await client.callTool({
            name: "vice_analysis_routine",
            arguments: { snapshotId: summary.snapshotId, entry: 4096, limit: 2 },
        });
        expect(JSON.parse(text(routine))).toMatchObject({
            limit: 2,
            nextOffset: 2,
            items: [{ kind: "block" }, { kind: "instruction" }],
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it("restores labels and annotations, rejects bad inputs and preserves the current snapshot on failed creation", async () => {
        const { prg, saved } = await files();
        const { client } = await setup();
        const restored = await client.callTool({
            name: "vice_analysis_create",
            arguments: { path: saved, format: "state", viewId: "ram" },
        });
        expect(restored.isError).not.toBe(true);
        const { snapshotId } = JSON.parse(text(restored)) as { snapshotId: string };
        const label = await client.callTool({
            name: "vice_analysis_search",
            arguments: { snapshotId, text: "main", kind: "label" },
        });
        expect(JSON.parse(text(label))).toMatchObject({ items: [{ text: "main", status: "unchanged" }] });
        const annotation = await client.callTool({
            name: "vice_analysis_search",
            arguments: { snapshotId, text: "border", kind: "annotation" },
        });
        expect(JSON.parse(text(annotation))).toMatchObject({ items: [{ status: "unchanged" }] });
        const bad = await client.callTool({ name: "vice_analysis_create", arguments: { path: prg, format: "prg" } });
        expect(bad.isError).toBe(true);
        expect(
            (
                await client.callTool({
                    name: "vice_analysis_search",
                    arguments: { snapshotId, text: "main", limit: 101 },
                })
            ).isError,
        ).toBe(true);
        expect(
            (await client.callTool({ name: "vice_analysis_search", arguments: { snapshotId, text: "main" } })).isError,
        ).not.toBe(true);
        expect(
            (await client.callTool({ name: "vice_analysis_references", arguments: { snapshotId: "other", start: 0 } }))
                .isError,
        ).toBe(true);
        await writeFile(prg, Buffer.alloc(65539));
        expect(
            (
                await client.callTool({
                    name: "vice_analysis_create",
                    arguments: { path: prg, format: "prg", entryPoints: [4096] },
                })
            ).isError,
        ).toBe(true);
        expect(
            (await client.callTool({ name: "vice_analysis_search", arguments: { snapshotId, text: "main" } })).isError,
        ).not.toBe(true);
        await writeFile(prg, Uint8Array.of(0x00, 0x10, 0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60));
        const replaced = await client.callTool({
            name: "vice_analysis_create",
            arguments: { path: prg, format: "prg", entryPoints: [4096] },
        });
        expect(replaced.isError).not.toBe(true);
        expect(
            (await client.callTool({ name: "vice_analysis_search", arguments: { snapshotId, text: "main" } })).isError,
        ).toBe(true);
    });
});
