---
name: cbm-mcp
description: "Use when analyzing, disassembling, annotating, debugging, inspecting, or patching Commodore programs in VICE using cbm-mcp, especially C64 live RAM analysis, banking, hardware registers, and 6510 assembly."
---

# Commodore Debugging With CBM MCP

## Load Only What Is Needed

Use the matching `LOAD` directive only when needed. Paths are relative to this skill.

| Task                                                            | Directive                             |
| --------------------------------------------------------------- | ------------------------------------- |
| C64 addresses, banking, screen, I/O, BASIC pointers, interrupts | `LOAD ./references/c64-memory-map.md` |
| C64 VIC-II banks, sprites, fonts, graphics export               | `LOAD ./references/vic2.md`           |
| C64 disassembly, instruction effects, flags, addressing, timing | `LOAD ./references/6510-assembly.md`  |

Confirm the emulated machine, CPU, device and relevant bank before interpreting
hardware. Determine PAL/NTSC when timing or model-specific behavior matters;
see the local mapping below. Only C64 resources are bundled so far. Do not apply its map to
VIC-20, PET, C128, Plus/4, CBM-II, or a drive CPU; obtain that architecture's
reference first. Add future resources as separate files and routing rows above.

## Program Analysis

1. Use `vice_analysis_status` to inspect the session's current program ID and
   snapshot. A program ID is a caller assertion, not detection: neither an
   existing snapshot, a filename, nor a still-running VICE instance establishes
   what program is now active. Check independent evidence such as the screen
   or the user's description. Do not label an unknown program with an earlier
   game's name.
2. With consent, use `vice_analysis_capture` for live C64 RAM or
   `vice_analysis_create` for an authorized PRG or saved state. To start fresh
   for another program, save old notes first if needed, then capture with the
   new `programId` and **no** `snapshotId`. Consider `importViceLabels: false`
   for a new program: monitor labels can persist across program changes.
   The previous session analysis is replaced only after success.
3. Use `snapshotId` to recapture only the same program. A large change in
   previously detected candidate code blocks reconciliation and preserves the
   previous analysis; it is a warning, not proof of a different game. For a
   confirmed same program with overlays or self-modification, recapture with
   `confirmSameProgram: true`. Small samples and unchanged leftover RAM can
   conceal a program change. Never rely on this heuristic to prove identity.
4. Prefer `vice_analysis_regions`, `vice_analysis_search` (including `entry`
   and `diagnostic`), `vice_analysis_routine`, and `vice_analysis_references`
   to repeatedly using monitor disassembly. Results are static candidates,
   not proof of execution or CPU mapping. A PC can be inside a routine or ROM;
   use known calls, backtrace and execution history to find defensible entries.
   Use `vice_analysis_edit` `entry_add` to discover a justified entry in the
   captured RAM, then query it. Do not turn arbitrary data into code.
5. Add evidence-based labels and annotations with `vice_analysis_edit`, and
   save state or export a readable annotated listing with file authorization.
   Snapshot queries do not read current CPU-visible memory. Use the monitor
   disassembler when checking live CPU mapping, uncaptured bytes, drive CPUs,
   or a fresh instruction after stepping or self-modification; recapture when
   the snapshot is stale. Never assume RAM under ROM is currently executable.

## VICE Video Standard

For timing-dependent work, after establishing the machine is a C64, read
`MachineVideoStandard` with `vice_resource_get`. VICE's `machine.h` defines
`1` = PAL, `2` = NTSC, `3` = old NTSC, `4` = PAL-N. These are video standards,
not independent proof of machine type or a complete VIC-II revision. Unknown
values or unsupported resources need investigation for the installed VICE.
Source: [VICE machine.h](https://github.com/VICE-Team/svn-mirror/blob/main/vice/src/machine.h).
No web lookup is needed for these known values.

## Working Procedure

1. Discover the available `vice_*` tools and their schemas; do not invent names or
   arguments. Use `vice_status`, then registers and bounded analysis queries or reads.
2. Distinguish CPU-visible memory, underlying RAM, and VIC-II memory. Query
   `vice_bank` before selecting an explicit view; do not assume a bank name exists.
3. For I/O inspection, query `vice_sidefx`; disable read side effects if appropriate,
   remembering and restoring the prior setting. Inspection can pause execution.
4. State a testable hypothesis; prefer breakpoints/watchpoints and bounded stepping
   over patches. JSON addresses are decimal integers; monitor expressions use
   explicit prefixes such as `$d020`. Labels belong to the selected device.
5. Before writes, resets, file operations, or resuming, establish the intended
   change and preserve affected state. Do not blindly retry a timed-out mutation.
6. Verify the result, remove only temporary checkpoints/labels you created, and
   report changes plus whether execution was resumed or left paused. Socket status
   is not CPU-running status; command delivery is not execution acknowledgment.

## Monitor Connection Lifecycle

VICE accepts only one monitor connection at a time. A connection left open by
one chat or task blocks every other chat, agent, or tool until it is closed.

- Stay connected for the whole time a chat or task is actively using VICE; do not
  disconnect between steps, because reconnecting pauses emulation and loses the
  session.
- When the chat or task is finished (or the user is done with VICE), call
  `vice_resume` if the program should keep running, then `vice_disconnect`.
  `vice_resume` closes the socket itself; `vice_disconnect` alone neither resumes
  nor quits VICE, and `vice_quit` must not be used for this.
- In shared HTTP mode, release your debugging lease with `vice_lease_release`
  when finished or handing off. `vice_resume` and `vice_disconnect` do not
  release the lease. Inspect `vice_lease_status` if another session owns it;
  never take over without explicit user consent.
- Also release the connection before handing over to another chat, agent, or
  external monitor client, and before telling the user to use the VICE monitor.
- If a connect or command fails with a closed socket or timeout while no other
  client should be attached, check for a stale connection from another chat
  before retrying; do not retry mutations blindly.
