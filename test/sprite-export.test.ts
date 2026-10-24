import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Jimp } from "jimp";
import { describe, expect, it, vi } from "vitest";
import { createViceServer } from "../src/server.js";
import { MonitorClient } from "../src/vice/monitor-client.js";
import { parseMemoryDump, renderFontSheet, renderSpriteSheet } from "../src/vice/sprite-export.js";

function dump(address: number, bytes: number[]): string {
    const lines: string[] = [];
    for (let i = 0; i < bytes.length; i += 16) {
        const row = bytes.slice(i, i + 16).map((byte) => byte.toString(16).padStart(2, "0"));
        const groups = [0, 4, 8, 12].map((g) => row.slice(g, g + 4).join(" ")).filter(Boolean);
        lines.push(`>C:${(address + i).toString(16).padStart(4, "0")}  ${groups.join("  ")}      abcdefgh`);
    }
    return lines.join("\n");
}

describe("sprite export", () => {
    it("parses VICE memory dumps including partial lines", () => {
        expect(parseMemoryDump(dump(0x340, [1, 2, 3, 0xab, 0xcd, 0xef, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0xff]))).toEqual([
            1, 2, 3, 0xab, 0xcd, 0xef, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0xff,
        ]);
    });

    it("renders hires and multicolor pixels", () => {
        const data = new Uint8Array(64);
        data[0] = 0x80;
        data[1] = 0b01100000;
        const hires = renderSpriteSheet(data, {
            perRow: 8,
            multicolor: false,
            background: 0,
            foreground: 1,
            multicolor1: 12,
            multicolor2: 15,
            scale: 1,
        });
        expect([hires.width, hires.height]).toEqual([24, 21]);
        expect(hires.getPixelColor(0, 0)).toBe(0xffffffff);
        expect(hires.getPixelColor(1, 0)).toBe(0x000000ff);
        const multi = renderSpriteSheet(data, {
            perRow: 8,
            multicolor: true,
            background: 0,
            foreground: 1,
            multicolor1: 2,
            multicolor2: 5,
            scale: 2,
        });
        expect([multi.width, multi.height]).toEqual([48, 42]);
        expect(multi.getPixelColor(0, 0)).toBe(0xffffffff);
        expect(multi.getPixelColor(4, 0)).toBe(0x000000ff);
        expect(multi.getPixelColor(16, 0)).toBe(0x68372bff);
        expect(multi.getPixelColor(20, 0)).toBe(0xffffffff);
    });

    it("exports a bank via the monitor as png and bin", async () => {
        const monitor = new MonitorClient();
        const ram = new Uint8Array(0x10000);
        ram[0x4000 + 0x40] = 0xff;
        const regs = new Array(0x1e).fill(0);
        regs[0x18 - 0x11] = 0x14;
        regs[0x15 - 0x11] = 0x01;
        const execute = vi.spyOn(monitor, "execute").mockImplementation(async (command) => {
            const match = /^mem H \$([0-9a-f]{4}) \$([0-9a-f]{4})$/.exec(command);
            if (!match) return "";
            const [from, to] = [parseInt(match[1], 16), parseInt(match[2], 16)];
            if (from === 0xdd00) return dump(from, [0x02]);
            if (from === 0xd011) return dump(from, regs);
            return dump(from, [...ram.slice(from, to + 1)]);
        });
        const server = createViceServer(monitor);
        const client = new Client({ name: "test", version: "1" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        await client.connect(a);
        const dir = await mkdtemp(join(tmpdir(), "sprites-"));

        const png = await client.callTool({
            name: "vice_export_sprites",
            arguments: { path: join(dir, "bank.png"), count: 4, perRow: 2 },
        });
        const info = JSON.parse((png.content as Array<{ text: string }>)[0].text);
        expect(info.start).toBe("$4000");
        expect(info.vic.activeBank).toBe(1);
        const image = await Jimp.read(join(dir, "bank.png"));
        expect([image.width, image.height]).toEqual([48, 42]);
        expect(image.getPixelColor(24, 0)).toBe(0xffffffff);

        await client.callTool({
            name: "vice_export_sprites",
            arguments: { path: join(dir, "x.bin"), format: "bin", start: 0x4040, count: 1 },
        });
        expect((await readFile(join(dir, "x.bin"))).length).toBe(64);
        expect(execute).toHaveBeenLastCalledWith("bank default");
        await client.close();
        await server.close();
    });

    it("renders font sheets in hires and multicolor", () => {
        const data = new Uint8Array(16);
        data[0] = 0x80;
        data[8] = 0b11100100;
        const options = {
            perRow: 16,
            multicolor: false,
            background: 0,
            foreground: 1,
            multicolor1: 2,
            multicolor2: 5,
            scale: 1,
        };
        const hires = renderFontSheet(data, options);
        expect([hires.width, hires.height]).toEqual([16, 8]);
        expect(hires.getPixelColor(0, 0)).toBe(0xffffffff);
        expect(hires.getPixelColor(8, 0)).toBe(0xffffffff);
        const multi = renderFontSheet(data, { ...options, multicolor: true });
        expect(multi.getPixelColor(8, 0)).toBe(0xffffffff);
        expect(multi.getPixelColor(10, 0)).toBe(0x588d43ff);
        expect(multi.getPixelColor(12, 0)).toBe(0x68372bff);
        expect(multi.getPixelColor(14, 0)).toBe(0x000000ff);
    });

    it("exports the active font, reading character ROM where the VIC sees it", async () => {
        const monitor = new MonitorClient();
        const regs = new Array(0x1e).fill(0);
        regs[0x18 - 0x11] = 0x14;
        let bank = "default";
        const execute = vi.spyOn(monitor, "execute").mockImplementation(async (command) => {
            if (command.startsWith("bank ")) {
                bank = command.slice(5);
                return "";
            }
            const match = /^mem H \$([0-9a-f]{4}) \$([0-9a-f]{4})$/.exec(command);
            if (!match) return "";
            const [from, to] = [parseInt(match[1], 16), parseInt(match[2], 16)];
            if (from === 0xdd00) return dump(from, [0x03]);
            if (from === 0xd011) return dump(from, regs);
            const fill = bank === "rom" ? 0xff : 0x00;
            return dump(from, new Array(to - from + 1).fill(fill));
        });
        const server = createViceServer(monitor);
        const client = new Client({ name: "test", version: "1" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        await client.connect(a);
        const dir = await mkdtemp(join(tmpdir(), "font-"));

        const result = await client.callTool({ name: "vice_export_font", arguments: { path: join(dir, "f.png") } });
        const info = JSON.parse((result.content as Array<{ text: string }>)[0].text);
        expect(info).toMatchObject({ vicAddress: "$1000", characters: 256, charRomUsed: true });
        const image = await Jimp.read(join(dir, "f.png"));
        expect([image.width, image.height]).toEqual([128, 128]);
        expect(image.getPixelColor(0, 0)).toBe(0xffffffff);

        const whole = await client.callTool({
            name: "vice_export_font",
            arguments: { path: join(dir, "b.bin"), format: "bin", scope: "bank" },
        });
        expect(JSON.parse((whole.content as Array<{ text: string }>)[0].text).characters).toBe(2048);
        const bin = await readFile(join(dir, "b.bin"));
        expect(bin.length).toBe(0x4000);
        expect(bin[0]).toBe(0);
        expect(bin[0x1000]).toBe(0xff);
        expect(bin[0x2000]).toBe(0);
        expect(execute).toHaveBeenLastCalledWith("bank default");
        await client.close();
        await server.close();
    });
});
