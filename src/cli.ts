#!/usr/bin/env node

if (process.argv.length === 2) {
    await import("./stdio.js");
} else if (process.argv.length === 3 && process.argv[2] === "--http") {
    await import("./http.js");
} else {
    console.error("Usage: cbm-mcp [--http]");
    process.exitCode = 1;
}
