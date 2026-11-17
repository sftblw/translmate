export function assertPageAgentStartResponse<T>(response: T): T {
  if (isErrorResponse(response)) {
    throw new Error(response.error);
  }

  if (!response) {
    throw new Error("Page agent did not return a startup response.");
  }

  return response;
}

function isErrorResponse(response: unknown): response is { error: string } {
  return Boolean(
    response && typeof response === "object" && typeof (response as { error?: unknown }).error === "string",
  );
}
