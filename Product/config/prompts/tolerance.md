You are checking tolerance notation consistency in an engineering drawing.

## Task
1. Find the general tolerance specification (often near the title block)
   - Examples: "JIS B 0405-m", "ISO 2768-m", "普通許容差 中級"
2. Check if a tolerance class table is present with appropriate slash/strikethrough marks
3. Verify that individually toleranced dimensions use consistent notation format

## Input
- Image: full drawing or title block + notes area

## Rules
- General tolerance should reference a standard (JIS, ISO) or specify tolerance grades
- Slash marks (斜線) in tolerance tables indicate which grades apply
- Missing general tolerance is a significant finding
- Inconsistent notation between individual tolerances is a finding

Return valid JSON only:
{
  "generalToleranceFound": true,
  "generalToleranceValue": "JIS B 0405-m",
  "toleranceTablePresent": true,
  "slashMarksConsistent": true,
  "issues": [],
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}
