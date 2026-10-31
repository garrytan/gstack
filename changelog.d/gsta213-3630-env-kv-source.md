**The secrets check no longer flags Python and Dart type names and variable reads as credentials (#3630).** A Python parameter like `session: HttpSession,` failed `gstack-pregate` as MEDIUM env.kv. Secrets findings can't be downgraded, so /ship wrote no receipt, and the only workaround was a file-wide allowlist entry. Dart's `'password': request.password,` and a React key like `key={item.id ?? index}` failed the same way. Reported by @dgrant in #3630. Approaches came from #3605 (@adam-balazs) and #3418/#3419 (@hbarney).

### Fixed
- **`lib/redact-patterns.ts`:** env.kv's source-syntax exemption (#3048) now covers `.dart`, `.py` and `.pyi` files as well as TypeScript. These languages have no unquoted string literal, so a bare name after `:` is a name. A JSX brace may join names with `??`, `||` or `&&` as well as `+`. Each case still reports when it is not code:
  - a quoted value;
  - a value that is not an identifier chain;
  - an annotation with a literal default (`api_token: AuthToken = "<secret>"`, now caught in TypeScript too);
  - a `password:` line inside a Dart or Python `'''`/`"""` string, where escaped quotes don't close the string and a delimiter inside a comment or a one-line string opens nothing;
  - a `password: <value>` pair inside a one-line string, in any of these languages;
  - the same lines in `.env` or YAML files.

  Python's `=` forms (`password=request.password`) still report.
- **`lib/pregate/checks/secrets.ts`:** a changed Python or Dart file is scanned whole, and only findings on its added lines count. A line added inside an existing triple-quoted string is still read as a literal. Its row gives the file's line number. A file over 4 MiB, or one that can't be read, has its added lines scanned without the exemption.
- **`bin/gstack-redact-prepush`:** the pre-push hook sees only added lines, so it scans Python and Dart lines without the exemption; a `password:` line added inside an existing triple-quoted string still warns.
- **`lib/pregate/allowlist.ts`:** a pattern entry that names a finding by id and path but doesn't match prints a row saying so. Patterns are matched from where the flagged value starts, so the issue's `session: HttpSession` entry never matched. Before this change, that miss was silent.
- **`docs/pregate.md`:** explains where a pattern is matched and how Python and Dart source is read.
