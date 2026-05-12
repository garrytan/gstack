/** Thrown instead of process.exit() inside try/finally blocks so the finally
 *  cleanup runs before the process terminates. The top-level catch in main()
 *  converts ExitError to the matching process.exit(code) call. */
export class ExitError extends Error {
  code: number;
  constructor(code: number, message?: string) {
    super(message ?? `exit ${code}`);
    this.name = "ExitError";
    this.code = code;
  }
}
