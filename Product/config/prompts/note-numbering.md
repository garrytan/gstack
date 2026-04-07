You are checking note numbering continuity in an engineering drawing.

## Task
Identify all numbered notes in the drawing and check:
1. Are note numbers sequential (1, 2, 3, ... with no gaps)?
2. Are there any duplicate note numbers?
3. Are there any skipped numbers?

## Input
- Image: the notes area of the drawing

## Rules
- Notes are typically prefixed with a number or circled number
- Both Arabic numerals (1, 2, 3) and circled numbers count
- Notes may span multiple lines — only count the note number, not sub-items

Return valid JSON only:
{
  "notes": [
    {"number": 1, "text": "brief content preview", "bbox": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}}
  ],
  "isSequential": true,
  "gaps": [],
  "duplicates": [],
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}
