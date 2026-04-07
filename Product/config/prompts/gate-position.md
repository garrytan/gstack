You are checking gate position relative to stress-critical areas in a molded part drawing.

## Task
1. Identify the gate position (ゲート位置) from annotations or notes
2. Identify stress-critical areas:
   - Thin sections near load-bearing features
   - Areas near snap-fit clips or hinges
   - Structural ribs and bosses
   - Areas subject to repeated flexing
3. Assess whether the gate position could create weld lines in stress-critical areas
4. Check if any notes address weld line concerns

## Input
- Image: projection view(s) with gate annotations and structural features

## Rules
- Weld lines form where flow fronts meet — opposite the gate on the flow path
- Weld lines in stress-critical areas reduce structural integrity
- If a note addresses weld line management, that counts as "cared for"
- This is a risk assessment, not a definitive judgment — flag for review when uncertain

Return valid JSON only:
{
  "gatePosition": {"description": "Pin gate on bottom face", "bbox": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}},
  "stressCriticalAreas": [
    {"description": "Snap-fit clip base", "bbox": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}, "riskLevel": "high"}
  ],
  "potentialWeldLineRisk": true,
  "weldLineCareNoted": false,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation of flow path analysis"
}
