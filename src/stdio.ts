import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createViceMonitorServer } from "./server.js";
import { MonitorClient } from "./vice/monitor-client.js";

/** Only this entry point chooses stdio. All diagnostics go to stderr. */
async function main(): Promise<void> {
    const monitor = new MonitorClient({
        host: process.env.VICE_HOST,
        port: process.env.VICE_PORT === undefined ? undefined : Number(process.env.VICE_PORT),
        timeoutMs: process.env.VICE_TIMEOUT_MS === undefined ? undefined : Number(process.env.VICE_TIMEOUT_MS),
    });

    const server = createViceMonitorServer(monitor);

    let closing = false;

    const shutdown = async () => {
        if (closing) {
            return;
        }

        closing = true;

        await monitor.disconnect();
        await server.close();
    };

    server.onclose = () => {
        void shutdown();
    };

    process.once("SIGINT", () => {
        void shutdown();
    });

    process.once("SIGTERM", () => {
        void shutdown();
    });

    await server.connect(new StdioServerTransport());

    process.stdin.once("end", () => {
        void shutdown();
    });
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));

    process.exitCode = 1;
});
