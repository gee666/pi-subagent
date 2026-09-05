import {
  type DelegationMode,
  type SingleResult,
  type SubagentDetails,
  buildLiveSubagentDetails,
  buildSubagentDetails,
} from "../types.js";

export function makeDetailsFactory(projectAgentsDir: string | null, delegationMode: DelegationMode) {
  return (mode: "single" | "parallel") => {
    const makeDetails = (results: SingleResult[]): SubagentDetails =>
      buildSubagentDetails(mode, delegationMode, projectAgentsDir, results);
    makeDetails.live = (results: SingleResult[]): SubagentDetails =>
      buildLiveSubagentDetails(mode, delegationMode, projectAgentsDir, results);
    return makeDetails;
  };
}
