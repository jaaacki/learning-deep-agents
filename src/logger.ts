import { tool } from 'langchain';
import type { ToolCallCounter } from './github-tools.js';

/**
 * Format a timestamp as HH:MM:SS for log output.
 */
function formatTime(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

/**
 * Wrap a LangChain tool with structured logging.
 *
 * Logs: timestamp, running tool count / limit, tool name, arguments, and duration.
 * Follows the same wrapping pattern as wrapWithCircuitBreaker.
 *
 * If a ToolCallCounter is provided, the log shows "TOOL #N/M" headroom.
 * If not, the log shows "TOOL" without a count.
 *
 * Errors are logged with context before being returned to the LLM.
 * Tool responses are NOT logged (they are too large and verbose).
 */
export function wrapWithLogging<T extends ReturnType<typeof tool>>(
  wrappedTool: T,
  counter?: ToolCallCounter,
): T {
  const originalInvoke = wrappedTool.invoke.bind(wrappedTool);

  wrappedTool.invoke = async (input: any, options?: any) => {
    const start = performance.now();
    const timestamp = formatTime(new Date());

    // Build the count label: "#7/30" if counter is available, empty otherwise
    const countLabel = counter
      ? ` #${counter.getCount() + 1}/${counter.limit}`
      : '';

    // Stringify the arguments (compact, single line)
    let argsStr: string;
    try {
      argsStr = JSON.stringify(input);
    } catch {
      argsStr = String(input);
    }

    try {
      const result = await originalInvoke(input, options);
      const durationMs = Math.round(performance.now() - start);
      console.log(
        `[${timestamp}] TOOL${countLabel} | ${wrappedTool.name} | ${argsStr} | ${durationMs}ms`,
      );
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      console.error(
        `[${timestamp}] TOOL${countLabel} | ${wrappedTool.name} | ${argsStr} | ${durationMs}ms | ERROR: ${error}`,
      );
      throw error;
    }
  };

  return wrappedTool;
}
