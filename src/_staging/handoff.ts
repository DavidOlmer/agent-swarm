{
  "code": "
interface HandoffContract {
  taskDescription: string;
  constraints: string[];
  inputContext: Record<string, any>;
  successCriteria: string[];
  previousOutputs: { agentType: string; output: any; score: number }[];
}

function createHandoff(task: string, previousResults: { agentType: string; output: any; score: number }[]): HandoffContract {
  return {
    taskDescription: task,
    constraints: [],
    inputContext: {},
    successCriteria: [],
    previousOutputs: previousResults,
  };
}

function validateHandoff(contract: HandoffContract): boolean {
  if (
    !contract.taskDescription ||
    !contract.constraints ||
    !contract.inputContext ||
    !contract.successCriteria ||
    !contract.previousOutputs
  ) {
    return false;
  }
  return true;
}

function formatHandoffPrompt(contract: HandoffContract): string {
  let prompt = `Task: ${contract.taskDescription}\n`;
  prompt += `Constraints:\n${contract.constraints.map((c) => `- ${c}`).join('\n')}\n`;
  prompt += `Input Context:\n${JSON.stringify(contract.inputContext, null, 2)}\n