# CBM MCP: VICE Monitor

[![Build](https://github.com/thred/cbm-mcp/actions/workflows/build.yml/badge.svg)](https://github.com/thred/cbm-mcp/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/github/license/thred/cbm-mcp)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)

CBM MCP lets AI agents use the text monitor of a locally running
[VICE](https://vice-emu.sourceforge.io/) emulator. The recommended setup is a
shared HTTP service: VICE accepts one monitor connection, so separate stdio
servers can conflict or leave connections stuck.

## Quick Start

You need Node.js 24+ and VICE with its text remote monitor enabled.

1. Start VICE with the text monitor (the executable name depends on your
   installation):

   ```sh
   x64sc -remotemonitor -remotemonitoraddress ip4://127.0.0.1:6510
   ```

2. For the recommended [APM](https://github.com/microsoft/apm) setup, install
   the project in your agent workspace:

   ```sh
   apm install thred/cbm-mcp
   ```

   APM configures the MCP endpoint and deploys the CBM MCP agent skill. Start
   the HTTP service separately and leave it running while using VICE:

   ```sh
   npx --yes cbm-mcp@latest --http
   ```

3. If you are not using APM, configure your MCP client to connect to:

   ```text
   http://127.0.0.1:3000/mcp
   ```

The HTTP service listens on `127.0.0.1:3000` by default. Set
`CBM_MCP_HTTP_PORT` to change the port. The service does not start VICE.
Keep it on loopback and use trusted clients; set `CBM_MCP_HTTP_TOKEN` to
require bearer authentication.

### Shared HTTP Service

The HTTP service shares one VICE monitor connection across MCP sessions. Run
only one service for a VICE instance, and remove any stdio configuration that
could connect to the same emulator. Connecting to VICE pauses emulation; resume
it deliberately when you are ready.

### stdio (not recommended)

stdio is supported, but each MCP client starts its own server. Since VICE only
accepts one monitor connection, clients can interfere with one another or
encounter connection issues. For a single-client setup, run
`npx --yes cbm-mcp@latest` and configure the client to launch that command over
stdio.

## More Information

- [VICE monitor commands](docs/commands.md)
- [Offline and live C64 analysis](docs/analysis-engine.md)

## Development

Install dependencies and run the build and tests:

```sh
npm install
npm run build
npm test
npm run test:typecheck
```

For VICE-backed checks, start VICE with its text monitor and run
`npm run test:live`. This pauses the emulator and leaves it paused. The live
test is skipped by default.
