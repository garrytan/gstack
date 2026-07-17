/** Create an operational error whose stable code can cross the CLI boundary. */
export function errorWithCode(message, code, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}
