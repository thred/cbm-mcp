# Intelligent C64 Disassembly and Program Analysis

Status: **decoder, static control-flow graph, mapping-aware C64 annotations,
persistent analysis state, reference catalogs, live C64 RAM capture and MCP queries available**.
Later phases below are
illustrative and may change.

## Goal

Let an agent understand a program running in VICE by capturing all or part of
C64 memory and building a searchable, annotated representation. Deterministic
code should decode instructions, analyze control flow, connect references and
attach documented C64 knowledge. The agent can then investigate the evidence
and explain the program without receiving the entire memory image in its
context.

The goal is useful answers with explicit evidence and honest coverage gaps,
not a claim that every byte in memory can be unambiguously classified.

## Existing Building Blocks

- [`vice_memory` and `vice_disassemble`](../src/vice/monitor-tools.ts) operate
  on ranges of up to 256 bytes. VICE's linear disassembly does not distinguish
  code from data or construct cross-references.
- [`MonitorClient`](../src/vice/monitor-client.ts) communicates with the VICE
  text monitor and serializes individual commands.
- [`OpCodes`](../src/analysis-engine/c64-opcodes.ts) catalogs all 256 NMOS
  6502/6510 encodings, including 105 unofficial encodings, using
  [6502.org's opcode reference](https://6502.org/tutorials/6502opcodes.html).
  [Oxyron's unofficial-opcode reference](https://www.oxyron.de/html/opcodes02.html)
  and [NESdev's unofficial-opcode overview](https://www.nesdev.org/wiki/CPU_unofficial_opcodes).
  Unofficial encodings are marked `illegal`; unstable ones are flagged and
  their exact behavior depends on the processor. `KIL` has `cycles: null`
  because it halts until reset. Base cycles
  exclude conditional penalties; for branches the page-crossing penalty applies
  only when the branch is taken. `BRK` sets interrupt disable and has no
  persistent break flag. Each documented encoding also has structured register
  and status-flag inputs, operand access, pointer reads, control flow and stack
  effects, based on the [6502 instruction reference](https://www.nesdev.org/obelisk-6502-guide/reference.html)
  and [addressing-mode reference](https://www.nesdev.org/wiki/CPU_addressing_modes).
  These are instruction-level effects, not a complete bus-cycle trace: opcode
  and operand fetches and dummy reads are not enumerated. Memory
  read-modify-write instructions write the old value and then the new value.
  Zero-page indirect pointers wrap within zero page, while `JMP ($xxff)` fetches
  its high byte from `$xx00`. Branch offsets are signed and relative to the next
  instruction. `JSR` pushes the address of its final operand byte, `RTS`
  increments the pulled address, and `BRK` pushes opcode address + 2. BRK's
  listed vector is its normal IRQ/BRK vector; an NMI can
  [hijack interrupt vector selection](https://www.nesdev.org/wiki/Visual6502wiki/6502_Interrupt_Hijacking).
- [`C6510Decoder`](../src/analysis-engine/c6510-decoder.ts) decodes a copied,
  contiguous memory range using that catalog, and [`C64Prg`](../src/analysis-engine/c64-prg.ts)
  loads PRG bytes, separating the little-endian load address from the payload.
  Decoded instructions expose raw bytes, address, opcode metadata, addressing
  mode and a structured operand; formatting is available separately. Indexed
  addresses and indirect pointers remain unresolved, and relative branch
  targets use signed offsets with 16-bit wrapping. Linear scans are
  speculative, stop at a halt or truncated instruction. A requested range cannot
  read instruction bytes outside its boundary. PRG payloads that overflow the
  16-bit address space are rejected rather than wrapped. Neither decoding nor
  a PRG's load address proves that bytes are code or that ROM and I/O would be
  visible at runtime.
- [`buildC64ControlFlowGraph`](../src/analysis-engine/c64-control-flow.ts)
  discovers candidate instructions and blocks from supplied entry points,
  follows direct branches and calls, and records static control-flow and
  memory references. [`C64AnalysisState`](../src/analysis-engine/c64-analysis-state.ts)
  retains snapshots, user entries, exclusions and annotations and reconciles
  annotations against later analyses as described below.
- [`C64KernalFunctions`](../src/analysis-engine/c64-kernal-functions.ts)
  catalogs the 39 standard C64 KERNAL jump-table entries, their calling
  information and standard-ROM implementation addresses. The entries are
  candidates only when the KERNAL is mapped and compatible; vectors can be
  changed, and the listed used registers are not a complete preservation
  guarantee. LOAD and SAVE have separate ROM entry and default vector-target
  addresses. The main reference is
  [STA's KERNAL function list](https://sta.c64.org/cbm64krnfunc.html);
  its PLOT row/column assignments are corrected using
  [C64-Wiki](https://www.c64-wiki.com/wiki/PLOT).
- [`C64BasicRom`](../src/analysis-engine/c64-basic-rom.ts) catalogs the
  BASIC V2 interpreter's documented routine entry points, vectors and data
  locations, including interpreter routines in KERNAL ROM. English summaries
  are based on the German [BASIC-ROM reference](https://www.c64-wiki.de/wiki/BASIC-ROM).
  They apply to the standard ROMs, not necessarily patched or replacement ROMs,
  and unknown routine lengths or calling conventions are not inferred.
  The reference's `$bfde` EXP coefficient has a different exponent from
  the value documented in the [C64 ROM disassembly](https://www.pagetable.com/c64ref/c64disasm/).
- [`C64BasicTokens` and `parseC64BasicProgram`](../src/analysis-engine/c64-basic-program.ts)
  provide the 76 BASIC V2 keyword/operator tokens and parse complete,
  contiguous, relocated linked-line programs. The caller must supply the
  actual memory address and include the two-byte end marker. The parser
  preserves line bytes and finds candidate `SYS` tokens outside quoted strings,
  `DATA` and `REM`. Only simple in-range decimal literals are resolved;
  expressions remain unresolved and occurrences are not proof of execution.
  Unknown expansion tokens are not interpreted. The reference is
  [C64-Wiki's token table](https://www.c64-wiki.com/index.php?title=BASIC_token&oldid=45685)
  and [SYS description](https://www.c64-wiki.com/wiki/SYS). BASIC extensions or
  modified interpreter behavior require separate analysis.
- [`C64Roms`](../src/analysis-engine/c64-roms.ts) identifies complete 8 KiB
  standard BASIC V2 and KERNAL revision 1–3 images by SHA-1 against
  [MAME's pinned ROM catalog](https://github.com/mamedev/mame/blob/7ffae3686de8d00cbb829fa953eeda29ad45f944/src/mame/commodore/c64.cpp).
  Unknown hashes remain unknown; recognition is not a guarantee of
  compatibility with every internal label. Hash the actual ROM view, not
  whatever RAM or cartridge happens to be CPU-visible. Identification is not
  yet connected to snapshot capture or annotation.
- [`C64MemoryMap`](../src/analysis-engine/c64-memory-map.ts) provides
  address, range, text and bit queries over structured C64 memory-map
  descriptions, with separate views, register mirrors and links to KERNAL functions. Its
  entries describe possible and conventional uses, not the current mapping or
  actual program ownership. The catalog summarizes
  [STA's C64 memory map](https://sta.c64.org/cbm64mem.html). `at` exposes
  `bitFields` on matching entries, `bitsAt` filters fields by address, bit,
  view and read/write access, and `search` includes field names and values.
  Masks are byte-relative and field values are unshifted. An `unspecified`
  access is not a guarantee of read or write behavior; context-dependent
  meanings remain separate. The catalog does not yet encode every source
  detail, and is not connected to live capture. Static system
  annotations link back to the matching entries, including their bitfields.
  A field's optional `source` overrides the entry's source. In particular,
  the CIA timer output-mode bit corrects the STA description using
  [MAME's CIA implementation](https://github.com/mamedev/mame/blob/7ffae3686de8d00cbb829fa953eeda29ad45f944/src/devices/machine/mos6526.cpp).
- [`C64Colors`](../src/analysis-engine/c64-colors.ts) provides the 16 VIC-II
  color codes and names from [STA's color list](https://sta.c64.org/cbm64col.html).
  These are indexes, not fixed RGB values. The graphics exporter separately
  uses a Pepto palette for rendering.
- The project has reference material on
  [C64 memory and banking](../.agents/skills/cbm-mcp/references/c64-memory-map.md),
  [6510 assembly](../.agents/skills/cbm-mcp/references/6510-assembly.md) and
  [VIC-II graphics](../.agents/skills/cbm-mcp/references/vic2.md). An analyzer
  will need structured, more complete reference data.

### Reference Provenance and Licensing

The BASIC ROM catalog records its wiki source revision and broad ROM
assumption; the BASIC token table records its source revision and dialect.
Instruction-effect metadata records its sources and CPU family, and ROM
fingerprints cite a pinned MAME revision. Other catalogs still lack consistent
per-fact revisions and precise ROM-revision applicability; the `$bfde`
correction, for example, has an additional source as noted above.

The English and German C64-Wiki pages inspected for the token and BASIC ROM
catalogs state that content is available under the GNU Free Documentation
License unless otherwise noted. MAME marks its C64 driver BSD-3-Clause; no ROM
images are included here. The STA memory-map page did not expose a license
notice in the inspected page. Catalog entries include existing English
summaries and translations, not just mechanically extracted facts: their
redistribution and attribution requirements have **not** been legally
verified. Review the applicable source licenses and the bundled text before
redistribution; do not assume the project's MIT license resolves those terms.

### PRG Analysis CLI

From a source checkout with dependencies installed:

```sh
npx tsx src/analyze-cli.ts path/to/program.prg
```

The command defaults to literal BASIC V2 `SYS` targets. Complete BASIC-only
programs can be listed without a machine-code entry point, including when a
literal `SYS` target is outside the capture; such targets are reported in the
diagnostics. If the PRG does not start with BASIC, supply one or more entry
points instead:

```sh
npx tsx src/analyze-cli.ts --entry 0xc000 --entry 0xc100 path/to/program.prg
```

Addresses may be decimal, `0x`-prefixed hexadecimal, or quoted `$`-prefixed
hexadecimal. Add `--basic` to combine explicit entries with BASIC `SYS`
targets. Add `--details` to include full system annotation descriptions,
conditions and source metadata. Unresolved expressions are reported on stderr. Run with `--help` for
usage. After building, `node dist/analyze-cli.js` runs the same command; an
installed package exposes `cbm-analyze`. Unofficial opcodes are disabled by
default; use `--illegal-opcodes` to opt in.

The listing interleaves BASIC V2 candidates, symbolic candidate instructions
and `.byte` blocks for captured bytes outside unambiguous code in address
order, followed by label definitions and diagnostics.
Addresses appear in block comments and address definitions rather than byte
and address columns on every instruction. It is a readable disassembly, not
reassemblable source: mixed code/data bytes may appear in both forms, and the
graph may contain overlapping candidates. The CLI assumes the standard no-cartridge
startup mapping at each entry point (DDR `$2f`, port latch `$37`); it is not a
measurement, and the program may have changed banking before an entry is
reached. ROM names require compatible ROMs. A successful command can still produce a partial graph: check
the diagnostics and unresolved targets. The CLI does not connect to VICE or
save analysis state.

### Decoding a PRG

The package exports the decoder as a TypeScript/JavaScript API. For a PRG
known to start with a tokenized BASIC program, a literal `SYS` is one possible
entry point:

```ts
import { readFile } from "node:fs/promises";
import { C64Prg, formatC6510Instruction } from "cbm-mcp";

const prg = C64Prg.fromBytes(await readFile("program.prg"));
const sys = prg
    .parseBasicProgram()
    .flatMap((line) => line.sysReferences)
    .find((reference) => reference.resolution === "literal");
const entry = sys?.target;
if (entry === undefined || entry < prg.loadAddress || entry >= prg.endAddressExclusive) {
    throw new Error("No literal SYS entry point within the PRG.");
}

for (const result of prg.decoder.decodeRange(entry, Math.min(256, prg.endAddressExclusive - entry))) {
    if (result.kind === "instruction") {
        console.log(result.address.toString(16), formatC6510Instruction(result));
    } else {
        console.log(result); // Undocumented opcode or truncated instruction.
    }
}
```

Calling `parseBasicProgram()` directly is opt-in: a PRG may contain machine
code or data rather than BASIC at its load address, and a `SYS` occurrence is
a candidate, not proof that execution reaches it. For a different known entry point, call
`prg.decoder.decodeAt(address)` or `decodeRange(address, length)` directly.
The decoder itself is linear; use the graph builder below for discovery.
To enable unofficial instructions, pass `{ includeIllegalOpcodes: true }` as
the second argument to `C64Prg.fromBytes`, or as the third argument to
`C6510Decoder`.

### Analyzing and Saving a PRG

```ts
import { readFile } from "node:fs/promises";
import { C64AnalysisState, C64Prg, C64_PRG_DEFAULT_BANKING, type C64EntryPoint } from "cbm-mcp";

const prg = C64Prg.fromBytes(await readFile("program.prg"));
const entries: C64EntryPoint[] = [];
for (const line of prg.parseBasicProgram()) {
    for (const reference of line.sysReferences) {
        if (reference.resolution === "literal" && reference.target !== undefined) {
            entries.push({ address: reference.target, source: "basic-sys" });
        }
    }
}
if (entries.length === 0) throw new Error("No literal BASIC SYS entry point");

// Choose identifiers that consistently describe this program and memory view.
const state = new C64AnalysisState("my-program");
const graph = state.analyze(prg.decoder, "prg-ram", entries, C64_PRG_DEFAULT_BANKING);
console.log(graph.blocks, graph.callsTo(0xffd2));
console.log(graph.referencesTo(0xd020), graph.unresolvedReferences());
console.log(graph.memoryRegions, graph.memoryRegionAt(0x2000));
console.log(graph.systemAnnotationsTo(0xd020));
console.log(graph.possibleViewsAt(entries[0].address, 0xffd2, "read"));
console.log(graph.diagnostics);
console.log(graph.toString());

// Labels are scoped to this program and view. Choose "code" for a discovered
// instruction whose label should be reconciled against later captures.
const label = state.addLabel(graph, entries[0].address, "startup", "code");
state.addLabel(graph, 0x2000, "counter"); // A fixed address/data label.
console.log(graph.labelsAt(entries[0].address), state.matchLabels(graph));
state.renameLabel(label.id, "main");

state.addAnnotation(graph, "entry", entries[0].address, "Startup", "Candidate startup routine");
await state.save("my-program.analysis.json");

// Later, restore the latest captured bytes and user information:
const restored = await C64AnalysisState.load("my-program.analysis.json");
const restoredGraph = restored.restoreGraph("prg-ram");
console.log(restored.matchAnnotations(restoredGraph));

// To compare a later PRG or memory capture, call restored.analyze(...) with
// the new decoder and the same view ID, then matchAnnotations(newGraph).
```

For a listing with user annotations, pass
`restored.matchAnnotations(restoredGraph)` as the `annotations` option to
`formatC64ControlFlowGraph(restoredGraph, { annotations })`.
The default formatter uses automatic symbolic labels; pass
`{ systemAnnotationDetails: true }` to include system annotation descriptions,
conditions and sources. Original instruction bytes, references and structured
`graph.systemAnnotations` remain available from the graph.

### Code and Data Candidates

The graph also tries to recognize a complete, nonempty linked BASIC V2 program
at the capture start and, when present in the capture, at `$0801`.
`graph.basicPrograms` exposes these candidates, including their line addresses,
tokens and `SYS` references. Recognition checks line pointers, terminators
and ascending line numbers, but does not prove that the bytes are BASIC or
that a line executes. A relocated program elsewhere in a larger capture
requires an appropriately bounded capture. BASIC candidates are rebuilt from
saved bytes rather than stored separately.

The listing renders BASIC tokens as keywords and retains literal text within
quotes, `DATA` and `REM`. PETSCII control codes and characters whose display
depends on the character set are represented as `{$xx}` byte escapes. These
are display notation, not reassemblable BASIC syntax. When BASIC overlaps
discovered machine instructions, the listing preserves both interpretations
and keeps the relevant raw byte blocks. Raw captured bytes remain accessible
through `graph.memoryRegions` in all cases.

`graph.memoryRegions` partitions the complete captured byte range into
half-open `[start, endExclusive)` regions with `bytes`, `kind` and `evidence`.
`graph.memoryRegionAt(address)` returns the region containing an address, or
`undefined` outside the capture. Kinds are `code`, `likely-data`, `mixed`
and `unknown`. A `mixed` region has competing instruction and data evidence,
including possible self-modification. The evidence includes decoded
instructions, control-flow targets, direct reads and writes, indexed operand
bases and user exclusions.
`graph.referencesTo(address)` provides the underlying reference details.

Discovery follows entry points, fallthroughs, branches, direct jumps and
calls rather than sweeping all bytes as instructions. By default, unofficial
opcodes produce an `undocumented-opcode` diagnostic, and preceding straight-line
candidates may be rejected as likely data. With unofficial decoding enabled,
`KIL` ends a path with a halt edge. All bytes then have an NMOS opcode
interpretation, so more data may be mistaken for code; unstable instructions
and their unresolved targets remain uncertain. An explicit entry or control-flow
target is evidence, not proof, even when it conflicts with likely-data evidence.
Truncated instructions are reported separately.

Memory accesses are also evidence, not proof of data ownership or a physical
bank. A direct access marks its exact address, and an indexed access marks
only its base as a possible data location: the runtime index and extent are
unknown. Indirect accesses retain their unresolved references. Unreached
bytes stay unknown rather than being assumed to be data; this includes code
only reachable through unresolved indirect transfers or interrupts.
The listing emits these bytes with `.byte` directives, not inferred strings,
sprites or fonts. Classifications are rebuilt from saved capture bytes,
entry points and corrections; automatic results are not persistent user
annotations.

Entry points can also be supplied explicitly, for example
`[{ address: 0xc000, source: "user" }]`. `addEntryPoint` and
`removeEntryPoint` persist user-selected entry points. `excludeRange` marks
captured bytes as data/not-code; its byte evidence must still match for the
correction to remain active. `correctionStatuses` exposes stale corrections.
Changing entry points or exclusions invalidates the current graph: call
`restoreGraph(viewId)` to rebuild it. Annotations can be edited, removed or
explicitly reassigned with `updateAnnotation`, `removeAnnotation` and
`reattachAnnotation`.

The versioned JSON state stores the latest captured bytes, entry points and
optional initial banking evidence per view, plus labels, annotations and
corrections. Version 5 also stores the unofficial-opcode policy per view;
versions 1–4 load with it disabled. Version 4 stores capture metadata and typed
data sections. Version 3 files include labels; versions 1 and 2 load without labels, and
version 1 also loads with unknown banking. Older readers reject unsupported
versions rather than silently discarding information. The file may contain the
program's memory and user notes. There is no automatic persistence, file locking
or snapshot history; callers must coordinate concurrent saves.

The caller assigns `programId` and `viewId`: they are identity assertions,
not fingerprints. Reuse an ID only for the same program and genuinely
comparable memory view. In particular, future monitor integrations must
distinguish banks, devices and relevant mapping context; a generic
CPU-visible view is not sufficient if its mapping changes.

### User and VICE Labels

`addLabel(graph, address, name, kind?)`, `renameLabel`, `reattachLabel` and
`removeLabel` manage persistent labels. The default `address` kind stays at
the chosen 16-bit address, including outside the capture, even when memory
contents change. Choose `code` for a discovered instruction, including one in
the middle of a block. Its anchor covers the remainder of that candidate basic
block. It uses the same conservative matching thresholds as block
annotations: exact same-address matches are applied; modified or uniquely
relocated matches require review; ambiguous, substantially changed or missing
code becomes orphaned. Use `reattachLabel(id, graph, address)` to explicitly
accept or move a code label. It can also change the kind with an optional
fourth argument. Short code signatures cannot be relocated automatically.
These are static candidates and do not account for self-modifying instructions
or changes outside the anchored block.

Labels are unique by name within a view; multiple names may refer to one
address. Names are case-sensitive identifiers of up to 128 characters and may
begin with a dot, as in VICE. `listLabels(viewId?)`, `matchLabels(graph)`,
`graph.labelMatches` and `graph.labelsAt(address)` expose the stored labels and
their match statuses. `graph.automaticLabels`, `automaticLabelsAt(address)` and
`resolveLabel(instructionAddress, targetAddress)` expose generated names and
per-instruction resolution. Automatic labels are rebuilt from the graph and
current confirmed labels, rather than saved as user knowledge. Add a user
label at an address to override its generated name. Generated names avoid
collisions with user and VICE labels, including labels awaiting review.

The listing defines generated code labels, uses labels for direct operands,
branch targets and indirect pointer locations, and defines external/data
addresses separately. Indexed and indirect destinations remain unresolved.
KERNAL, BASIC and I/O names are derived from reference data only when the
modeled mapping establishes the corresponding view; ROM names still require
compatible ROM contents. Otherwise neutral address-based labels are used.
Zero-page memory operands use neutral `zb_nn` labels because programs often
reuse BASIC and KERNAL workspace. Direct 6510 processor-port accesses at
`$00` and `$01` retain their specific names. Conventional workspace meanings
remain available in system annotations and the memory-map catalog, not in
the default label. `vector_maybe_*` names describe conventional uses only;
custom programs may reuse those addresses. Hardware vector labels identify an
address and view, not its contents or the mapping at interrupt time. Names
may differ for reads and writes to the same
CPU address when their mapped views differ. Local names take precedence over
imported VICE aliases; remaining ties are alphabetical. Labels are logical address aliases within the
named analysis view, **not proof** that the corresponding RAM, ROM, I/O or
cartridge bank is CPU-visible. Check the graph's mapping evidence before
interpreting a labeled access.

The live monitor capture imports labels using
`state.importViceLabels(graph, [{ address: 0x1000, name: ".start" }])`.
This replaces that view's previously imported VICE labels, keeps user labels,
and returns imported and removed counts plus conflicts with user-owned names.
Repeated imports preserve unchanged labels and their code anchors. Imports
default to address labels; a caller can request `kind: "code"` for a discovered
instruction. Renaming or reattaching an imported label makes it user-owned, so
it is retained across imports. Since edits are local, a later import can
reintroduce the old VICE name as an alias. This state API itself does not connect
to VICE or write labels back to the monitor.

### Mapping-Aware System Annotations

`graph.systemAnnotations`, `systemAnnotationsFrom(address)` and
`systemAnnotationsTo(address)` provide generated, queryable candidates
separately from persistent user annotations. Each includes its source,
reference version and source revision when known, address, access, memory view,
certainty and any conditions. Memory-map annotations include the catalog entry
and its bitfields; ROM annotations link to their BASIC or KERNAL catalog entry.
Missing source revisions are not invented. `mapped` means
the view follows from the supplied assumptions on all modeled paths, not that
execution, mapping or hardware was observed; `conditional` identifies unresolved
mapping, ROM compatibility or other conditions. Workspace and software-vector
labels are `conventional`: custom programs may reuse these RAM addresses and
change vector contents even when ROM is enabled.

For generic graphs and snapshots, banking defaults to unknown. Supply a
`C64BankingContext` with `cartridge: "none"` only when a standard,
no-cartridge configuration is justified; `direction`, `data` (the port
**output latch**, not merely the value read from `$0001`) and `inputPins` are
optional 8-bit values. Unknown input pins remain unknown when DDR bits are
inputs. Use `cartridge: "unknown"` for an unverified cartridge configuration;
the resulting possible views include cartridge mappings and Ultimax unmapped
areas. Other expansion behavior is not modeled exactly. A live capture must
provide separately obtained evidence and distinguish CPU-visible bytes from
underlying RAM. In particular, reading `$0001` alone cannot establish the latch
for input-configured bits.

The analysis propagates low port bits and simple immediate loads, transfers,
port reads and bitwise operations along candidate branches. It merges
conflicting paths and loses precision for unmodeled register operations,
indexed or indirect writes that could reach the port, and calls returning from
potentially bank-changing code. Each supplied entry is seeded independently.
The analysis assumes captured instructions and stable external inputs remain
valid on a modeled path; it does not model asynchronous interrupt handlers,
self-modified instruction bytes, arbitrary expansions or subroutine summaries.
Recapture and supply appropriate context when these assumptions do not hold.
Graph discovery is not bank-aware: a captured RAM instruction at a ROM-covered
address is still a static candidate, and `targetCaptured` says only that bytes
were captured, not that those bytes are CPU-visible. Consult
`possibleViewsAt(instructionAddress, targetAddress, "read" | "write")`, which
can also return `unmapped`, and verify the actual view before interpreting it.

Direct ROM call and data annotations are omitted when that ROM is definitely
hidden, and otherwise remain conditional on a compatible ROM. Writes beneath
ROM are distinguished from writes to mapped I/O; no ROM write is inferred.
Hardware vector annotations distinguish the mapped read view from underlying
RAM writes and do not claim current vector contents. BRK's usual IRQ/BRK vector
and the possibility of NMI hijacking are annotated separately. Indexed and
indirect operand destinations remain unresolved; the analysis does not infer
their hardware or ROM labels. The standalone `c64PossibleMemoryViews` helper
resolves a supplied context without a graph.

#### Evidence and Reconciliation

- Every discovered instruction and edge is a **static candidate**, not proof
  of execution. Branch paths and call returns are possible, not guaranteed.
  External targets are retained with `targetCaptured: false`; indirect jumps
  and indirect operand accesses remain unresolved.
- A direct memory reference names a CPU address, not a confirmed physical
  bank or I/O register. Indexed references describe the possible 256-byte
  range, including zero-page or 16-bit wrapping. `referencesTo` returns both
  direct and possible indexed matches; `unresolvedReferences` returns indirect
  accesses that cannot be matched to an address. Pointer-byte reads are
  separate references, including the NMOS indirect-JMP page wrap.
  Stack accesses, interrupt vector reads, instruction fetches and dummy bus
  reads are not modeled as memory references.
- Unsupported/truncated instructions and overlapping instruction
  interpretations are reported in diagnostics. Unreachable bytes are not
  classified. Self-modifying code, runtime branches, bank switching, indirect
  transfers and non-returning calls can invalidate or limit static discovery.
- A block annotation is anchored to its discovered instructions. An entry
  annotation is anchored to the candidate reachable blocks, excluding direct
  callees and stopping at other entry points; this is not a proven routine
  boundary. Original bytes, address, view and snapshot ID are retained.
- Same-address identical signatures are `unchanged`. For same-address changes,
  a match requires at least four instructions, an ordered opcode similarity of
  at least 80% and exact-instruction similarity of at least 60%. Up to 256
  instructions, similarity uses a longest-common-subsequence comparison;
  larger signatures use a conservative position-aligned comparison. A unique
  byte-identical relocation requires at least four
  instructions and eight bytes. Modified or relocated matches need review;
  unchanged bytes also do not guarantee unchanged runtime behavior.
- Ambiguous, substantially changed, missing or too-small-to-relocate
  annotations become `orphaned`, not deleted. An annotation in another view
  is `other-view`. Matches are always compared with their original anchor to
  avoid gradually drifting across unrelated code; explicitly reattach to
  accept a new anchor. Generated graph facts are rebuilt from the new capture,
  rather than carried over as authoritative facts.

## Architecture

```text
VICE monitor
    |
    v
Snapshot acquisition
    |   bytes + registers + memory views + machine metadata
    v
6510 decoder + control-flow discovery
    |
    v
C64-specific enrichment
    |   KERNAL/BASIC, I/O registers, vectors, graphics, patterns
    v
In-memory analysis graph
    |
    v
Bounded MCP queries -> agent reasoning and explanation
```

### 1. Capture a Consistent Snapshot

The implemented live capture reads all underlying C64 RAM, registers and
monitor labels while VICE is paused. The following broader capture capabilities
remain possible future extensions:

- CPU registers and the current program counter.
- Machine and CPU type, capture time, selected address space and bank.
- CPU-visible bytes and, optionally, underlying RAM and relevant ROM views.
- Relevant banking and VIC-II state, with explicit indications of what could
  not safely be read.
- User-supplied entry points, labels and known regions.

Banking is part of the identity of an address. For example, `$a000` can refer
to BASIC ROM or RAM, and a write under visible ROM can target RAM. The VIC-II
has a separate memory view. A graph keyed only by a 16-bit address would
conflate different objects.

Coordinate the _entire_ capture with the monitor and the shared HTTP lease,
not only individual commands: changing banks between reads could otherwise
produce a mixed snapshot. Preserve and restore monitor settings where possible,
surface failures, and report whether execution was left paused or resumed.

I/O reads can have side effects or return values different from previous
writes. Respect VICE's side-effect setting and mark unavailable or unreliable
register state as unknown.

### 2. Decode Instructions and Discover Code

Use a standalone, table-driven NMOS 6510 decoder to represent opcode, bytes,
addressing mode, operand, instruction length and effects. Structured decoding
is better suited to graph construction than parsing VICE's textual
disassembly; VICE can still serve as a comparison oracle.

Do not linearly disassemble all memory and claim it is code. BASIC programs,
graphics, tables, stack data, ROM and unused bytes can all resemble
instructions. Instead:

1. Begin at known entry points: supplied addresses, the current PC when
   relevant, known vectors, recognized BASIC `SYS` targets and, later, observed
   execution.
2. Follow branches, jumps, calls and fall-through paths.
3. Build basic blocks and candidate routines.
4. Leave unreachable or ambiguous bytes unknown or data unless there is
   evidence for another interpretation.
5. Offer linear disassembly as an explicitly speculative view of unexplored
   ranges.

Handle documented and unofficial NMOS instructions while marking unstable
behavior. Cover truncated ranges, zero-page wrapping and the
NMOS indirect-`JMP` page-boundary behavior.

The current PC is useful but might be inside a KERNAL interrupt handler rather
than the application. It is an entry point, not proof of the application's
main routine.

### 3. Build an In-Memory Graph

A dedicated graph database is probably unnecessary initially: 64 KiB is small
enough for indexed TypeScript objects, maps and adjacency lists. The interface
can still behave like a small graph database.

Possible nodes:

- Snapshot and memory view.
- Instruction and basic block.
- Candidate routine or entry point.
- Memory location or region.
- Hardware register, vector and documented ROM entry.
- Candidate BASIC line, string, sprite, character set or table.

Possible relationships:

- `CALLS`, `BRANCHES_TO`, `FALLS_THROUGH_TO`
- `READS`, `WRITES`, `MODIFIES`
- `USES_POINTER`, `POINTS_TO`
- `INSTALLS_IRQ_HANDLER`, `CONFIGURES_VIC`
- `POSSIBLE_SPRITE_DATA`, `CONTAINS_TEXT`
- `OBSERVED_EXECUTION`, `OBSERVED_WRITE`

Every relationship should carry evidence and certainty. For example:

```json
{
    "from": { "view": "cpu", "address": "$C010" },
    "relationship": "WRITES",
    "to": { "view": "io", "address": "$D020" },
    "evidence": "STA $D020",
    "certainty": "conditional",
    "condition": "I/O mapped at execution time"
}
```

The condition matters: the same CPU instruction can write RAM rather than the
border-color register if banking differs at execution time.

Queries should distinguish:

- **Direct static reference:** an instruction explicitly names an address.
- **Possible reference:** indexed or indirect access might reach an address.
- **Observed reference:** a trace or watchpoint actually saw it happen.
- **Unresolved:** a target cannot be determined.

Thus, asking where an address is modified must not imply that every indirect
or self-modifying write has been found.

### 4. Add C64-Specific Knowledge

Keep reference data separate and versioned, so it can enrich the graph without
hard-coding every explanation into the decoder:

- **KERNAL:** documented jump-table entries, names, calling conventions and
  side effects.
- **BASIC:** ROM routines, zero-page and workspace variables, tokenized BASIC
  lines and recognizable `SYS` calls.
- **Hardware:** VIC-II, SID and CIA registers, including read/write
  differences and bitfields.
- **Memory map:** vectors, screen and color RAM, stack, common workspace and
  banking behavior.
- **Instruction effects:** reads, writes, flags, branches and stack behavior.

The public KERNAL jump table is a stronger source of stable labels than
arbitrary internal ROM addresses. BASIC and internal ROM labels should be tied
to the appropriate ROM version or fingerprint; unknown or replaced ROMs must
be identified as such.

Retain source and version information for each fact. Check documentation
licenses before bundling or redistributing text; short structured facts and
source links may be preferable to copying entire manuals.

### 5. Recognize Useful Patterns

Start with conservative, evidence-backed rules:

- `JSR` to a known visible KERNAL entry: likely KERNAL call.
- Writes to IRQ vectors: possible interrupt-handler installation.
- Writes to `$d012`, `$d019` and `$d01a`: possible raster IRQ configuration.
- Pointer setup followed by indexed indirect accesses: likely buffer or table
  access.
- Writes to VIC screen-base and sprite-pointer locations: possible graphics
  setup.
- Current VIC bank, screen base and sprite pointers: currently referenced
  sprite-data locations.
- A tokenized BASIC line containing `SYS`: candidate machine-code entry point.

Explain why each pattern was detected. For example, "currently referenced by
sprite 2 at the captured raster position" is stronger than claiming a block is
always a sprite, but it is still snapshot-specific. Multiplexers can change
sprite pointers and modes during the frame.

### Agent-Facing Analysis

The MCP server exposes one replaceable analysis per session:

| Tool                       | Purpose                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `vice_analysis_create`     | Analyze a local PRG, or restore a saved `C64AnalysisState` view.                                  |
| `vice_analysis_capture`    | Capture live C64 RAM or recapture the current live analysis.                                      |
| `vice_analysis_status`     | Inspect the current session analysis identity without contacting VICE.                            |
| `vice_analysis_edit`       | Edit local labels, annotations, typed data, entries and exclusions.                               |
| `vice_analysis_save`       | Save analysis state and captured memory to an authorized local path.                              |
| `vice_analysis_export`     | Export readable annotated disassembly, not reassemblable source.                                  |
| `vice_analysis_search`     | Search entries, instructions, labels, annotations, typed data, corrections, BASIC or diagnostics. |
| `vice_analysis_regions`    | List classification regions and BASIC overlap without dumping captured bytes.                     |
| `vice_analysis_references` | Find candidate memory, control-flow and BASIC `SYS` references to an inclusive address range.     |
| `vice_analysis_routine`    | Explore a candidate entry's instructions, blocks, callers, callees, exits and memory references.  |

`vice_analysis_create` requires a user-authorized local `path` and `format`
(`prg` or `state`). For a PRG, optional decimal `entryPoints` identify machine
code; without them, literal BASIC `SYS` targets are used. `includeBasic: true`
adds BASIC `SYS` targets to explicit entries. PRG banking assumes standard
no-cartridge startup. For saved state, provide its `viewId`; labels, annotations,
corrections, data sections, capture metadata and banking are restored. Input is limited to 65,538 bytes
for a PRG or 4 MiB for state. Creation reports the capture, snapshot ID, initial
banking, diagnostics count and up to 16 entry points. Search for `entry` with
`kind: "entry"` to enumerate all entries, or `diagnostic` with
`kind: "diagnostic"` to inspect coverage gaps. Each session retains only its
most recent successful analysis. Failed creation, capture or editing leaves
the previous analysis intact; replacement or session closure discards the
in-memory analysis unless saved.

With user permission, call `vice_analysis_capture` with `machine: "c64"` and a
`programId` identifying the program. It captures all 65,536 bytes from VICE's
computer (`C:`) RAM bank, current PC and 6510 port registers, plus C: monitor
labels. It temporarily selects the RAM monitor bank, avoiding I/O reads,
restores the original bank and sends resume; this does not prove execution
resumed. It records cartridge mapping as unknown. Only a PC known to be
RAM-visible is seeded, along with literal BASIC `SYS` targets and optional
`entryPoints`. Variable `SYS` expressions remain unresolved. Static discovery
of RAM behind ROM does not mean that RAM was executing. Call capture again
with the current `snapshotId` to recapture the same view and reconcile local
knowledge; this produces a new snapshot ID. Capture does not unpack programs.

Use `vice_analysis_status` to find the current session snapshot; its program ID
is not independently verified. For a different program, save prior work if
needed and capture with a fresh `programId` and no `snapshotId`. This replaces
the current analysis only after success; it does not reset VICE. VICE monitor
labels can survive a program change, so use `importViceLabels: false` to avoid
importing them into the fresh analysis. This option skips imports on a recapture
too, but does not remove labels already in that analysis.

On recapture, the engine compares unique bytes from the previous graph's
candidate instructions against the new RAM. If at least 64 bytes were
compared, at least 64 changed, and more than half changed, it rejects the
recapture and preserves the old state. This is a conservative warning, not
program identification: overlays, changing data mistaken for code, and
self-modification can cause false positives; sparse graphs and leftover RAM
can hide a switch. Once the same program is independently confirmed,
`confirmSameProgram: true` permits reconciliation and reports the comparison.
Never use this override merely to suppress a possible mismatch.

Use `vice_analysis_edit` with `snapshotId` and `action`: `label_add`,
`label_rename`, `label_reattach`, `label_remove`, `annotation_add`,
`annotation_update`, `annotation_reattach`, `annotation_remove`, `data_add`,
`data_update`, `data_reattach`, `data_remove`, `entry_add`, `entry_remove`,
`exclude_add`, `exclude_remove` or `set_illegal_opcodes`. Tool schemas describe each action's fields.
These changes affect the analysis only, not VICE memory or labels. Data
sections are descriptive, not proof of data and not automatic code exclusions;
use an explicit exclusion when appropriate. Data sections and exclusions are
active only while their anchored bytes match; changed bytes make them stale.
Data sections can be explicitly reattached, and stale exclusions removed and
recreated. Block and routine annotations and code labels use the existing
conservative reconciliation statuses. Use search with `text: "*"` and the
appropriate kind to list items and their IDs, including stale data and
corrections.

Unofficial opcode decoding is disabled by default. Set
`includeIllegalOpcodes: true` when creating a PRG analysis or capturing live
RAM, or use `set_illegal_opcodes` with `enabled: true` to rebuild an existing
analysis. Recapture retains the setting unless explicitly overridden; state
restore uses its saved policy and does not accept an override. Enabling it can
make data appear to be code.

To keep a listing focused, add a data section with `dataType: "unused"`.
An active section suppresses raw bytes in its range and suppresses instructions
or BASIC lines only when the complete item lies within the marked range. The
listing identifies omitted ranges and retains their descriptions. This is a
reversible display decision: it does not delete memory, alter references or
classify the range as non-code. If captured bytes change, the section becomes
stale and no longer suppresses the listing; review and explicitly reattach,
retype or remove it. Search `kind: "data", text: "*"` to find section IDs.
Export with `includeUnused: true` to show these ranges without removing the
annotations.

Raw non-code bytes in `$0000-$01ff` are hidden by default, while discovered
instructions in that region remain visible. This is a display convention, not a
claim that zero page or the stack page cannot contain code. Use
`includeLowMemoryData: true` for MCP export, `--include-low-memory-data` for
the CLI, or `includeLowMemoryData: true` in the formatter API to show them.
Captured bytes and query results are unchanged.

When identifying a possible unused range, start with `vice_analysis_regions`
filtered to large `unknown` regions. It returns full classification-region
boundaries, byte lengths and evidence, plus `basicOverlap` because BASIC is
tracked separately from machine-code classification. Filtered address bounds
select overlapping regions rather than clipping their reported boundaries.
Inspect BASIC, candidate instructions and entries, labels, direct and possible
indexed references, memory layout and any known VIC/hardware pointers before
marking a range. Include unresolved references in the investigation. Absence of
static references is not proof: indirect accesses, self-modifying code, later
execution and overlays can use apparently unreferenced memory. Record the
reason and uncertainty in the section description; do not mark whole pages
unused based only on their conventional roles.

`vice_analysis_save` and `vice_analysis_export` require an authorized local
`path` and `confirm: true`; set `overwrite: true` only when replacement is
authorized. Save files include captured memory and notes and can be restored
with `vice_analysis_create` and the saved `viewId`. Export includes current
labels, block/routine names and hints, and active or stale data sections in a
human-readable listing. It is not reassemblable source.
Consecutive BASIC lines share a candidate heading. Statement separators outside
strings and `REM` are split across indented lines; indentation after `IF ...
THEN` reflects that the rest of the original BASIC line is conditional.

Pass the returned `snapshotId` to every query. For example, using decimal
addresses in MCP JSON:

```json
{"snapshotId":"<id>","text":"entry","kind":"entry","limit":25}
{"snapshotId":"<id>","start":53280,"end":53280,"includeUnresolved":true}
{"snapshotId":"<id>","entry":4096,"limit":25}
```

Queries return `programId`, `viewId`, `snapshotId`, capture bounds, banking,
`includeIllegalOpcodes`,
`evidence: "static-candidates"`, `items`, `total`, `offset`, `limit` and
`nextOffset`. Limits are 1–100 items (default 25), with an offset of at most
1,000,000; continue with `nextOffset` until it is `null`. Search is
case-insensitive substring matching (`*` lists all), optionally constrained by kind and an
inclusive source-address range. Instruction search includes its mnemonic,
formatted operand, operation name, addressing mode, flow and memory-access
property. Search items are capped at 256 characters and explicitly mark text
truncation. Saved labels and annotations expose their reconciliation status;
modified, relocated or orphaned names are not proven to apply at a new address.
System results include mapping certainty, view, source and any condition.
Pattern detection and search over catalog entries not attached to the graph are
not yet implemented.

Reference results distinguish `direct`, `possible` indexed and `unresolved`
targets. Indexed references conservatively include any 8-bit index, including
address-space wrapping; they do not prove the actual target. Unresolved
indirect references and BASIC expressions are excluded unless
`includeUnresolved` is true, in which case they are included regardless of the
requested range. The optional `access` filter selects `read`, `write`, `call`,
`jump`, `branch` or `basic-sys`; read-modify-write instructions appear in both
read and write results. Direct references and single-address indexed matches include
possible mapped views, not proof of the physical target.

Routine exploration follows candidate fallthroughs, branches and direct jumps,
stopping at other entry points and not following calls. It reports exits,
including unresolved and external transfers. A routine boundary and a caller
are hypotheses, not proof of execution or exclusive ownership. A
`basic-sys` caller denotes a literal BASIC token, not observed execution.
Undiscovered code, indirect transfers, self-modification, overlays and packed
programs can make all results incomplete; no automatic unpacking or execution
is performed.

In shared HTTP mode, each MCP session owns its analysis independently of the
VICE lease. It cannot access another session's snapshot. Capture acquires the
lease and releases it after success; a failure retains the lease so the owner
can inspect and resolve the situation, then explicitly release it. A failed
bank restore can leave VICE paused with a different monitor bank; a disconnected
capture leaves execution and bank state unknown. Do not blindly retry mutations.
Closing the session discards its unsaved analysis. File reads and writes require
the user's consent and access to the local server filesystem. The HTTP
authentication and local-file security caveats still apply.

The same graph queries are available to library callers through
`C64AnalysisQueries`; pass `state.matchAnnotations(graph)` when searching
saved user annotations and rebuild the query object after editing annotations.
The query layer does not change the graph or its saved state.

### 6. Future MCP Queries

The remaining proposed tools depend on additional analysis:

| Proposed tool               | Purpose                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `vice_analysis_capture`     | Extend to capture a range or additional memory views from VICE.    |
| `vice_analysis_disassemble` | Return annotated instructions or blocks for an address or routine. |
| `vice_analysis_graph`       | Traverse selected edge types with depth and result limits.         |
| `vice_analysis_diff`        | Compare two snapshots for changed bytes, code and relevant state.  |

Additional capture views will require explicit bank and device identity and
safe snapshot consistency.

Agent-written names and explanations can be stored as **separate
annotations**, linked to the snapshot and evidence. They must not silently
become authoritative decoder facts.

## What This Can Achieve

For conventional, mostly static machine-code programs, an agent could ask:

- Which routines call a KERNAL character-output function?
- Which discovered instructions write to the border-color register, and under
  which banking assumptions?
- Where is the IRQ vector installed, and what handler does it point to?
- Which routines read or modify a buffer?
- What sprite data is currently referenced, and which code may configure its
  pointers?
- What changed between two paused snapshots?

The agent could produce an evidence-linked overview of the discovered program
structure while highlighting undiscovered and ambiguous regions.

## Limitations and Dynamic Evidence

Static analysis cannot completely reconstruct arbitrary C64 programs:

- Indirect addressing and computed jumps can hide targets.
- Self-modifying code, decompression and overlays mean a snapshot may not
  contain code that executes later.
- Bank switching, cartridges and custom ROMs can change what an address means.
- Code and data can overlap, and bytes alone rarely prove their intended use.
- Interrupts, raster effects and sprite multiplexing make a single snapshot
  incomplete.
- A BASIC program mostly executes through the BASIC interpreter and needs
  BASIC-specific analysis, not just 6510 disassembly.

A later, explicitly opt-in dynamic-evidence phase could integrate VICE CPU
history, profiling, memory maps, tracepoints and watchpoints where supported.
It can confirm particular executions and writes, but it changes execution state
and cannot prove that unobserved paths are impossible.

## Suggested Implementation Order

1. **Snapshot and decoder:** safe, consistent capture; structured decoding;
   tests for all opcodes and address boundaries.
2. **Control-flow graph and cross-references:** entry points, blocks, direct
   calls and memory accesses, preserving uncertainty.
3. **C64 annotations:** KERNAL, BASIC, hardware registers, banking and vectors
   with source and version metadata.
4. **Agent-facing queries:** bounded search, references and routine exploration.
5. **Graphics and pattern detection:** VIC-derived regions, IRQ patterns and
   BASIC `SYS` entry points.
6. **Optional dynamic evidence and snapshot diffs.**

Validate with small synthetic programs whose calls, branches, indexed accesses
and bank assumptions are known. Compare decoder output with VICE and test real
programs. The key success criterion is useful, evidence-backed answers with
explicit coverage gaps, not disassembling every byte.

## Additional Notes by the Developer

- It should be possible to analyse PRG files as well as memory snapshots. Prg
  files have a 2 byte header with the load address of the program.
