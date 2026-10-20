import { formatSubagentLabel } from "../ui/agent-label.js";
import { getFinalOutput, isResultSuccess, type SingleResult } from "../types.js";

export function parallelResultContent(results: SingleResult[]) {
  const successCount = results.filter(isResultSuccess).length;
  const summaries = results.map((result) => {
    const succeeded = isResultSuccess(result);
    const output = succeeded
      ? getFinalOutput(result.messages, result.finalOutput)
      : result.errorMessage || result.stderr || getFinalOutput(result.messages, result.finalOutput);
    const label = formatSubagentLabel(result);
    const identity = result.name || result.agent || result.intelligence ? `[${label}]` : label;
    const status = succeeded ? "completed" : result.exitCode === -1 ? "unfinished" : "failed";
    return `${identity} ${status}: ${output || "(no output)"}`;
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
      },
    ],
    ...(successCount === results.length ? {} : { isError: true }),
  };
}
