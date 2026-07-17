# Live run records

Live one-shot JSON evidence is written here. No successful live run has been recorded merely because this directory exists; consult each file's top-level `status`, `harness_version`, fixture manifest hash, and `claim`.

`2026-07-17T03-26-33-114Z-22457bba.json` is the immutable failed v1 slash-invocation result. Its SHA-256 is `aa40a533a9677cf79ccb85b84297177a58296eee6c66cc9977493138435eb391`. It must remain unfavorable evidence and must not be automatically rerun or relabeled after v2 harness fixes.

`2026-07-17T04-09-01-809Z-3d23a270.json` is the immutable failed v2 `$skill` result. Its SHA-256 is `7ab15ea575cb9a634b7d00212dd9d74902b1188281ae6a503a32ccf382facbf5`. All dispatchers activated and QA passed, but the other three fixtures were rejected by the v2 classifier's read-only-Git sandbox-warning defect. It must not be rerun or relabeled after the v3 classifier fix.

Live v3 has **not run**, so there is no v3 JSON artifact and no passing live
record in this directory. The v3 offline harness is green at 18 pass / 0 fail
and 111 assertions; that unit evidence does not belong in `runs/` and does not
upgrade either immutable failed result.
