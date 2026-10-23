import { Socket } from "node:net";

/** Connection settings for VICE's text remote monitor, not its binary monitor. */
export interface MonitorOptions {
    host?: string;
    port?: number;
    timeoutMs?: number;
}

interface PendingReply {
    resolve: (reply: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    requireOutput: boolean;
    assembly?: boolean;
}

const PROMPT = /(?:^|\r?\n)\((?:C|8|9|10|11):\$[0-9a-f]{4,8}\) ?/i;
const MAX_REPLY_BYTES = 1024 * 1024;

/**
 * Owns one TCP session. Operations are serialized because text monitor replies
 * have no request IDs. A failed request destroys the session so late bytes can
 * never be attributed to the next request. No output is written to stdout.
 */
export class MonitorClient {
    readonly host: string;
    readonly port: number;

    private readonly timeoutMs: number;

    private socket?: Socket;
    private ready = false;
    private buffer = "";
    private pending?: PendingReply;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(options: MonitorOptions = {}) {
        this.host = options.host ?? "127.0.0.1";
        this.port = options.port ?? 6510;
        this.timeoutMs = options.timeoutMs ?? 5000;

        if (!this.host.trim()) {
            throw new Error("Monitor host must not be empty.");
        }

        if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
            throw new Error("Monitor port must be an integer from 1 to 65535.");
        }

        if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2147483647) {
            throw new Error("Monitor timeout must be an integer from 1 to 2147483647 milliseconds.");
        }
    }

    get connected(): boolean {
        return this.ready && !!this.socket && !this.socket.destroyed;
    }

    /** Establish a session and consume VICE's initial prompt and register reply. */
    connect(): Promise<void> {
        return this.enqueue(() => this.open());
    }

    /** Close the socket only; this does not send quit or resume the emulator. */
    disconnect(): Promise<void> {
        return this.enqueue(async () => this.fail(new Error("Monitor disconnected.")));
    }

    /** Execute one prompt-returning command. Callers must construct safe commands. */
    execute(command: string): Promise<string> {
        if (!command.trim() || /[\r\n\0]/.test(command)) {
            return Promise.reject(new Error("Expected one nonempty monitor command without line breaks or NUL bytes."));
        }

        return this.enqueue(async () => {
            await this.open();
            return this.request(command);
        });
    }

    /** VICE's exit command resumes execution without a reply prompt. */
    resume(): Promise<void> {
        return this.send("exit");
    }

    /** Send a command that may leave the monitor; acknowledgment is TCP delivery only. */
    send(command: string): Promise<void> {
        if (!command.trim() || /[\r\n\0]/.test(command)) {
            return Promise.reject(new Error("Expected one nonempty monitor command without line breaks or NUL bytes."));
        }

        return this.enqueue(async () => {
            await this.open();
            const socket = this.socket!;
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const error = new Error("Timed out sending command to VICE.");
                    this.fail(error);
                    reject(error);
                }, this.timeoutMs);
                socket.write(`${command}\n`, (error) => {
                    clearTimeout(timer);
                    if (error) {
                        this.fail(error);
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
            this.fail(new Error("Session closed after command delivery."));
        });
    }

    /** Assemble one instruction and terminate VICE's interactive assembly mode atomically. */
    assemble(command: string): Promise<string> {
        if (!/^a\s/i.test(command) || /[\r\n\0]/.test(command)) {
            return Promise.reject(new Error("Expected a single-line assembly command."));
        }

        return this.enqueue(async () => {
            await this.open();
            const reply = this.waitForReply(false);
            this.pending!.assembly = true;
            this.socket!.write(`${command}\n`);
            return reply;
        });
    }

    private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
        const result = this.queue.then(operation);
        this.queue = result.catch(() => undefined);
        return result;
    }

    private async open(): Promise<void> {
        if (this.connected) {
            return;
        }

        const socket = new Socket();
        this.socket = socket;
        this.buffer = "";
        socket.setEncoding("utf8");
        socket.setNoDelay(true);
        socket.on("data", (chunk: string) => {
            if (this.socket === socket) {
                this.receive(chunk);
            }
        });
        socket.on("error", (error) => {
            if (this.socket === socket) {
                this.fail(error);
            }
        });
        socket.on("close", () => {
            if (this.socket === socket) {
                this.fail(new Error("VICE closed the monitor connection."));
            }
        });
        const handshake = this.waitForReply(true);
        socket.connect({ host: this.host, port: this.port }, () => socket.write("registers\n"));
        await handshake;
        this.ready = true;
    }

    private request(command: string): Promise<string> {
        const reply = this.waitForReply(false);
        this.socket!.write(`${command}\n`);
        return reply;
    }

    private waitForReply(requireOutput: boolean): Promise<string> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.fail(
                    new Error(`VICE monitor timed out after ${this.timeoutMs}
                     ms (${this.host}
                    :${this.port}
                    ).`),
                );
            }, this.timeoutMs);
            this.pending = { resolve, reject, timer, requireOutput };
        });
    }

    private receive(chunk: string): void {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > MAX_REPLY_BYTES) {
            this.fail(new Error("VICE monitor reply exceeded the 1 MiB limit."));
            return;
        }

        if (this.pending?.assembly && /(?:^|\r?\n)\.?(?:C|8|9|10|11):\$?[0-9a-f]{4,8}[ \t]*$/i.test(this.buffer)) {
            this.pending.assembly = false;
            this.socket!.write("\n");
        }

        let match: RegExpExecArray | null;
        while ((match = PROMPT.exec(this.buffer))) {
            const reply = this.buffer.slice(0, match.index).trim();
            this.buffer = this.buffer.slice(match.index + match[0].length).trimStart();
            const pending = this.pending;
            if (!pending || (pending.requireOutput && !reply)) {
                continue;
            }

            clearTimeout(pending.timer);
            this.pending = undefined;
            pending.resolve(reply);
        }
    }

    private fail(error: Error): void {
        const socket = this.socket;
        this.socket = undefined;
        this.ready = false;
        this.buffer = "";
        const pending = this.pending;
        this.pending = undefined;
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }

        socket?.destroy();
    }
}
