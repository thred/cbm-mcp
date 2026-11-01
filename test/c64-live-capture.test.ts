import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { captureC64Ram } from "../src/analysis-engine/c64-live-capture.js";
import { MonitorClient } from "../src/vice/monitor-client.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function fakeMonitor(
    options: { bank?: string; dump?: string; labels?: string; rejectRestore?: boolean; disconnect?: boolean } = {},
) {
    const commands: string[] = [];
    const sockets = new Set<Socket>();
    let bank = options.bank ?? "cpu";
    const bytes = Uint8Array.from({ length: 65536 }, (_, i) => i & 0xff);
    const dump = Array.from({ length: 4096 }, (_, row) => {
        const address = row * 16;
        return `>C:${address.toString(16).padStart(4, "0")} ${Array.from(bytes.subarray(address, address + 16), (byte) => byte.toString(16).padStart(2, "0")).join(" ")}`;
    }).join("\n");
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        let pending = "";
        let handshake = true;
        socket.on("data", (chunk) => {
            pending += chunk.toString();
            let newline: number;
            while ((newline = pending.indexOf("\n")) >= 0) {
                const command = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                commands.push(command);
                if (handshake) {
                    handshake = false;
                    socket.write("(C:$1000) \nready\n(C:$1000) ");
                    continue;
                }
                let reply = "";
                if (command === "registers") reply = "ADDR A X Y SP 00 01\n.;1000 00 00 00 ff 2f 37";
                else if (command === "bank C:")
                    reply = `Available banks: ${bank === "cpu" ? "*default *cpu" : "default cpu"} ${bank === "ram" ? "*ram" : "ram"} ${bank === "rom" ? "*rom" : "rom"} io cart`;
                else if (command.startsWith("bank C: ")) {
                    const selected = command.slice(8);
                    if (options.rejectRestore && selected !== "ram") reply = "ERROR -- cannot restore";
                    else bank = selected;
                } else if (command === "mem H C:$0000 C:$ffff") {
                    if (options.disconnect) {
                        socket.destroy();
                        continue;
                    }
                    reply = options.dump ?? dump;
                } else if (command === "show_labels C:") reply = options.labels ?? "";
                else if (command === "exit") continue;
                else reply = "ERROR -- unexpected command";
                socket.write(`${reply}\n(C:$1000) `);
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");
    const client = new MonitorClient({ port: address.port, timeoutMs: 1000 });
    cleanup.push(async () => {
        await client.disconnect();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    return { client, commands, bytes, getBank: () => bank };
}

describe("C64 live RAM capture", () => {
    it("captures all bytes and labels, restores the CPU bank and sends resume", async () => {
        const fake = await fakeMonitor({ labels: "$c000 .entry\nal C:1234 test" });
        const capture = await captureC64Ram(fake.client);
        expect(capture.bytes).toEqual(fake.bytes);
        expect(capture).toMatchObject({
            pc: 0x1000,
            direction: 0x2f,
            port: 0x37,
            banking: { cartridge: "unknown", direction: 0x2f, data: 0x37 },
            labels: [
                { address: 0xc000, name: ".entry" },
                { address: 0x1234, name: "test" },
            ],
        });
        expect(fake.getBank()).toBe("cpu");
        expect(fake.client.connected).toBe(false);
        expect(fake.commands).toContain("bank C: cpu");
    });

    it("preserves an already-selected RAM bank", async () => {
        const fake = await fakeMonitor({ bank: "ram" });
        const capture = await captureC64Ram(fake.client);
        expect(capture.labels).toEqual([]);
        expect(fake.commands.filter((command) => command.startsWith("bank C: "))).toEqual([]);
    });

    it.each([
        ["an incomplete RAM dump", { dump: ">C:0000 00 01" }, "incomplete"],
        ["a malformed RAM dump", { dump: ">C:0001 00" }, "noncontiguous"],
        ["malformed labels", { labels: "not a valid label" }, "Cannot parse VICE C: labels"],
    ])("restores and resumes after %s", async (_name, options, expected) => {
        const fake = await fakeMonitor({ ...options, bank: "rom" });
        await expect(captureC64Ram(fake.client)).rejects.toThrow(expected);
        expect(fake.getBank()).toBe("rom");
        expect(fake.client.connected).toBe(false);
    });

    it("reports failed bank restoration without resuming", async () => {
        const fake = await fakeMonitor({ rejectRestore: true });
        await expect(captureC64Ram(fake.client)).rejects.toThrow("cleanup failed");
        expect(fake.getBank()).toBe("ram");
        expect(fake.client.connected).toBe(true);
        expect(fake.commands).not.toContain("exit");
    });

    it("reports unknown state after disconnection instead of reconnecting", async () => {
        const fake = await fakeMonitor({ disconnect: true });
        await expect(captureC64Ram(fake.client)).rejects.toThrow("execution and monitor bank state are unknown");
        expect(fake.client.connected).toBe(false);
        expect(fake.commands.filter((command) => command === "registers")).toHaveLength(2);
        expect(fake.commands).not.toContain("exit");
    });
});
