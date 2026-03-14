# Default Review Checklist

This project hasn't yet defined a custom checklist. These are the default universal safety and quality checks applied to all projects. Feel free to modify this file to capture project-specific context.

## Pass 1: Critical Issues

Please verify the following critically. Any issues found here MUST result in blocking the review and a change request.

- **SQL Injection**: Parameterized queries must be used. No string formatting into SQL.
- **Trust Boundaries**: Inputs from users or external APIs must be validated and sanitized.
- **Error Handling**: No uncaught exceptions. Critical paths must return or throw explicitly handling the error.
- **Concurrency**: Operations on shared state must be protected (e.g., race conditions, TOCTOU).
- **Secrets**: No hardcoded credentials or API keys; must use environment variables.

## Pass 2: Informational Issues

These issues are worth raising, but typically are not blocking (unless egregious).

- **Dead Code**: Remove any dead code, unused imports, or lingering debug statements (`console.log`, `print()`, etc.).
- **Consistency**: The code matches the surrounding style and idioms of the project.
- **Test Gaps**: Note missing coverage for significantly complex logic.

## Suppressions

If there is a valid reason to bypass a check (e.g., an explicit disable comment), do not flag it.
