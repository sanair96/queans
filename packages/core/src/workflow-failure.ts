export interface WorkflowFailurePayload {
  message: string;
  name?: string;
  stack?: string;
}

export function serializeWorkflowFailure(error: unknown): WorkflowFailurePayload {
  if (error instanceof Error) {
    const payload: WorkflowFailurePayload = {
      message: error.message || "Workflow failed"
    };
    if (error.name) {
      payload.name = error.name;
    }
    if (error.stack) {
      payload.stack = error.stack;
    }
    return payload;
  }

  if (typeof error === "string") {
    return { message: error };
  }

  return { message: "Workflow failed with a non-error value" };
}
