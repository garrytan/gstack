You are checking revision consistency in an engineering drawing.

## Task
1. Find the revision/version in the title block (e.g., "Rev. C", "版数: 3", "ECN: 005")
2. Find the revision table entries (改訂欄)
3. Check: does the latest revision symbol in the revision table match the title block version?
4. Check: are revision symbols sequential (A->B->C or 1->2->3)?

## Input
- Image: full drawing page (or title block + revision table crops)

## Rules
- The revision table may use letters (A, B, C) or numbers (1, 2, 3)
- The latest entry is typically the last row in the revision table
- Title block revision should match the MAXIMUM revision in the table

Return valid JSON only:
{
  "titleBlockRevision": "C",
  "revisionTableEntries": [
    {"symbol": "A", "date": "2024-01-15", "description": "Initial release"}
  ],
  "latestRevisionMatches": true,
  "isSequential": true,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}
