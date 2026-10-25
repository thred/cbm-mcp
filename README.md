# CBM MCP: VICE Monitor

[![Build](https://github.com/thred/cbm-mcp/actions/workflows/build.yml/badge.svg)](https://github.com/thred/cbm-mcp/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/github/license/thred/cbm-mcp)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)

An MCP server that lets AI agents debug Commodore software in a locally running
[VICE](https://vice-emu.sourceforge.io/) emulator, through VICE's text remote
monitor.

It runs **locally over stdio**, next to VICE. Nothing is hosted, and the
unauthenticated VICE monitor should never be exposed beyond loopback.

## What You Can Do

The server covers the command families of the
[VICE monitor](https://vice-emu.sourceforge.io/vice_12.html), so an agent can:

- **Inspect** CPU registers, memory (as hex, PETSCII or screen codes), the text
  screen, call stacks, memory banks and I/O state.
- **Disassemble and assemble** code, and annotate it with labels and comments.
- **Control execution** by stepping, running until a condition, setting
  breakpoints, watchpoints and tracepoints, and resuming or resetting the machine.
- **Modify state** by writing registers and memory, filling, moving, comparing
  and searching memory, and typing on the emulated keyboard.
- **Work with media and files** such as disk images, programs, snapshots and
  binary data, as well as VICE settings and resources.
- **Profile and trace** with CPU history and profiling data, where the VICE
  build supports it.
- **Export graphics** such as sprites and character sets as images, and capture
  screenshots.

The available commands depend on the VICE version, the emulated machine, and
build options. The server also sends debugging guidance to the agent, covering
safe inspection, memory banking, side effects and cleanup. A
[command catalog](docs/commands.md) documents the details.

## Quick Start

You need Node.js 24+ and a VICE emulator with its text remote monitor enabled.

1. Start VICE with the text monitor (the executable name depends on your
   installation and machine; do not use the binary monitor):

    ```sh
    x64sc -remotemonitor -remotemonitoraddress ip4://127.0.0.1:6510
    ```

2. Add the server to your MCP client's configuration:

    ```json
    {
        "servers": {
            "cbm-mcp": {
                "type": "stdio",
                "command": "npx",
                "args": ["--yes", "cbm-mcp@latest"]
            }
        }
    }
    ```

3. Ask your agent, for example: "Connect to VICE and show the CPU registers."

Harnesses differ in where they keep this configuration, and some use
`mcpServers` instead of `servers`. Pin a version instead of `latest` for
repeatable setups.

### Configuration

Optional environment variables, set in the client's `env` object:

| Variable          | Default     | Meaning                                           |
| ----------------- | ----------- | ------------------------------------------------- |
| `VICE_HOST`       | `127.0.0.1` | Monitor hostname or IP address, without `ip4://`  |
| `VICE_PORT`       | `6510`      | Text monitor TCP port                             |
| `VICE_TIMEOUT_MS` | `5000`      | Timeout per handshake or command, in milliseconds |

Invalid settings fail startup with a diagnostic on stderr. Starting the MCP does
not connect to or pause VICE.

## Agent Skill via APM

This repository is also an [APM](https://github.com/microsoft/apm) package. It
ships the `cbm-mcp` agent skill with C64, VIC-II and 6510 reference material,
which complements the general guidance the server already provides. Install it
into a project with:

```sh
apm install thred/cbm-mcp
```

APM deploys the skill for your configured agent targets. The MCP server entry in
[apm.yml](apm.yml) launches a local build (`dist/stdio.js`), so it only works
inside a source checkout; configure the server for other projects as described
in Quick Start.

## Safety

- Connecting to the monitor **pauses emulation**, and it stays paused until the
  agent resumes it deliberately.
- Disconnecting never quits VICE. Only one monitor client can be attached at a
  time, so use one controller at a time.
- Reading I/O can have side effects, which VICE's monitor can be told to
  suppress. Stepping and writes change machine state and are not undone
  automatically. A timeout cannot guarantee that a command did not execute, so
  state-changing operations should not be retried blindly.
- Some capabilities reset or quit the emulator, write to disks, access host files
  or run monitor scripts. Host paths are interpreted by VICE without a sandbox.
  Use your MCP client's approval controls; tool annotations and confirmation
  fields are not a security boundary, and only trusted clients and files should be
  used.

## Development

Install from source and run the checks:

```sh
npm install
npm run build
npm test
npm run test:typecheck
```

To use a checkout instead of the npm package, configure the client with
`"command": "node"` and `"args": ["/absolute/path/to/cbm-mcp/dist/cli.js"]`.
Launch the executable directly rather than through `npm start`, whose banners
would corrupt the MCP stream on stdout. `npm run dev` starts the TypeScript
sources for manual runs. Restart the server in the client after rebuilding.

The default tests use an in-process fixture instead of VICE. With VICE's text
monitor running, `npm run test:live` additionally runs read-only checks against
the real emulator. **It pauses the emulator and leaves it paused.** The live test
is skipped by default.

If a new connection times out even though the port is listening, disconnect other
monitor clients. VICE can also retain a stale session while paused: leave the
monitor or resume once in VICE's UI, then reconnect.

The source layout is small: the monitor connection (`src/vice/monitor-client.ts`)
is independent of MCP, the tools live in `src/vice/monitor-tools.ts`, the server
factory is in `src/server.ts`, and `src/cli.ts` and `src/stdio.ts` provide the
stdio executable. Other MCP transports can reuse the server factory; a
network-facing transport needs proper authentication.
