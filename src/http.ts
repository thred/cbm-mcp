import { startHttpService } from "./http-service.js";
import { MonitorClient } from "./vice/monitor-client.js";

async function main(): Promise<void> {
    const monitor = new MonitorClient({
        host: process.env.VICE_HOST,
        port: process.env.VICE_PORT === undefined ? undefined : Number(process.env.VICE_PORT),
        timeoutMs: process.env.VICE_TIMEOUT_MS === undefined ? undefined : Number(process.env.VICE_TIMEOUT_MS),
    });
    const service = await startHttpService({
        token: process.env.CBM_MCP_HTTP_TOKEN,
        port: process.env.CBM_MCP_HTTP_PORT === undefined ? undefined : Number(process.env.CBM_MCP_HTTP_PORT),
        monitor,
    });
    console.error(`CBM MCP listening at http://127.0.0.1:${service.port}/mcp`);
    let closing = false;
    const shutdown = () => {
        if (closing) {
            return;
        }
        closing = true;
        void service.close().catch((error: unknown) => {
            console.error(`HTTP service shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
