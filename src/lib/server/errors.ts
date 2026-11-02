export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function safeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number(error.status)
      : 0;
  if (status === 401 || status === 403)
    return new AppError(
      "META_ACCESS",
      "Meta rejected access. Check the server API key and model entitlement.",
      502,
    );
  if (status === 429)
    return new AppError(
      "META_LIMIT",
      "Meta usage is temporarily limited. Check quota or try again later.",
      503,
      true,
    );
  if (status === 400 || status === 413 || status === 422)
    return new AppError(
      "META_INPUT",
      "Meta could not accept this input or schema. Check the supported media and integration configuration.",
      502,
    );
  return new AppError(
    "REQUEST_FAILED",
    "The operation could not finish. Your saved work is available; retry after checking the server connection.",
    500,
    true,
  );
}
