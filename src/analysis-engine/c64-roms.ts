import { createHash } from "node:crypto";

export type C64RomKind = "basic" | "kernal";

export interface C64RomFingerprint {
    readonly kind: C64RomKind;
    readonly name: string;
    readonly partNumber: string;
    readonly length: number;
    readonly sha1: string;
    readonly source: string;
}

const source =
    "https://github.com/mamedev/mame/blob/7ffae3686de8d00cbb829fa953eeda29ad45f944/src/mame/commodore/c64.cpp";
const fingerprints: readonly C64RomFingerprint[] = [
    {
        kind: "basic",
        name: "C64 BASIC V2",
        partNumber: "901226-01",
        length: 0x2000,
        sha1: "79015323128650c742a3694c9429aa91f355905e",
        source,
    },
    {
        kind: "kernal",
        name: "C64 KERNAL revision 1",
        partNumber: "901227-01",
        length: 0x2000,
        sha1: "87cc04d61fc748b82df09856847bb5c2754a2033",
        source,
    },
    {
        kind: "kernal",
        name: "C64 KERNAL revision 2",
        partNumber: "901227-02",
        length: 0x2000,
        sha1: "0e2e4ee3f2d41f00bed72f9ab588b83e306fdb13",
        source,
    },
    {
        kind: "kernal",
        name: "C64 KERNAL revision 3",
        partNumber: "901227-03",
        length: 0x2000,
        sha1: "1d503e56df85a62fee696e7618dc5b4e781df1bb",
        source,
    },
];

function checkKind(kind: C64RomKind): void {
    if (kind !== "basic" && kind !== "kernal") {
        throw new Error("ROM kind must be 'basic' or 'kernal'.");
    }
}

export type C64RomIdentification =
    | { readonly status: "recognized"; readonly sha1: string; readonly fingerprint: C64RomFingerprint }
    | { readonly status: "unknown"; readonly sha1: string };

export class C64Roms {
    static get all(): readonly C64RomFingerprint[] {
        return fingerprints;
    }

    static getBySha1(kind: C64RomKind, sha1: string): C64RomFingerprint | undefined {
        checkKind(kind);
        if (!/^[0-9a-f]{40}$/i.test(sha1)) {
            throw new RangeError("ROM SHA-1 must contain 40 hexadecimal digits.");
        }
        return fingerprints.find((entry) => entry.kind === kind && entry.sha1 === sha1.toLowerCase());
    }

    static identify(kind: C64RomKind, bytes: Uint8Array): C64RomIdentification {
        checkKind(kind);
        if (bytes.length !== 0x2000) {
            throw new RangeError("C64 BASIC and KERNAL ROM images must be 8192 bytes.");
        }
        const sha1 = createHash("sha1").update(bytes).digest("hex");
        const fingerprint = C64Roms.getBySha1(kind, sha1);
        return fingerprint ? { status: "recognized", sha1, fingerprint } : { status: "unknown", sha1 };
    }
}
