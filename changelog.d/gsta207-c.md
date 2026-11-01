**`gstack-doctor` finds the launch probe again on macOS's built-in bash (#3601).** macOS ships bash 3.2 as `/bin/bash`. Bash 3.2 ends a `$( )` at the `)` of a `case` pattern that has no leading `(`. So `bin/gstack-launch-probe.sh` failed to parse there, and the doctor reported the probe as missing. Thanks to @bokeeeey, who reported it in #3601 and proposed the fix in #3602.

### Fixed
- **`bin/gstack-launch-probe.sh`** writes the pattern with its POSIX leading `(`, which every bash version accepts.
- **A new test scans every tracked shell script** for a `case` pattern without a leading `(` inside `$( )` or `<( )`, so Linux CI catches this before it reaches a Mac. The probe test also parses the file with `/bin/bash`, which catches it when the test runs on a Mac.
