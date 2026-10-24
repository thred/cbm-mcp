---
name: cbm-mcp
description: "Use when debugging, inspecting, or patching Commodore machines in VICE through the cbm-mcp tools, especially C64 memory banking, hardware registers, and 6510 assembly."
---

# Commodore Debugging With CBM MCP

## Load Only What Is Needed

Use the matching `LOAD` directive only when needed. Paths are relative to this skill.

| Task                                                            | Directive                             |
| --------------------------------------------------------------- | ------------------------------------- |
| C64 addresses, banking, screen, I/O, BASIC pointers, interrupts | `LOAD ./references/c64-memory-map.md` |
| C64 VIC-II banks, sprites, fonts, graphics export               | `LOAD ./references/vic2.md`           |
| C64 disassembly, instruction effects, flags, addressing, timing | `LOAD ./references/6510-assembly.md`  |

Confirm the emulated machine, CPU, device, bank, and PAL/NTSC model before reasoning
about hardware. Only C64 resources are bundled so far. Do not apply its map to
VIC-20, PET, C128, Plus/4, CBM-II, or a drive CPU; obtain that architecture's
reference first. Add future resources as separate files and routing rows above.

## Working Procedure

1. Discover the available `vice_*` tools and their schemas; do not invent names or
   arguments. Use `vice_status`, then registers and a small disassembly/memory range.
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
- Also release the connection before handing over to another chat, agent, or
  external monitor client, and before telling the user to use the VICE monitor.
- If a connect or command fails with a closed socket or timeout while no other
  client should be attached, check for a stale connection from another chat
  before retrying; do not retry mutations blindly.
