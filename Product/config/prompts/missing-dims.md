You are checking for missing dimensions on functional features in an engineering drawing.

## Task
1. Identify functional features in the drawing:
   - Clips/snaps (爪, スナップフィット)
   - Contact/mating surfaces (当て面, 合わせ面)
   - Bosses (ボス)
   - Ribs (リブ)
   - Holes and slots (穴, 長穴)
   - Threads (ねじ)
2. For each identified feature, check if it has associated dimensions
3. Report any features that appear to lack dimensions

## Input
- Image: projection view(s) with dimensions

## Rules
- Functional features typically require position, size, and tolerance dimensions
- A "missing" dimension means the feature is visible but has no dimension annotation
- Features fully contained within a toleranced zone may not need individual dimensions
- This is a "candidate generation" check — flag potential issues for review

Return valid JSON only:
{
  "features": [
    {
      "type": "clip",
      "description": "Snap-fit clip on right side",
      "hasDimensions": false,
      "missingDimTypes": ["width", "height"],
      "bbox": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0},
      "confidence": 0.0-1.0
    }
  ],
  "totalFeatures": 3,
  "featuresWithMissingDims": 1,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}
