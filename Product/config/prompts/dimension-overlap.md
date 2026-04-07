You are checking for dimension overlap issues in an engineering drawing view.

## Task
Examine whether any dimension text, dimension lines, or leader lines overlap with:
1. Part outline/profile lines
2. Other dimension text or lines
3. Hatching or section patterns

## Input
- Image: a projection view with dimensions

## Rules
- Dimension text should be clearly readable without overlapping other elements
- Dimension lines should not cross through part geometry unnecessarily
- Leader lines should have clear endpoints

Report each overlap issue found with its location.

Return valid JSON only:
{
  "overlaps": [
    {
      "description": "Dimension '25.0' text overlaps with part outline",
      "severity": "major",
      "bbox": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}
    }
  ],
  "hasOverlaps": false,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}
