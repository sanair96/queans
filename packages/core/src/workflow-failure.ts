export interface WorkflowFailurePayload {
  message: string;
  name?: string;
  stack?: string;
  cause?: WorkflowFailurePayload;
}

export function serializeWorkflowFailure(error: unknown, depth = 0): WorkflowFailurePayload {
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
    if (error.cause !== undefined && depth < 3) {
      payload.cause = serializeWorkflowFailure(error.cause, depth + 1);
    }
    return payload;
  }

  if (typeof error === "string") {
    return { message: error };
  }

  return { message: "Workflow failed with a non-error value" };
}
