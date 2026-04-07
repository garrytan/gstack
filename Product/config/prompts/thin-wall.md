You are checking for extreme thin-wall sections and long slots in a molded part drawing.

## Task
1. Identify areas with potentially extreme thin walls:
   - Sections that appear significantly thinner than the nominal wall thickness
   - Areas where two features create a narrow gap
2. Identify long slots or narrow openings:
   - Slot length-to-width ratio > 3:1
   - Narrow through-holes
3. Check if noted/dimensioned sections address manufacturing concerns:
   - Draft angle annotations
   - Minimum wall thickness notes
   - Ejection or filling notes

## Input
- Image: projection view(s) showing cross-sections or detail views

## Rules
- For injection-molded parts, thin walls < 0.8mm are concerning
- Long slots with high aspect ratios are prone to warpage
- If notes or dimensions address the concern, it's "cared for"
- Flag potential issues for review — don't require certainty

Return valid JSON only:
{
  "thinWallAreas": [
    {
      "description": "Wall between boss and outer surface",
      "estimatedThickness": "0.6mm",
      "bbox": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0},
      "isCaredFor": false,
      "confidence": 0.0-1.0
    }
  ],
  "longSlots": [
    {
      "description": "Ventilation slot on top surface",
      "estimatedRatio": "5:1",
      "bbox": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0},
      "isCaredFor": false,
      "confidence": 0.0-1.0
    }
  ],
  "hasUnaddressedConcerns": false,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}
