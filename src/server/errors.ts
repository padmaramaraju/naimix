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

/** A caller-facing auth failure: missing/invalid/expired session token, a
 * token issued by the wrong auth provider for the gateway being called, or
 * a login attempt that was rejected. Deliberately distinct from
 * ValidationError (bad request shape) and BackendError (the real backend
 * failed) -- see AUTH_DESIGN_NOTES.md. */
export class AuthError extends Error {
  statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
