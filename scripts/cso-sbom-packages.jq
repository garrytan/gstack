# Reduce a BuildKit SPDX 2.3 SBOM to its package inventory before signing it.
# File entries (tens of thousands for Ruby or Python images) push the signed
# statement past actions/attest's 16 MiB limit; packages, their versions and
# package relationships are what CSO's release evidence relies on.
((.files // []) | map({key: .SPDXID, value: true}) | from_entries) as $files
| del(.files)
| .packages |= map(del(.hasFiles))
| .relationships |= map(select(($files[.spdxElementId] // false | not) and ($files[.relatedSpdxElement] // false | not)))
