import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MonitorClient } from "../src/vice/monitor-client.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function monitor(onCommand: (command: string, socket: Socket) => void, timeoutMs = 500) {
    const sockets = new Set<Socket>();
    const commands: string[] = [];
    const server = createServer((socket) => {
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
                } else {
                    onCommand(command, socket);
                }
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");
    const client = new MonitorClient({ port: address.port, timeoutMs });
    cleanup.push(async () => {
        await client.disconnect();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    return { client, commands };
}

describe("MonitorClient", () => {
    it("consumes the greeting and assembles fragmented replies and drive prompts", async () => {
        const { client } = await monitor((_command, socket) => {
            socket.write("first\r\nsecond\r\n(8:$");
            setImmediate(() => socket.write("1234) "));
        });
        expect(await client.execute("registers")).toBe("first\r\nsecond");
        expect(client.connected).toBe(true);
    });

    it("serializes concurrent commands and accepts empty replies", async () => {
        const { client, commands } = await monitor((command, socket) => {
            setImmediate(() => socket.write(`${command === "step" ? "" : `${command}\n`}(C:$1234) `));
        });
        expect(await Promise.all([client.execute("step"), client.execute("registers")])).toEqual(["", "registers"]);
        expect(commands).toEqual(["registers", "step", "registers"]);
    });

    it("keeps consecutive reads aligned without sending extra lines", async () => {
        const { client, commands } = await monitor((command, socket) => {
            socket.write(`${command}\n(C:$1234) `);
        });
        for (const command of ["registers", "screen", "d $f13e $f15d", "registers"]) {
            expect(await client.execute(command)).toBe(command);
        }
        expect(commands).toEqual(["registers", "registers", "screen", "d $f13e $f15d", "registers"]);
    });

    it("invalidates timed-out sessions and reconnects for the next request", async () => {
        const { client } = await monitor((command, socket) => {
            if (command !== "stall") socket.write("recovered\n(C:$1234) ");
        }, 100);
        await expect(client.execute("stall")).rejects.toThrow("timed out");
        expect(client.connected).toBe(false);
        expect(await client.execute("registers")).toBe("recovered");
    });

    it("rejects a closed connection and recovers", async () => {
        const { client } = await monitor((command, socket) => {
            if (command === "close") socket.destroy();
            else socket.write("ok\n(C:$1234) ");
        });
        await expect(client.execute("close")).rejects.toThrow("closed");
        expect(await client.execute("registers")).toBe("ok");
    });

    it("resumes without waiting for a prompt and closes the session", async () => {
        const { client } = await monitor(() => undefined);
        await client.resume();
        expect(client.connected).toBe(false);
        await client.connect();
        expect(client.connected).toBe(true);
    });

    it("rejects multi-line commands and invalid settings", async () => {
        const client = new MonitorClient();
        await expect(client.execute("registers\nquit")).rejects.toThrow("one nonempty");
        expect(() => new MonitorClient({ port: 0 })).toThrow("port");
        expect(() => new MonitorClient({ timeoutMs: NaN })).toThrow("timeout");
    });

    it("sends non-prompt-returning commands and reconnects", async () => {
        const { client, commands } = await monitor((_command, socket) => socket.end());
        await client.send("goto C:$1000");
        expect(client.connected).toBe(false);
        await client.connect();
        expect(commands).toEqual(["registers", "goto C:$1000", "registers"]);
        expect(client.connected).toBe(true);
        await expect(client.send("exit\nquit")).rejects.toThrow("one nonempty");
    });

    it("terminates interactive assembly before executing the next queued command", async () => {
        const { client, commands } = await monitor((command, socket) => {
            if (command.startsWith("a ")) socket.write(".C:1001  ");
            else if (command === "") socket.write("\n(C:$1001) ");
            else socket.write("register data\n(C:$1001) ");
        });
        const [assembled, registers] = await Promise.all([
            client.assemble("a C:$1000 NOP"),
            client.execute("registers"),
        ]);
        expect(assembled).toContain(".C:1001");
        expect(registers).toBe("register data");
        expect(commands).toEqual(["registers", "a C:$1000 NOP", "", "registers"]);
        await expect(client.assemble("a $1000 NOP\nquit")).rejects.toThrow("single-line");
    });

    it("does not send an empty command after an assembly syntax error", async () => {
        const { client, commands } = await monitor((command, socket) => {
            if (command.startsWith("a ")) socket.write("ERROR -- Invalid instruction\n(C:$1000) ");
            else socket.write("register data\n(C:$1000) ");
        });
        expect(await client.assemble("a C:$1000 INVALID")).toContain("ERROR");
        expect(await client.execute("registers")).toBe("register data");
        expect(commands).toEqual(["registers", "a C:$1000 INVALID", "registers"]);
    });

    it("bounds reply size", async () => {
        const { client } = await monitor((_command, socket) => socket.write("a".repeat(1024 * 1024 + 1)));
        await expect(client.execute("registers")).rejects.toThrow("1 MiB");
    });
});
