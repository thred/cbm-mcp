# CBM MCP: VICE Monitor

A small Node.js/TypeScript MCP server for a locally running VICE emulator. This
first server exposes VICE monitor tools through **stdio** and connects to VICE's
**text remote monitor** over TCP, by default at `127.0.0.1:6510`.

The only direct runtime dependency is the official `@modelcontextprotocol/sdk`.
TCP, configuration, and process lifecycle use Node.js APIs. Tests use the project's
existing Vitest dependency.

## Setup

Use Node.js 24+ and npm 11+:

```sh
npm install
npm run build
```

Enable the text remote monitor in VICE's settings, or start VICE with:

```sh
x64sc -remotemonitor -remotemonitoraddress ip4://127.0.0.1:6510
```

The executable name depends on your installation and emulated machine. Do not
select the binary monitor: its wire protocol is different. Keep the monitor bound
to loopback; VICE's monitor has no authentication and provides powerful access to
the emulator and host files.

## Connect an MCP Client

For VS Code, add this server entry to your workspace's `.vscode/mcp.json`:

```json
{
    "servers": {
        "vice": {
            "type": "stdio",
            "command": "node",
            "args": ["${workspaceFolder}/dist/stdio.js"]
        }
    }
}
```

Other MCP clients typically use `mcpServers` instead of `servers`. Give them an
absolute path to `dist/stdio.js`, since their working directory may differ.

Run `node dist/stdio.js` directly for a built server, or `npx tsx src/stdio.ts`
during development. Stdout is exclusively MCP JSON-RPC, not an interactive command
prompt. Avoid using `npm start` as an MCP client's command because npm may print
script banners to stdout. The provided `npm start` and `npm run dev` scripts are
convenient for manual launches.

Optional environment variables on the server entry:

| Variable          | Default     | Meaning                                           |
| ----------------- | ----------- | ------------------------------------------------- |
| `VICE_HOST`       | `127.0.0.1` | Monitor hostname or IP address, without `ip4://`  |
| `VICE_PORT`       | `6510`      | Text monitor TCP port                             |
| `VICE_TIMEOUT_MS` | `5000`      | Timeout per handshake or command, in milliseconds |

For example, add `"env": { "VICE_PORT": "6510", "VICE_TIMEOUT_MS": "10000" }`
alongside `command` and `args`. Invalid settings fail startup with a diagnostic on
stderr. Starting the MCP does not connect to or pause VICE.

## Debugger Guidance

The server supplies LLM workflow instructions in the MCP initialization response.
They cover target identification, bounded inspection, memory banking, I/O read
side effects, checkpoint cleanup, timeout recovery, and explicit execution control.
Individual tool descriptions explain tool-specific limitations, including heuristic
backtraces, text-screen history, and raw resource values. Client support for using
server instructions varies; instructions do not replace user approval controls.

The repository's local debugger skill remains useful for its detailed C64 and 6510
references. MCP clients receive the server instructions without needing that skill
installed. After changing instructions or descriptions, run `npm run build` and
restart the MCP server in the client to load the new code and metadata.

## Tools

There are **105 tools** covering the command families in VICE manual chapter 12.
The original tools below retain their APIs. See [the full command catalog](docs/commands.md)
for the additional 87 tools, arguments, execution modes, and limitations. Aliases
such as `z`/`step` share a tool rather than being exposed twice. VICE version,
machine, and build options determine which commands are available at runtime.

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

Addresses are decimal JSON integers from 0 to 65535. `length` is a byte count from
1 to 256, defaulting to 64. Ranges cannot wrap past `$ffff`; disassembly can include
an instruction whose final bytes extend beyond the requested range. `count` ranges
from 1 to 1000 and defaults to 1. `mode` is `into` (default) or `over`. Commands use
explicit hexadecimal literals for addresses and values, so changing VICE's default
radix does not affect their meaning. Checkpoint IDs use VICE's decimal checkpoint
syntax. Unknown arguments, nulls, and invalid values are rejected.

### Text Helpers

Use options on existing tools instead of calculating character bytes manually:

- `vice_keyboard`: `{"text":"look","submit":true}` queues text plus Return in
  one command. It does not resume; call `vice_resume` when ready.
- `vice_convert`: `{"text":"Hi","encoding":"screen_codes"}` returns
  `{"encoding":"screen_codes","bytes":[8,9]}` locally, without contacting VICE.
- `vice_memory`: `format` selects `hex` (default), `petscii`, or `screen_codes`.
- `vice_memory_write`: supply `text` instead of `bytes`, with `encoding` set to
  `ascii`, `petscii` (default), or `screen_codes`.

Text conversion accepts 1-256 printable ASCII characters. C64 encodings target
the standard uppercase/graphics character set, fold letters to uppercase, and
reject unsupported glyphs. Use raw bytes for lowercase character sets, custom
graphics, control codes, or reversed screen characters. No terminator is appended.

### Breakpoints and Watchpoints

`vice_breakpoint_set` accepts an inclusive `start`/`end` range, with `end` defaulting
to `start`. `operations` defaults to `["exec"]`; use `["store"]` to break on a
write, `["load"]` on a read, or a combination such as `["load", "store"]`.
Duplicate operations and wrapping ranges are rejected. VICE returns the checkpoint
ID in its monitor output. Pass that positive integer to `vice_checkpoint_toggle`
or `vice_checkpoint_delete`; neither tool has an implicit "all checkpoints" mode.
Creating or changing a checkpoint does not resume the emulator.

```json
{ "start": 53280, "end": 53281, "operations": ["store"] }
```

This example watches writes to the C64 border and background color registers.
Call `vice_resume` to run until a breakpoint hits, then inspect registers or memory.
There are no asynchronous breakpoint notifications in this text-monitor adapter;
an inspection while the CPU is still running pauses it even if no breakpoint hit.

### Writing State

`vice_register_set` accepts `PC` (0-65535) or `A`, `X`, `Y`, `SP`, `FL` (0-255).
Names are uppercase and refer to 6502-family registers. Use `vice_register_write`
for other CPU-specific registers, with VICE validating the register and width.
`FL` writes the status flags. Assigning `PC` changes the next instruction
address without resuming execution.

`vice_memory_write` accepts 1-256 integer bytes (0-255) or encoded text and rejects writes past
`$ffff`. For example, these arguments write `LDA #$01; RTS` at `$1000`:

```json
{ "start": 4096, "bytes": [169, 1, 96] }
```

Writes use the computer's selected bank and can overwrite code or trigger hardware
I/O. They are not transactional and are not automatically restored. Memory writes,
register assignments, and checkpoint deletion carry MCP destructive-operation
annotations. Those hints are not authorization: use your MCP client's approval
controls for state-changing tools.

`vice_sidefx` with no arguments reports the setting; `{"enabled": false}` disables
monitor read side effects. This is a persistent monitor setting, not a per-call
option, and does not suppress writes or normal CPU hardware side effects.

Example agent requests:

- "Connect to VICE and show the CPU registers."
- "Read 16 bytes at screen memory address 1024."
- "Disassemble 32 bytes starting at address 4096."
- "Step into one instruction and show the registers again."
- "Break when the program writes to address 53280, then resume."
- "Disable checkpoint 2 without deleting it."
- "Show the call stack and the current text screen."
- "Resume the emulator."

### Execution and Safety

- Inspection auto-connects if necessary. Opening the monitor **pauses emulation**.
  It stays paused after inspection; use `vice_resume` to continue deliberately.
- Disconnect and shutdown do not explicitly resume emulation. They never send
  `quit`, which would terminate VICE. Connection state is not a CPU-running-state
  query, and `vice_status` does not probe whether an idle peer is still reachable.
- Memory reads/writes and disassembly use the computer address space and its
  selected bank. New breakpoints use computer addresses. Registers and stepping
  use the current monitor address space. Use `vice_device` and `vice_bank` to select
  it; the original computer-memory tools still explicitly use `C:`. The new range
  tools support the current device, labels, and explicit numeric device prefixes.
- Memory inspection respects VICE's existing `sidefx` setting. Reading I/O can
  have side effects; use `vice_sidefx` with `enabled: false` when that is inappropriate.
- Stepping changes machine state. A step-over can take arbitrarily long if a
  subroutine never returns. A timeout closes the connection but cannot undo an
  instruction or guarantee that a command did not execute. Do not blindly retry
  state-changing operations after an error.
- Resume reports that the command was sent, not a CPU-state acknowledgment. It
  closes the session because VICE does not send the usual reply prompt. A later
  inspection reconnects and pauses again.
- The expanded tools include reset, emulator shutdown, disk writes, host-file
  operations, resource changes, and trusted-script execution. `vice_quit` and
  `vice_reset` require `confirm: true`. Use your MCP client's approval controls:
  tool annotations and confirmation fields are not a security boundary.
- Host paths are interpreted by VICE, without a sandbox. Playback, label files,
  and checkpoint commands can execute monitor commands. Only use trusted files
  and clients. There is still no general immediate raw-command tool.
- Use one monitor controller at a time. Simultaneous UI commands or other monitor
  clients can change the active address space, bank, or execution state.

## Development and Tests

```sh
npm test
npm run test:typecheck
npm run build
```

The default tests use an in-process TCP monitor fixture and an in-memory MCP
transport, so they do not require VICE. They exercise fragmented prompts, concurrent
requests, reconnects, timeouts, input validation, and MCP tool errors.

With VICE's text monitor running, run:

```sh
npm run test:live
```

This builds and launches the actual stdio server, completes an MCP handshake,
lists tools, reads registers/memory/disassembly/help/side-effect state, and exercises
checkpoint creation, disabling, enabling, and deletion. It removes its temporary
checkpoint in a cleanup block and leaves existing checkpoints alone. It also reads
the backtrace, text screen, banks, radix, resources, logging state, stopwatch, and
working directory, evaluates an expression, and creates/removes a temporary label
to test symbolic memory access. **It pauses the emulator and leaves it paused**,
without writing memory/registers, stepping, or resuming. Write-tool formatting and
validation are tested with a mocked monitor, not against the live machine. The same
`VICE_*` environment variables select another endpoint. The live test is skipped
by default.

If a new connection times out even though port 6510 is listening, first disconnect
other monitor clients. VICE can also retain a stale remote-monitor session while
paused: leave the monitor/resume once in VICE's UI, then reconnect. This was needed
when testing against the local emulator. Do not automatically retry writes after
a timeout, since the previous command may already have executed.

## Architecture and Extension

- `src/vice/monitor-client.ts`: TCP connection, prompt framing, serialized command
  queue, timeout/size limits, and reconnect behavior. Independent of MCP.
- `src/server.ts`: transport-independent MCP server factory and tool catalog.
  Each tool defines its schema, validation, command construction, and result.
- `src/vice/additional-tools.ts`: the remaining command families. Shared field
  formatters generate schemas and safely serialize arguments to monitor tokens.
- `src/stdio.ts`: environment configuration, stdio transport, signal/EOF cleanup.
- `src/index.ts`: public exports for embedding the client or server.

VICE replies end in a prompt such as `(C:$e5cf) `. TCP chunks are not reply
boundaries. The first command on a new connection also produces an opening prompt,
so the client synchronizes with `registers` and ignores empty opening frames until
the register output's terminating prompt arrives. Commands are serialized because
the text protocol has no request IDs. Errors or timeouts discard the connection
to prevent late replies from being attributed to later requests. A reply buffer
is limited to 1 MiB. Raw monitor output is returned as MCP text; monitor and
connection errors are returned with `isError: true`.

To add a simple command, add a tool to `monitorTools` in `src/server.ts`, validate
its arguments, and add a protocol-level test in `test/server.test.ts`. Keep
commands narrowly scoped rather than interpolating arbitrary agent-supplied text.
Prompt-returning commands use `monitor.execute()`. `return`/`until` wait for VICE
to stop, subject to `VICE_TIMEOUT_MS`; timing out does not cancel execution or
remove temporary checkpoints. There are no background stop notifications.
Commands that can leave the monitor use `monitor.send()`: the socket closes after
delivery, so the result does not acknowledge emulator success. `monitor.assemble()`
waits for the interactive assembly prompt, sends the terminating blank line, and
waits for the regular prompt, all under one serialized operation.

To support another MCP transport, call `createViceServer(monitor)` and connect it
to a transport from the SDK. TCP to VICE and MCP transport are separate concerns.
A network-facing MCP transport should implement MCP's supported HTTP transport and
appropriate authentication, not assume raw TCP is interoperable. Its owner must
close both the server and monitor session when a client leaves. Additional CBM
MCP servers can have separate factories and launchers without changing this client.

VICE command reference: https://vice-emu.sourceforge.io/vice_12.html
