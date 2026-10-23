import { McpUtils } from "./mcp-utils.js";
import { MonitorClient } from "./vice/monitor-client.js";
import { ViceMonitorTools } from "./vice/monitor-tools.js";

const DEBUGGER_INSTRUCTIONS = `Debug VICE through its text monitor. Start with vice_status (socket state only), vice_registers, and small reads. Use the current PC for disassembly. Inspection pauses emulation; reuse connections. Confirm machine, device/CPU, bank, and video model before hardware assumptions; use vice_help for command details.

JSON integers are decimal (53280 = $d020); prefix numbers in expressions. Length counts bytes; range ends are inclusive. vice_memory/disassemble target C:, while registers/stepping use the current device. Distinguish CPU-visible memory, RAM, and video memory; query vice_bank before choosing a view. Query vice_sidefx before I/O reads; preserve and restore its setting.

Prefer testable hypotheses, bounded reads/steps, and temporary checkpoints over patches. Stepping changes state; step-over/run-until can stall. No asynchronous breakpoint notifications: inspection itself can stop execution. Remove only your own checkpoints/labels.

Establish user intent before mutations, execution control, or file operations; preserve affected state. Never blindly retry a timed-out mutation. Command delivery is not success acknowledgment. An expected read returning only 'Command completed.' has no usable data; try one read-only reconnect, then ask about VICE's UI if unresponsive.

vice_resume sends exit and disconnects; another inspection pauses again. Disconnect does not resume or quit. Keep emulation running when no active debugging need requires a pause; resume after inspection unless the user asked to leave it paused. Longer pauses are fine when justified. Report facts versus hypotheses, changes/cleanup, and final execution state.`;

/** Creates the text-monitor MCP server without choosing a transport. */
export function createViceMonitorServer(monitor = new MonitorClient()) {
    return McpUtils.createToolServer("cbm-vice-text-monitor", new ViceMonitorTools(monitor), {
        instructions: DEBUGGER_INSTRUCTIONS,
        isError: (text) => /(?:^|\n)\s*(?:ERROR\b|Unknown command\b)/i.test(text),
    });
}

/** @deprecated Use createViceMonitorServer for the text-monitor MCP. */
export const createViceServer = createViceMonitorServer;
