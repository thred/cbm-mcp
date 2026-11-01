import { McpUtils, type ToolServerOptions } from "./mcp-utils.js";
import { MonitorClient } from "./vice/monitor-client.js";
import { ViceMonitorTools } from "./vice/monitor-tools.js";
import { createC64AnalysisTools } from "./analysis-engine/c64-analysis-tools.js";

const DEBUGGER_INSTRUCTIONS = `Start with vice_status (socket state only) and vice_registers. For program analysis prefer vice_analysis_capture and snapshot queries; vice_analysis_status reports existing identity. Use the current PC as a candidate, not necessarily a routine start. Use monitor disassembly for live CPU-visible or drive views. Inspection pauses emulation; reuse connections. Confirm machine, device/CPU, bank and video model before hardware assumptions.

JSON integers are decimal (53280 = $d020); prefix monitor expressions. Length counts bytes; range ends are inclusive. vice_memory/disassemble target C:; registers/stepping use the current device. Distinguish CPU, RAM and video views; query vice_bank before choosing a view. Query vice_sidefx before I/O reads; restore its setting.

Prefer bounded reads/steps and temporary checkpoints over patches. Stepping changes state; run-until can stall. No asynchronous breakpoint notifications. Remove only your own checkpoints/labels.

Establish intent before mutations, execution control or file operations; preserve state. Never blindly retry a timed-out mutation. Command delivery is not acknowledgment. A read returning only 'Command completed.' has no usable data; try one read-only reconnect, then ask about VICE's UI.

vice_resume sends exit and disconnects; another inspection pauses again. Disconnect does not resume or quit. Keep emulation running when no active debugging need requires a pause. Longer pauses are fine when justified. Report changes, cleanup and final execution state.`;

/** Creates the text-monitor MCP server without choosing a transport. */
export function createViceMonitorServer(
    monitor = new MonitorClient(),
    options: Pick<ToolServerOptions, "additionalTools" | "runTool"> = {},
) {
    return McpUtils.createToolServer("cbm-vice-text-monitor", new ViceMonitorTools(monitor), {
        ...options,
        additionalTools: [...createC64AnalysisTools(monitor), ...(options.additionalTools ?? [])],
        instructions:
            DEBUGGER_INSTRUCTIONS +
            "\n\nSee vice_analysis_regions for unused-range guidance. Capture needs consent; analysis is session-local. A new programId without snapshotId replaces analysis; save prior work first. Save/export require file consent." +
            (options.runTool
                ? "\n\nShared HTTP mode: the first monitor tool acquires the session lease. Use vice_lease_status, vice_lease_release, or confirmed vice_lease_takeover. Do not take over without user consent."
                : ""),
        isError: (text) => /(?:^|\n)\s*(?:ERROR\b|Unknown command\b)/i.test(text),
    });
}

/** @deprecated Use createViceMonitorServer for the text-monitor MCP. */
export const createViceServer = createViceMonitorServer;
