---
important: blocker
---
- **`gstack-ci-carry` and `gstack-pregate --from-run` can verify a GitHub Actions run again after it has been rerun.** Reading a rerun attempt's job list 100 jobs at a time could take GitHub about 11 seconds for a large workflow (86 jobs in gbrain's Test runs), and a proxy that cuts requests off at about 10 seconds answered 502. So any run whose newest attempt was a rerun failed with `api_error`, and /ship fell back to running the whole suite locally, even after a green rerun of a known flake. The job list is now read 50 per page, every page, and a server error (5xx) reads the whole list once more at 25 per page. A page that still fails leaves the run unverified (`api_error`), as before: a partial job list never counts. (GST-2215)
