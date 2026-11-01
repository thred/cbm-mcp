import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request } from "node:http";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHttpService, type HttpService } from "../src/http-service.js";
import { MonitorClient } from "../src/vice/monitor-client.js";
import * as liveCapture from "../src/analysis-engine/c64-live-capture.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.restoreAllMocks();
});

async function fixture(authenticated = true) {
    const sockets = new Set<Socket>();
    const commands: string[] = [];
    let connections = 0;
    let finishStep: (() => void) | undefined;
    const vice = createServer((socket) => {
        connections++;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        let buffer = "";
        let first = true;
        socket.on("data", (chunk) => {
            buffer += chunk.toString();
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                const command = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                commands.push(command);
                if (first) {
                    first = false;
                    socket.write("(C:$e5cf) \nregister data\n(C:$e5cf) ");
                } else if (command === "step $0001") {
                    finishStep = () => socket.write("stepped\n(C:$e5cf) ");
                } else if (command !== "exit") {
                    socket.write("ok\n(C:$e5cf) ");
                }
            }
        });
    });
    await new Promise<void>((resolve) => vice.listen(0, "127.0.0.1", resolve));
    const address = vice.address();
    if (!address || typeof address === "string") throw new Error("Missing VICE address.");
    cleanup.push(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => vice.close((error) => (error ? reject(error) : resolve())));
    });
    const monitor = new MonitorClient({ port: address.port, timeoutMs: 500 });
    const service = await startHttpService({ token: authenticated ? TOKEN : undefined, port: 0, monitor });
    cleanup.push(() => service.close());
    return {
        service,
        commands,
        monitor,
        connections: () => connections,
        finishStep: () => finishStep?.(),
        disconnectVice: () => {
            for (const socket of sockets) socket.destroy();
        },
    };
}

async function connect(service: HttpService, authenticated = true) {
    const client = new Client({ name: "test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`), {
        requestInit: authenticated ? { headers: { authorization: `Bearer ${TOKEN}` } } : undefined,
    });
    await client.connect(transport);
    cleanup.push(() => client.close());
    return { client, transport };
}

function text(result: unknown): string {
    if (
        typeof result !== "object" ||
        result === null ||
        !("content" in result) ||
        !Array.isArray(result.content) ||
        typeof result.content[0]?.text !== "string"
    ) {
        throw new Error("Expected text tool result.");
    }
    return result.content[0].text;
}

describe("shared HTTP MCP", () => {
    it("releases the lease after successful capture but retains it after failure", async () => {
        const { service } = await fixture();
        const first = await connect(service);
        const second = await connect(service);
        const bytes = new Uint8Array(65536);
        bytes.set([0xea, 0x60], 0x1000);
        const capture = vi.spyOn(liveCapture, "captureC64Ram").mockResolvedValue({
            bytes,
            pc: 0x1000,
            direction: 0x2f,
            port: 0x37,
            banking: { cartridge: "unknown", direction: 0x2f, data: 0x37 },
            capturedAt: new Date().toISOString(),
            labels: [],
        });
        const created = await first.client.callTool({
            name: "vice_analysis_capture",
            arguments: { machine: "c64", programId: "test" },
        });
        expect(created.isError, text(created)).not.toBe(true);
        const { snapshotId } = JSON.parse(text(created)) as { snapshotId: string };
        expect((await second.client.callTool({ name: "vice_registers" })).isError).not.toBe(true);
        expect(
            (await first.client.callTool({ name: "vice_analysis_search", arguments: { snapshotId, text: "NOP" } }))
                .isError,
        ).not.toBe(true);
        expect(
            (await second.client.callTool({ name: "vice_analysis_search", arguments: { snapshotId, text: "NOP" } }))
                .isError,
        ).toBe(true);
        expect((await second.client.callTool({ name: "vice_lease_release" })).isError).not.toBe(true);
        capture.mockRejectedValueOnce(new Error("capture failed"));
        expect(
            (await first.client.callTool({ name: "vice_analysis_capture", arguments: { machine: "c64", snapshotId } }))
                .isError,
        ).toBe(true);
        expect((await second.client.callTool({ name: "vice_registers" })).isError).toBe(true);
        expect(
            (await first.client.callTool({ name: "vice_analysis_search", arguments: { snapshotId, text: "NOP" } }))
                .isError,
        ).not.toBe(true);
        expect((await first.client.callTool({ name: "vice_lease_release" })).isError).not.toBe(true);
    });

    it("isolates offline analyses per session without acquiring or taking over the VICE lease", async () => {
        const directory = await mkdtemp(join(tmpdir(), "cbm-http-analysis-"));
        cleanup.push(() => rm(directory, { recursive: true }));
        const path = join(directory, "test.prg");
        await writeFile(path, Uint8Array.of(0x00, 0x10, 0xea, 0x60));
        const { service, commands, connections } = await fixture();
        const first = await connect(service);
        const second = await connect(service);
        expect((await first.client.callTool({ name: "vice_registers" })).isError).not.toBe(true);
        const created = await second.client.callTool({
            name: "vice_analysis_create",
            arguments: { path, format: "prg", entryPoints: [4096] },
        });
        expect(created.isError).not.toBe(true);
        const { snapshotId } = JSON.parse(text(created)) as { snapshotId: string };
        expect(
            (await second.client.callTool({ name: "vice_analysis_search", arguments: { snapshotId, text: "NOP" } }))
                .isError,
        ).not.toBe(true);
        expect(
            (await first.client.callTool({ name: "vice_analysis_search", arguments: { snapshotId, text: "NOP" } }))
                .isError,
        ).toBe(true);
        expect((await second.client.callTool({ name: "vice_registers" })).isError).toBe(true);
        expect(connections()).toBe(1);
        expect(commands).toEqual(["registers", "registers"]);
    });

    it("allows local MCP clients without a token and warns about unauthenticated access", async () => {
        const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { service, commands, connections } = await fixture(false);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("authentication is disabled"));
        const first = await connect(service, false);
        const second = await connect(service, false);
        expect((await first.client.callTool({ name: "vice_registers" })).isError).not.toBe(true);
        expect((await second.client.callTool({ name: "vice_registers" })).isError).toBe(true);
        expect(connections()).toBe(1);
        expect(commands).toEqual(["registers", "registers"]);
        const url = `http://127.0.0.1:${service.port}`;
        expect((await fetch(`${url}/mcp`, { method: "POST", headers: { origin: "https://evil.test" } })).status).toBe(
            403,
        );
        const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
            const req = request(`${url}/mcp`, { method: "POST", headers: { host: "evil.test" } }, (res) => {
                res.resume();
                resolve(res.statusCode);
            });
            req.on("error", reject);
            req.end();
        });
        expect(invalidHost).toBe(403);
        expect((await fetch(`${url}/sessions`, { method: "DELETE" })).status).toBe(400);
        const cleared = await fetch(`${url}/sessions`, { method: "DELETE", headers: { "x-cbm-confirm": "true" } });
        expect(await cleared.json()).toMatchObject({ closed: 2 });
    });

    it("authenticates, rejects browser origins and invalid Host headers", async () => {
        const { service, connections } = await fixture();
        const url = `http://127.0.0.1:${service.port}/mcp`;
        expect((await fetch(url, { method: "POST" })).status).toBe(401);
        expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer invalid" } })).status).toBe(401);
        expect(
            (
                await fetch(url, {
                    method: "POST",
                    headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.test" },
                })
            ).status,
        ).toBe(403);
        const status = await new Promise<number | undefined>((resolve, reject) => {
            const req = request(
                url,
                { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, host: "evil.test" } },
                (res) => {
                    res.resume();
                    resolve(res.statusCode);
                },
            );
            req.on("error", reject);
            req.end();
        });
        expect(status).toBe(403);
        expect(connections()).toBe(0);
    });

    it("shares one VICE connection, rejects competing calls, and takes over only with confirmation", async () => {
        const { service, commands, connections } = await fixture();
        const first = await connect(service);
        const second = await connect(service);
        expect((await first.client.callTool({ name: "vice_registers" })).isError).not.toBe(true);
        const status = await second.client.callTool({ name: "vice_lease_status" });
        const lease = (JSON.parse(text(status)) as { lease: { id: string; yours: boolean } }).lease;
        expect(lease.yours).toBe(false);
        expect((await second.client.callTool({ name: "vice_registers" })).isError).toBe(true);
        expect(
            (
                await second.client.callTool({
                    name: "vice_lease_takeover",
                    arguments: { leaseId: lease.id, confirm: false },
                })
            ).isError,
        ).toBe(true);
        expect(
            (
                await second.client.callTool({
                    name: "vice_lease_takeover",
                    arguments: { leaseId: lease.id, confirm: true },
                })
            ).isError,
        ).not.toBe(true);
        expect((await first.client.callTool({ name: "vice_registers" })).isError).toBe(true);
        expect((await second.client.callTool({ name: "vice_registers" })).isError).not.toBe(true);
        expect(connections()).toBe(1);
        expect(commands).toEqual(["registers", "registers", "registers"]);
        expect((await second.client.callTool({ name: "vice_lease_release" })).isError).not.toBe(true);
        expect((await first.client.callTool({ name: "vice_registers" })).isError).not.toBe(true);
        expect(connections()).toBe(1);
        expect(commands).not.toContain("exit");
    });

    it("keeps an abandoned lease after session deletion and permits confirmed takeover", async () => {
        const { service, commands } = await fixture();
        const first = await connect(service);
        const second = await connect(service);
        await first.client.callTool({ name: "vice_registers" });
        await first.transport.terminateSession();
        const status = JSON.parse(text(await second.client.callTool({ name: "vice_lease_status" }))) as {
            lease: { id: string; ownerSessionKnown: boolean };
        };
        expect(status.lease.ownerSessionKnown).toBe(false);
        expect(
            (
                await second.client.callTool({
                    name: "vice_lease_takeover",
                    arguments: { leaseId: status.lease.id, confirm: true },
                })
            ).isError,
        ).not.toBe(true);
        expect(commands).not.toContain("exit");
    });

    it("closes abandoned sessions only on explicit request and preserves the lease", async () => {
        const { service, commands } = await fixture();
        const first = await connect(service);
        const second = await connect(service);
        await first.client.callTool({ name: "vice_registers" });
        expect(
            (await second.client.callTool({ name: "vice_sessions_close_others", arguments: { confirm: false } }))
                .isError,
        ).toBe(true);
        const result = await second.client.callTool({
            name: "vice_sessions_close_others",
            arguments: { confirm: true },
        });
        expect(JSON.parse(text(result))).toMatchObject({ closed: 1 });
        const status = JSON.parse(text(await second.client.callTool({ name: "vice_lease_status" }))) as {
            lease: { id: string; ownerSessionKnown: boolean };
        };
        expect(status.lease.ownerSessionKnown).toBe(false);
        expect((await second.client.callTool({ name: "vice_registers" })).isError).toBe(true);
        expect(commands).not.toContain("exit");
    });

    it("allows explicit recovery of session capacity without releasing the VICE lease", async () => {
        const { service, commands } = await fixture();
        const first = await connect(service);
        await first.client.callTool({ name: "vice_registers" });
        const url = `http://127.0.0.1:${service.port}/sessions`;
        const headers = { authorization: `Bearer ${TOKEN}` };
        expect((await fetch(url, { method: "DELETE", headers })).status).toBe(400);
        const cleared = await fetch(url, { method: "DELETE", headers: { ...headers, "x-cbm-confirm": "true" } });
        expect(await cleared.json()).toMatchObject({ closed: 1 });
        const second = await connect(service);
        const status = JSON.parse(text(await second.client.callTool({ name: "vice_lease_status" }))) as {
            lease: { ownerSessionKnown: boolean };
        };
        expect(status.lease.ownerSessionKnown).toBe(false);
        expect((await second.client.callTool({ name: "vice_registers" })).isError).toBe(true);
        expect(commands).not.toContain("exit");
    });

    it("waits for a whole in-flight tool before transferring a lease", async () => {
        const { service, commands, finishStep } = await fixture();
        const first = await connect(service);
        const second = await connect(service);
        await first.client.callTool({ name: "vice_registers" });
        const status = JSON.parse(text(await second.client.callTool({ name: "vice_lease_status" }))) as {
            lease: { id: string };
        };
        const step = first.client.callTool({ name: "vice_step" });
        await vi.waitFor(() => expect(commands).toContain("step $0001"));
        let taken = false;
        const takeover = second.client
            .callTool({ name: "vice_lease_takeover", arguments: { leaseId: status.lease.id, confirm: true } })
            .then((result) => {
                taken = true;
                return result;
            });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(taken).toBe(false);
        finishStep();
        expect((await step).isError).not.toBe(true);
        expect((await takeover).isError).not.toBe(true);
    });

    it("reports a lost VICE connection and reconnects only on a later explicit call", async () => {
        const { service, commands, connections, disconnectVice, monitor } = await fixture();
        const { client } = await connect(service);
        expect((await client.callTool({ name: "vice_registers" })).isError).not.toBe(true);
        disconnectVice();
        await vi.waitFor(() => expect(monitor.connected).toBe(false));
        const status = JSON.parse(text(await client.callTool({ name: "vice_lease_status" }))) as {
            monitor: { connected: boolean; lastFailure: { phase: string; message: string } };
        };
        expect(status.monitor.connected).toBe(false);
        expect(status.monitor.lastFailure.phase).toBe("command");
        expect(status.monitor.lastFailure.message).toContain("closed");
        expect(connections()).toBe(1);
        expect((await client.callTool({ name: "vice_registers" })).isError).not.toBe(true);
        expect(connections()).toBe(2);
        expect(commands).toEqual(["registers", "registers", "registers", "registers"]);
    });

    it("rejects weak tokens before opening a listener", async () => {
        await expect(startHttpService({ token: "short", port: 0 })).rejects.toThrow("32-256");
        await expect(startHttpService({ token: "", port: 0 })).rejects.toThrow("32-256");
    });
});
