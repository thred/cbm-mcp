# CBM MCP: VICE Monitor

[![Build](https://github.com/thred/cbm-mcp/actions/workflows/build.yml/badge.svg)](https://github.com/thred/cbm-mcp/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/github/license/thred/cbm-mcp)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)

An MCP server that lets AI agents debug Commodore software in a locally running
[VICE](https://vice-emu.sourceforge.io/) emulator, through VICE's text remote
monitor.

It runs locally over stdio or as a loopback-only shared Streamable HTTP service
with optional authentication. The unauthenticated VICE monitor should never be
exposed beyond loopback.

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

### Shared HTTP Service

Instead of starting one stdio MCP per client, run one persistent service alongside
VICE. It owns a single monitor connection shared by MCP sessions. With Node.js and
npm installed, start the published package from any directory:

```sh
npx --yes cbm-mcp@latest --http
```

The HTTP service must first be published to npm; an older published version may
not support `--http`. Pin a version instead of `latest` for reproducible setups.
Leave the command running while debugging; stop it with Ctrl+C. It does not start
VICE. In a source checkout, run `npm install`, `npm run build`, then
`npm run start:http` (or `apm run`).

The service prints its URL on stderr and listens only on `127.0.0.1:3000`. To
change the port set `CBM_MCP_HTTP_PORT` (1-65535); the existing `VICE_*`
settings also apply. Without a token, the service warns on startup: **any local
process can use its tools**, including changing VICE state and accessing files.
The debugging lease does not prevent unauthorized access. The service validates
the Host header and rejects browser-origin requests, but loopback and these
checks are not an authentication boundary.

For example, configure VS Code to use the service without authentication:

```json
{
    "servers": {
        "cbm-mcp": {
            "type": "http",
            "url": "http://127.0.0.1:3000/mcp"
        }
    }
}
```

For optional bearer authentication, set a 32-256 character URL-safe token
before starting the service:

```sh
export CBM_MCP_HTTP_TOKEN="$(openssl rand -hex 32)"
npx --yes cbm-mcp@latest --http
```

If set, the token must be nonempty and valid; every request, including session
cleanup, must include `Authorization: Bearer <token>`. Supply the token to your
MCP client using its secure configuration mechanism. In VS Code, for example:

```json
{
    "inputs": [
        {
            "type": "promptString",
            "id": "cbm-mcp-token",
            "description": "CBM MCP HTTP bearer token",
            "password": true
        }
    ],
    "servers": {
        "cbm-mcp": {
            "type": "http",
            "url": "http://127.0.0.1:3000/mcp",
            "headers": {
                "Authorization": "Bearer ${input:cbm-mcp-token}"
            }
        }
    }
}
```

Use the **HTTP configuration instead of stdio** in each client; otherwise a
stdio instance can still compete for VICE. VS Code's Copilot harness does not
forward servers requiring interactive input variables; for that harness use a
supported environment-variable reference in a portable MCP configuration
instead. See the [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration#_authentication-and-secrets).
Do not commit a token or put it in a shared configuration. Any client with the
token (or any local client when authentication is disabled) can control VICE
and request a lease takeover; use only trusted clients.
Browser-origin requests are rejected. The HTTP token does not secure VICE's
separate remote monitor.

The first session to call a VICE tool acquires the debugging lease. Other sessions
can inspect `vice_lease_status` but cannot operate VICE until the owner uses
`vice_lease_release` or a user explicitly authorizes `vice_lease_takeover` with
the current lease ID and `confirm: true`. Takeover waits for an in-flight tool
call to finish. A disconnected session retains its lease until a confirmed
takeover; neither disconnecting a client nor releasing a lease resumes VICE or
removes checkpoints and labels. These remain in VICE and must be inspected and
cleaned up deliberately. Stopping the service closes the monitor connection but
does not resume or quit the emulator. Sessions and leases are lost on service
restart. HTTP sessions are limited to 64 until explicitly closed or the service
restarts. A client can request `vice_sessions_close_others` with
`confirm: true` to close all other sessions; this does not release their lease.
Session status indicates whether the server still knows the session, not whether
its client is still alive: a client that disappears without a session DELETE
cannot be detected reliably.

If all 64 slots are occupied and no existing client is available to close other
sessions, send a `DELETE` to `/sessions` with `X-CBM-Confirm: true` and the
bearer token if configured. This explicitly closes **all** MCP sessions after pending
tools finish, but preserves the lease and VICE state. A new session must then
use a confirmed takeover of the old lease. Do not retry a timed-out cleanup
without checking the result; it may already have completed.

`vice_lease_status` includes connection state and the last monitor failure, but
cannot determine whether VICE is executing. If the handshake times out without
another monitor client, VICE may retain a stale session; a shared service cannot
guarantee recovery. Check VICE's UI before reconnecting. Never blindly retry a
timed-out state-changing command.

## Agent Skill via APM

This repository is also an [APM](https://github.com/microsoft/apm) package. It
ships the `cbm-mcp` agent skill with C64, VIC-II and 6510 reference material,
which complements the general guidance the server already provides. Install it
into a project with:

```sh
apm install thred/cbm-mcp
```

APM deploys the skill and declares the shared HTTP endpoint for supported agent
targets. APM may block MCP servers inherited from a dependency unless explicitly
trusted; if it does not configure the endpoint, add it directly in your project:

```sh
apm mcp install cbm-monitor-mcp --transport http --url http://127.0.0.1:3000/mcp
```

Then start the HTTP service with the `npx` command in
[Shared HTTP Service](#shared-http-service). APM does not install or run the npm
package or VICE. Run only one HTTP service, and remove or disable older stdio
entries so they do not compete for the VICE monitor. APM's `apm run` uses
scripts in the **current project's** `apm.yml`; installing this package as a
dependency does not add its `start` script to the consuming project.

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
