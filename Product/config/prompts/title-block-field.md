You are inspecting an engineering drawing's title block.

## Task
Check whether the "{{fieldNameJa}}" ({{fieldName}}) field is present, filled in, and legible.

## Input
- Image: cropped title block region of the drawing

## Rules
- The field must contain actual content, not just a label or empty cell
- If the field exists but is blank or illegible, report fieldFound: false
- Report the exact text value if readable
- Common field locations in Japanese engineering drawings:
  - 図番 (drawing_number): usually top or center of title block
  - 品名 (part_name): adjacent to drawing number
  - 版数 (revision): often top-right corner or revision column
  - 材質 (material): material specification row
  - 色 (color): may be in title block or in notes

Return valid JSON only:
{
  "fieldFound": true,
  "fieldValue": "extracted text or null",
  "confidence": 0.0-1.0,
  "bbox": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0},
  "reasoning": "brief explanation"
}
