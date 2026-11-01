import { parseC64BasicProgram, type C64BasicLine } from "./c64-basic-program.js";
import { C6510Decoder, type C6510DecoderOptions } from "./c6510-decoder.js";

/**
 * A PRG's first two bytes are the little-endian load address, not executable data.
 */
export class C64Prg {
    readonly decoder: C6510Decoder;

    private constructor(bytes: Uint8Array, loadAddress: number, options?: C6510DecoderOptions) {
        this.decoder = new C6510Decoder(bytes, loadAddress, options);
    }

    static fromBytes(fileBytes: Uint8Array, options?: C6510DecoderOptions): C64Prg {
        if (fileBytes.length < 2) {
            throw new Error("PRG file is missing its two-byte load address.");
        }
        const loadAddress = fileBytes[0] | (fileBytes[1] << 8);
        return new C64Prg(fileBytes.subarray(2), loadAddress, options);
    }

    get loadAddress(): number {
        return this.decoder.startAddress;
    }

    get endAddressExclusive(): number {
        return this.decoder.endAddressExclusive;
    }

    get byteLength(): number {
        return this.decoder.byteLength;
    }

    parseBasicProgram(): readonly C64BasicLine[] {
        return parseC64BasicProgram(this.decoder.getBytes(), this.loadAddress);
    }
}
