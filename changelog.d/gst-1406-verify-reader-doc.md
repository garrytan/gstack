### Fixed

- **docs/review-policy.md now says `verify` checks each merged row's reader.** Since GST-1406, `gstack-review-dispatch verify` checks every merged row's reader, label and raw text against the output collect parsed. The policy text named only the label and raw text. This is the documentation debt #4017 shipped with.
