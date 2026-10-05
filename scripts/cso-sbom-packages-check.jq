# Accept only a package-level SPDX 2.3 document whose relationships name known elements.
.spdxVersion == "SPDX-2.3"
and (.packages | type == "array" and length > 0)
and (has("files") | not)
and (([.SPDXID, .packages[].SPDXID] | map({key: ., value: true}) | from_entries) as $known
  | all(.relationships[]; ($known[.spdxElementId] // false)
      and (($known[.relatedSpdxElement] // false) or (.relatedSpdxElement | test("^(NONE|NOASSERTION)$|^DocumentRef-")))))
