---
important: blocker
---
**The job-log tree.json step's recommended sleep is long enough for real runners.** When a repository's artifact storage is full, gstack reads `tree.json` from one log line the named step prints. The docs recommended `sleep 2` after that line, but runners stamp output up to a second or more after it is printed and the jobs API cuts step times to the second, so a Ubicloud run (44845717681) was refused as `CI_CARRY_TREE_LOG_UNBOUND` and the carry fell back to running tests locally. The docs, the troubleshooting fix and the refusal's fix line now say `sleep 5` after the line, and a test binds the documented sleeps to every sub-second offset with up to 2.5 s of stamping delay (GST-3339).
