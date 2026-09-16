export class ValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class BackendError extends Error {
  statusCode: number;
  backendBody?: unknown;
  constructor(message: string, statusCode = 502, backendBody?: unknown) {
    super(message);
    this.name = "BackendError";
    this.statusCode = statusCode;
    this.backendBody = backendBody;
  }
}
