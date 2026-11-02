### Fixed

- **A test lane's scratch folder no longer breaks the /ship review bind.** When an untracked `.review-units-test-*/` folder appeared or vanished while reviewers ran, Step 11.5 saw a different tree and the only repair was rerunning Steps 9 to 11.5 (about 20M tokens). Review records now fingerprint with `gstack-wtree --review`, which leaves out root dot-folders that hold no tracked file. `.github/` and `.gstack/` always count, and any change to a tracked file still breaks the bind. The pregate, test evidence and every other caller keep the whole tree. (GST-985)
