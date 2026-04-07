You are checking whether outermost (overall) dimensions are present in an engineering drawing view.

## Task
1. Identify the overall bounding extents of the part in this view
2. Check whether there is an overall width dimension
3. Check whether there is an overall height dimension
4. Report any missing outermost dimensions

## Input
- Image: a projection view with dimensions

## Rules
- Overall/outermost dimensions span the full extent of the part
- They are typically the outermost dimension lines
- Both horizontal (width) and vertical (height) overall dimensions should be present
- For simple parts, depth may also need an overall dimension in a side view

Return valid JSON only:
{
  "hasOverallWidth": true,
  "hasOverallHeight": true,
  "overallWidthValue": "120.0",
  "overallHeightValue": "80.0",
  "missingDirections": [],
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}
