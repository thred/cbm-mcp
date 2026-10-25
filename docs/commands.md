# VICE Monitor Command Catalog

The server's tools cover the command families documented in
[VICE manual chapter 12](https://vice-emu.sourceforge.io/vice_12.html). Aliases map
to the same behavior rather than adding duplicate tools. Internal/undocumented
monitor commands are not an unrestricted escape hatch. The catalog starts with the
core tools and continues with the remaining command families.

## Core Tools

| Tool                     | Arguments                                       | Behavior                                                                  |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `vice_status`            | None                                            | Report configured endpoint and local socket state; does not contact VICE. |
| `vice_connect`           | None                                            | Connect and synchronize using a register read.                            |
| `vice_disconnect`        | None                                            | Close the socket without sending resume or quit.                          |
| `vice_registers`         | None                                            | Display registers in the monitor's current address space.                 |
| `vice_memory`            | `start`, optional `length`, `format`            | Display computer memory as hex, PETSCII, or screen-code text.             |
| `vice_disassemble`       | `start`, optional `length`                      | Disassemble a computer-memory byte range.                                 |
| `vice_step`              | Optional `count`, `mode`                        | Step into instructions or over subroutines.                               |
| `vice_resume`            | None                                            | Send `exit`, then close the socket without waiting for a prompt.          |
| `vice_breakpoints`       | None                                            | List all checkpoints, including breakpoints and watchpoints.              |
| `vice_breakpoint_set`    | `start`, optional `end`, `operations`           | Create an execution breakpoint or memory watchpoint on the computer.      |
| `vice_checkpoint_toggle` | `id`, `enabled`                                 | Enable or disable one existing checkpoint.                                |
| `vice_checkpoint_delete` | `id`                                            | Delete exactly one checkpoint.                                            |
| `vice_register_set`      | `register`, `value`                             | Set one 6502 register in the current address space.                       |
| `vice_memory_write`      | `start`, `bytes` or `text`, optional `encoding` | Write bytes or encoded text to computer memory.                           |
| `vice_help`              | Optional `command`                              | Show all monitor help or help for a single command.                       |
| `vice_backtrace`         | None                                            | Display the current CPU's best-guess JSR call chain.                      |
| `vice_screen`            | None                                            | Display the text screen, not a bitmap screenshot.                         |
| `vice_sidefx`            | Optional `enabled`                              | Query or explicitly enable/disable monitor read side effects.             |

The core memory tools take decimal JSON integer addresses from 0 to 65535 and
always use the computer address space (`C:`) and its selected bank. `length` is a
byte count from 1 to 256, defaulting to 64. Ranges cannot wrap past `$ffff`.
`count` ranges from 1 to 1000 and defaults to 1; `mode` is `into` (default) or
`over`. `vice_breakpoint_set` accepts `operations` of `exec` (default), `load` and
`store`. Registers and stepping use the current monitor address space, selected
with `vice_device` and `vice_bank`. Unknown arguments, nulls, and invalid values
are rejected.

## Arguments and Results

- Parameters in brackets are optional. Tool schemas describe required fields and
  enum values. JSON numbers are integers, not hexadecimal strings.
- New address parameters accept integers from 0 to 65535, `.labels`, or explicit
  hexadecimal strings such as `$1000` and `8:$1000`. Labels use the current
  device's symbol table; select a drive with `vice_device` before using its labels.
  `8:.label` is deliberately rejected because VICE's parser does not support it.
- Explicit range tools use `start` and inclusive `end`. If `end` is omitted, it
  equals `start`. Unqualified numeric ranges may not wrap. Symbolic addresses
  are resolved by VICE, which applies its native range/bank semantics. Do not
  mix address spaces within a range.
- Byte arrays contain 1-256 integers from 0 to 255. `memory_hunt` also accepts
  the string `xx` as a wildcard. No implicit string-to-number conversion occurs.
- Memory-map masks are 0-255. History counts are 1-10000. Profiling result counts
  are 1-1000 and graph depths 1-100. Checkpoint IDs are positive 32-bit integers.
- Numeric tokens use explicit radix prefixes except where VICE requires decimal
  syntax: checkpoint IDs, history counts, file device numbers, and profile
  counts/context IDs/depths. Expression and assembly strings use VICE's syntax;
  prefer explicit prefixes inside them too.
- Expressions permit registers, arithmetic, and the punctuation used by VICE
  conditions, but not command separators, quotes, or line breaks. The native
  command determines the expression grammar: `print` supports arithmetic, while
  checkpoint conditions additionally support comparisons and banked memory reads.
- Paths are on the **VICE host**, relative to VICE's working directory if not
  absolute. Paths/quoted values cannot contain double quotes, backslashes, or
  control characters. Spaces and semicolons inside paths are preserved. The
  directory-list command takes a raw rest-of-line path rather than a quoted token.
- Most outputs are native monitor text. Parse/native command errors become MCP
  `isError` results. Feature availability depends on the VICE machine/version/build.
  Large replies are subject to the client's 1 MiB buffer limit.

### Execution Modes

`reply` waits for a normal monitor prompt. `step_out` and `run_until` may execute
for a long time before replying. Set `VICE_TIMEOUT_MS` appropriately. If they
time out, the connection is discarded, but **execution is not canceled** and a
temporary breakpoint might still exist. The next inspection interrupts running
execution again. There is no asynchronous breakpoint-event subscription.

`send` writes a command and closes the connection without waiting for a prompt,
because the command can resume, replace state, disable monitoring, or terminate
VICE. Success means delivery to the local socket, **not acceptance or successful
execution by VICE**. Invalid commands might have produced a diagnostic that was
not captured. Reconnect to inspect state when appropriate; do not blindly retry.

`assemble` handles one instruction's interactive assembly prompt and terminates
assembly with an empty line before releasing the command queue. Repeat the tool
for further instructions. It never leaves the session in interactive mode after
a successful operation. An invalid instruction is reported without sending a
blank command that could repeat another monitor operation.

Monitor operations can connect and pause VICE, even when they only read state.
Text conversion through `vice_convert` is local and does not contact VICE.
Destructive annotations are hints, not authorization. Restrict
state-changing tools with your MCP client's approval policy. There is no filesystem
sandbox: trusted scripts and label files can execute commands, and checkpoint
commands are deferred command execution when a checkpoint fires.

## Execution and Machine State

All tool names in the tables have the `vice_` prefix.

| Tool               | VICE command             | Arguments                                                   | Mode        |
| ------------------ | ------------------------ | ----------------------------------------------------------- | ----------- |
| `evaluate`         | `print`                  | `expression`                                                | reply       |
| `convert`          | `~` or local encoding    | `value` (0-4294967295) or `text`, `[encoding]`              | reply/local |
| `device`           | `device`                 | `[space]`: `C:`, `8:`, `9:`, `10:`, `11:`                   | reply       |
| `bank`             | `bank`                   | `[name]` identifier                                         | reply       |
| `cpu`              | `cpu`                    | `type`: `6502` or `z80`                                     | reply       |
| `radix`            | `radix`                  | `[radix]`: `H`, `D`, `O`, `B`                               | reply       |
| `goto`             | `goto`                   | `address`                                                   | send        |
| `step_out`         | `return`                 | None                                                        | reply       |
| `run_until`        | `until`                  | `address`                                                   | reply       |
| `io`               | `io`                     | `[address]` for chip details                                | reply       |
| `stopwatch`        | `stopwatch`              | `[action]`: `reset`                                         | reply       |
| `cpu_history`      | `cpuhistory`             | `[count]`, `[spaces]` (1-5 unique spaces)                   | reply       |
| `reset`            | `reset`                  | `type`: 0 reset, 1 power cycle, 8-11 drive; `confirm: true` | send        |
| `quit`             | `quit`                   | `confirm: true`                                             | send        |
| `warp`             | `warp`                   | `[state]`: `on`, `off`, `toggle`                            | reply       |
| `cartridge_freeze` | `cartfreeze`             | None                                                        | send        |
| `expansions`       | `export`                 | None                                                        | reply       |
| `keyboard`         | `keybuf`                 | `text` or `codes` byte array; `[submit]` appends Return     | reply       |
| `register_write`   | `registers name = value` | `register`, `value` (0-65535)                               | reply       |

`device` without arguments selects the computer; it is not a query. `bank` without
arguments lists banks. CPU selection depends on the machine. Generic register
writes delegate register validity and width to VICE, which may truncate values;
the original `vice_register_set` retains stricter 6502 widths. Keyboard codes are
encoded as VICE C-style hex escapes; literal text does not interpret escapes.
`submit: true` appends Return to that same command; execution remains paused.
Text conversion returns JSON containing `encoding` and `bytes`. Encoding defaults
to `petscii`; `ascii` and `screen_codes` are also supported. C64 encodings use the
uppercase/graphics set and fold letters to uppercase; unsupported characters are
rejected rather than substituted. Text is limited to 1-256 printable ASCII
characters. Numeric conversion retains its existing monitor behavior.

## Memory and Assembly

| Tool                  | VICE command   | Arguments                                                                                 | Mode     |
| --------------------- | -------------- | ----------------------------------------------------------------------------------------- | -------- |
| `memory_compare`      | `compare`      | `start`, `[end]`, `destination`                                                           | reply    |
| `memory_move`         | `move`         | `start`, `[end]`, `destination`                                                           | reply    |
| `memory_fill`         | `fill`         | `start`, `[end]`, `bytes`                                                                 | reply    |
| `memory_hunt`         | `hunt`         | `start`, `[end]`, `bytes` (supports `xx`)                                                 | reply    |
| `memory_petscii`      | `i`            | `start`, `[end]`                                                                          | reply    |
| `memory_screen_codes` | `ii`           | `start`, `[end]`                                                                          | reply    |
| `memory_characters`   | `memchar`      | `start`, `[end]`                                                                          | reply    |
| `memory_sprites`      | `memsprite`    | `start`, `[end]`                                                                          | reply    |
| `export_font`         | `bank`/`mem H` | `path`, `[format]`, `[scope]`, `[bank]`, `[offset]`, `[count]`, `[perRow]`, color options | file     |
| `export_sprites`      | `bank`/`mem H` | `path`, `[format]`, `[bank]`, `[start]`, `[count]`, `[perRow]`, color options             | file     |
| `memory_range`        | `mem H`        | `start`, `[end]`                                                                          | reply    |
| `disassemble_range`   | `disass`       | `start`, `[end]`                                                                          | reply    |
| `memmap_show`         | `memmapshow`   | `[mask]`, `[start]`, `[end]`                                                              | reply    |
| `memmap_clear`        | `memmapzap`    | None                                                                                      | reply    |
| `memmap_save`         | `memmapsave`   | `path`, `format`: 0 BMP, 1 PCX, 2 PNG, 3 GIF, 4 IFF                                       | reply    |
| `assemble`            | `a`            | `address`, `instruction`                                                                  | assemble |

The new range tools use the current device unless the address has an explicit
numeric device prefix. The original `vice_memory` and `vice_disassemble` remain
computer-only and length-based. I/O reads respect the monitor's `sidefx` setting.
`vice_memory` also accepts `format: "petscii"` or `"screen_codes"` for native text
views. `vice_memory_write` accepts either raw `bytes` or `text` with the same
encoding choices as `vice_convert`; it never appends a terminator.
Memory writes and assembly can change hardware state or overwrite code. Moving
or filling memory is not transactional. Memory-map/history features require a
VICE build with CPU-history support. `memmap_show` requires `mask` when a range
is supplied, and `start` when `end` is supplied. Assembly accepts one instruction,
without colon/semicolon command separators; VICE validates the mnemonic/operands.

## Checkpoints and Symbols

| Tool                   | VICE command   | Arguments                                       | Mode  |
| ---------------------- | -------------- | ----------------------------------------------- | ----- |
| `tracepoint_set`       | `trace`        | `start`, `[end]`, `[operations]`, `[condition]` | reply |
| `watchpoint_set`       | `watch`        | `start`, `[end]`, `[operations]`, `[condition]` | reply |
| `checkpoint_condition` | `condition`    | `id`, `expression`                              | reply |
| `checkpoint_ignore`    | `ignore`       | `id`, `[count]`                                 | reply |
| `checkpoint_command`   | `command`      | `id`, `command`                                 | reply |
| `checkpoint_dummy`     | `dummy`        | `[state]`: `on`, `off`, `toggle`                | reply |
| `label_add`            | `add_label`    | `address`, `label`                              | reply |
| `label_delete`         | `delete_label` | `label`, `[space]`                              | reply |
| `labels`               | `show_labels`  | `[space]`                                       | reply |
| `labels_clear`         | `clear_labels` | `[space]`                                       | reply |
| `labels_load`          | `load_labels`  | `path`, `[space]`                               | reply |
| `labels_save`          | `save_labels`  | `path`, `[space]`                               | reply |

Operations are 1-3 unique values from `exec`, `load`, `store`. The tracepoint tool
defaults to `exec`; the watchpoint tool defaults to `load` and `store`. Tracepoints
do not stop execution; watchpoints do. The existing `vice_breakpoint_set` supports
load/store/exec breakpoints too. To condition an existing breakpoint, call
`vice_checkpoint_condition` before resuming. Labels must start with a dot and
use letters/digits/underscores/dots after their initial letter/underscore.

Ignore counts are 0-2147483647; omitted count uses VICE's default of one. An empty
checkpoint command clears it. Commands attached to checkpoints are deliberately
powerful and must be trusted: they can write memory/files or terminate VICE.
Native restrictions such as unsupported `exit` checkpoint actions still apply.
Selecting a device/bank or loading symbols changes monitor state for later calls.

## Files, Media, and Emulator Settings

| Tool                | VICE command     | Arguments                                             | Mode  |
| ------------------- | ---------------- | ----------------------------------------------------- | ----- |
| `snapshot_save`     | `dump`           | `path`                                                | reply |
| `snapshot_load`     | `undump`         | `path`                                                | send  |
| `directory_change`  | `cd`             | `path`                                                | reply |
| `directory_create`  | `mkdir`          | `path`                                                | reply |
| `directory_remove`  | `rmdir`          | `path`                                                | reply |
| `directory_list`    | `dir`            | `[path]`                                              | reply |
| `directory_current` | `pwd`            | None                                                  | reply |
| `log_file`          | `logname`        | `path`                                                | reply |
| `log`               | `log`            | `[state]`: `on`, `off`, `toggle`                      | reply |
| `record`            | `record`         | `path`                                                | reply |
| `record_stop`       | `stop`           | None                                                  | reply |
| `playback`          | `playback`       | `path`                                                | send  |
| `comment`           | `;`              | `text`                                                | reply |
| `resource_get`      | `resourceget`    | `name`                                                | reply |
| `resource_set`      | `resourceset`    | `name`, `value` strings                               | send  |
| `resources_load`    | `load_resources` | `path`                                                | send  |
| `resources_save`    | `save_resources` | `path`                                                | reply |
| `media_attach`      | `attach`         | `path`, `device`: 1, 2, 8-11, 32                      | reply |
| `media_detach`      | `detach`         | `device`: 1, 2, 8-11, 32                              | reply |
| `autostart`         | `autostart`      | `path`, `[index]` (1-65535)                           | send  |
| `autoload`          | `autoload`       | `path`, `[index]` (1-65535)                           | send  |
| `program_load`      | `load`           | `path`, `device`, `[address]`                         | reply |
| `basic_load`        | `loadbasic`      | `path`, `device`, `[address]`                         | reply |
| `program_verify`    | `verify`         | `path`, `device`, `[address]`                         | reply |
| `binary_load`       | `bload`          | `path`, `device`, `address`                           | reply |
| `binary_verify`     | `bverify`        | `path`, `device`, `address`                           | reply |
| `program_save`      | `save`           | `path`, `device`, `start`, `[end]`                    | reply |
| `binary_save`       | `bsave`          | `path`, `device`, `start`, `[end]`                    | reply |
| `disk_list`         | `list`           | `[device]`: 8-11                                      | reply |
| `disk_command`      | `@`              | `command` (virtual drive-8 DOS command)               | reply |
| `block_read`        | `block_read`     | `track`, `sector`, `[address]`                        | reply |
| `block_write`       | `block_write`    | `track`, `sector`, `address`                          | reply |
| `tape_control`      | `tapectrl`       | `command` (0-6)                                       | reply |
| `tape_offset`       | `tapeoffs`       | `[offset]` (0-2147483647)                             | reply |
| `screenshot`        | `screenshot`     | `path`, `[format]`: 0 BMP, 1 PCX, 2 PNG, 3 GIF, 4 IFF | reply |

File `device` values are 0 for the VICE host or 8-11 for drives. Attachment uses
device 32 for cartridges, 1 for tape, and 2 for a PET's second tape unit. Track values
are 1-255 and sectors 0-255; the image format determines which values are valid.
Block operations and DOS commands target drive 8. DOS commands can erase/format
disk contents. Tape commands are 0 stop, 1 start, 2 forward, 3 rewind, 4 record,
5 reset, and 6 reset counter. Playback can execute arbitrary monitor scripts;
label loading also uses VICE's command-file machinery. Only load trusted files.

Program load/verify use the two-byte load-address header; supplying an address
overrides its destination. Binary operations do not use that header. BASIC load
also updates BASIC pointers. Program save includes the load-address header;
binary save omits it. VICE applies native save-range semantics. Snapshot restore
replaces machine state; snapshots do not embed ROM images. Resource changes may
disable monitoring or affect host access. No files are read or written by the
Node server itself for these tools: all operations execute inside VICE.

## Profiling

| Tool                  | VICE command      | Arguments                | Mode  |
| --------------------- | ----------------- | ------------------------ | ----- |
| `profile_control`     | `profile on/off`  | `state`: `on`, `off`     | reply |
| `profile_flat`        | `profile flat`    | `[count]`                | reply |
| `profile_graph`       | `profile graph`   | `[context]`, `[depth]`   | reply |
| `profile_function`    | `profile func`    | `function` address       | reply |
| `profile_disassemble` | `profile disass`  | `function` address       | reply |
| `profile_clear`       | `profile clear`   | `function` address       | reply |
| `profile_context`     | `profile context` | `context` (0-2147483647) | reply |

Enabling profiling clears previous data. These commands require a VICE version
and build with profiling support; the MCP does not emulate missing native features.

## Verification and Extension

Every additional tool has a command-formatting/execution-mode test in
`test/server.test.ts`. The suite checks that the fixture catalog covers every
registered additional tool, checks null/unknown arguments across all fields, and
tests injection/boundary rejection. TCP fixtures test fragmented prompts,
interactive assembly, syntax errors, serialization, reconnection, and timeouts.

The live stdio test only performs inspections and temporary label/checkpoint
operations that it cleans up. Reset, quit, snapshots, writes, file operations,
script playback, execution control, and build-dependent profiling/history are
not exhaustively live-tested against the user's emulator.

To add another command, define its fields and command builder in
`src/vice/monitor-tools.ts`, choose the correct execution mode, add a formatting
case and rejection cases in `test/server.test.ts`, and document the tool here.
Field formatters share validation and schema generation; no additional dependency
or generic raw-command execution is needed.
