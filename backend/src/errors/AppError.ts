/**
 * An error that is safe to show to API clients. Anything that is *not* an
 * AppError is treated as unexpected and returned as a generic 500.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
