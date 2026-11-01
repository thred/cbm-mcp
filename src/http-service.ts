import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpTool } from "./mcp-utils.js";
import { createViceMonitorServer } from "./server.js";
import { MonitorClient } from "./vice/monitor-client.js";

interface LeaseOwner {
    sessionId: string;
    leaseId: string;
    acquiredAt: string;
}

class SharedLease {
    private owner?: LeaseOwner;
    private readonly active = new Set<string>();
    private queue: Promise<void> = Promise.resolve();

    constructor(private readonly monitor: MonitorClient) {}

    addSession(id: string): void {
        this.active.add(id);
    }

    removeSession(id: string): void {
        this.active.delete(id);
    }

    run<T>(sessionId: string, operation: () => Promise<T>, acquire = false): Promise<T> {
        return this.runSystem(async () => {
            if (!this.active.has(sessionId)) {
                throw new Error("MCP session has closed; start a new session and check the lease.");
            }
            if (acquire) {
                if (!this.owner) {
                    this.owner = { sessionId, leaseId: randomUUID(), acquiredAt: new Date().toISOString() };
                } else if (this.owner.sessionId !== sessionId) {
                    throw new Error(
                        `VICE is leased by another session (${this.owner.leaseId}). Use vice_lease_status.`,
                    );
                }
            }
            return operation();
        });
    }

    runSystem<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation);
        this.queue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    status(sessionId: string): string {
        return JSON.stringify({
            monitor: {
                host: this.monitor.host,
                port: this.monitor.port,
                connected: this.monitor.connected,
                lastFailure: this.monitor.lastFailure ?? null,
            },
            lease: this.owner
                ? {
                      id: this.owner.leaseId,
                      acquiredAt: this.owner.acquiredAt,
                      yours: this.owner.sessionId === sessionId,
                      ownerSessionKnown: this.active.has(this.owner.sessionId),
                  }
                : null,
            executionState: "unknown",
        });
    }

    release(sessionId: string): string {
        if (!this.owner || this.owner.sessionId !== sessionId) {
            throw new Error("Only the current lease owner can release it.");
        }
        this.owner = undefined;
        return "Lease released. VICE connection and execution state were not changed.";
    }

    takeover(sessionId: string, expectedId: unknown, confirm: unknown): string {
        if (confirm !== true || typeof expectedId !== "string" || !expectedId) {
            throw new Error("Provide the current leaseId and confirm=true to take over.");
        }
        if (!this.owner || this.owner.leaseId !== expectedId) {
            throw new Error("Lease changed or no longer exists; inspect vice_lease_status again.");
        }
        this.owner = { sessionId, leaseId: randomUUID(), acquiredAt: new Date().toISOString() };
        return "Lease taken over. VICE connection, execution state, checkpoints, and labels were not changed.";
    }

    async drain(): Promise<void> {
        await this.queue;
    }
}

function leaseTools(lease: SharedLease, sessionId: string, closeOtherSessions: () => Promise<number>): McpTool[] {
    return [
        {
            name: "vice_lease_status",
            description: "Inspect shared VICE connection and lease without contacting VICE.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
            run: async () => lease.status(sessionId),
        },
        {
            name: "vice_lease_release",
            description: "Release this session's lease without disconnecting or resuming VICE.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            run: async () => lease.release(sessionId),
        },
        {
            name: "vice_lease_takeover",
            description: "Take over an identified lease with explicit user consent; does not resume or modify VICE.",
            inputSchema: {
                type: "object",
                properties: {
                    leaseId: { type: "string", minLength: 1, maxLength: 36 },
                    confirm: { type: "boolean" },
                },
                required: ["leaseId", "confirm"],
                additionalProperties: false,
            },
            run: async (args) => lease.takeover(sessionId, args.leaseId, args.confirm),
        },
        {
            name: "vice_sessions_close_others",
            description:
                "Close all other HTTP sessions with user consent. Their lease and VICE state remain unchanged.",
            inputSchema: {
                type: "object",
                properties: { confirm: { type: "boolean" } },
                required: ["confirm"],
                additionalProperties: false,
            },
            run: async (args) => {
                if (args.confirm !== true) {
                    throw new Error("confirm=true is required to close other MCP sessions.");
                }
                const closed = await closeOtherSessions();
                return JSON.stringify({ closed, note: "The lease and VICE state were not changed." });
            },
        },
    ];
}

export interface HttpServiceOptions {
    token?: string;
    port?: number;
    monitor?: MonitorClient;
}

export interface HttpService {
    server: HttpServer;
    port: number;
    close(): Promise<void>;
}

/** Start a loopback-only MCP service with one shared VICE client. */
export async function startHttpService(options: HttpServiceOptions): Promise<HttpService> {
    if (options.token !== undefined && !/^[A-Za-z0-9._~-]{32,256}$/.test(options.token)) {
        throw new Error("CBM_MCP_HTTP_TOKEN must contain 32-256 URL-safe characters.");
    }
    const port = options.port ?? 3000;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("HTTP port must be an integer from 0 to 65535.");
    }
    const monitor = options.monitor ?? new MonitorClient();
    const lease = new SharedLease(monitor);
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    let initializing = 0;
    let closing = false;
    const token = options.token === undefined ? undefined : Buffer.from(`Bearer ${options.token}`);

    const respond = (res: ServerResponse, status: number, message: string) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
    };

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const actualPort = server.address();
        if (!actualPort || typeof actualPort === "string" || req.headers.host !== `127.0.0.1:${actualPort.port}`) {
            respond(res, 403, "Invalid Host header.");
            return;
        }
        if (req.headers.origin !== undefined) {
            respond(res, 403, "Browser-origin requests are not supported.");
            return;
        }
        if (token) {
            const authorization = Buffer.from(req.headers.authorization ?? "");
            if (authorization.length !== token.length || !timingSafeEqual(authorization, token)) {
                respond(res, 401, "Bearer token required.");
                return;
            }
        }
        if (closing) {
            respond(res, 503, "Service is shutting down.");
            return;
        }
        if (req.url === "/sessions" && req.method === "DELETE") {
            if (req.headers["x-cbm-confirm"] !== "true") {
                respond(res, 400, "X-CBM-Confirm: true is required to close all sessions.");
                return;
            }
            const count = await lease.runSystem(async () => {
                const transports = [...sessions.values()];
                await Promise.all(transports.map((transport) => transport.close()));
                return transports.length;
            });
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify({ closed: count, note: "The lease and VICE state were not changed." }));
            return;
        }
        if (req.url !== "/mcp") {
            respond(res, 404, "Not found.");
            return;
        }
        const sessionId = req.headers["mcp-session-id"];
        if (typeof sessionId === "string") {
            const transport = sessions.get(sessionId);
            if (!transport) {
                respond(res, 404, "MCP session not found.");
                return;
            }
            await transport.handleRequest(req, res);
            return;
        }
        if (req.method !== "POST") {
            respond(res, 400, "MCP session ID required.");
            return;
        }
        if (sessions.size + initializing >= 64) {
            respond(res, 503, "Maximum MCP sessions reached.");
            return;
        }

        initializing++;
        const id = randomUUID();
        let initialized = false;
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => id,
            enableJsonResponse: true,
            maxRequestBodySize: 1024 * 1024,
            onsessioninitialized: () => {
                initialized = true;
                sessions.set(id, transport);
                lease.addSession(id);
            },
        });
        const mcp = createViceMonitorServer(monitor, {
            additionalTools: leaseTools(lease, id, async () => {
                const others = [...sessions.entries()].filter(([otherId]) => otherId !== id);
                await Promise.all(others.map(([, other]) => other.close()));
                return others.length;
            }),
            runTool: (name, run) =>
                lease.run(
                    id,
                    async () => {
                        const result = await run();
                        if (name === "vice_analysis_capture") {
                            lease.release(id);
                        }
                        return result;
                    },
                    name !== "vice_status" &&
                        !name.startsWith("vice_lease_") &&
                        (!name.startsWith("vice_analysis_") || name === "vice_analysis_capture") &&
                        name !== "vice_sessions_close_others",
                ),
        });
        mcp.onclose = () => {
            sessions.delete(id);
            lease.removeSession(id);
        };
        try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
        } finally {
            initializing--;
            if (!initialized) {
                await mcp.close();
            }
        }
    };

    const server = createServer((req, res) => {
        void handle(req, res).catch((error: unknown) => {
            console.error(`HTTP MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) {
                respond(res, 500, "Internal server error.");
            } else {
                res.destroy();
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("HTTP service did not obtain a TCP address.");
    }
    if (!token) {
        console.error(
            "WARNING: HTTP authentication is disabled. Any local process can control VICE and access monitor tools.",
        );
    }
    return {
        server,
        port: address.port,
        async close() {
            closing = true;
            await Promise.all([...sessions.values()].map((transport) => transport.close()));
            await lease.drain();
            await monitor.disconnect();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}
