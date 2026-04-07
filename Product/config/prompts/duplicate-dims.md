You are checking for duplicate or redundant dimensions in an engineering drawing view.

## Task
1. List all dimensions in the view
2. Identify any dimensions that specify the same measurement redundantly
3. Check for over-dimensioning (chain dims + overall that create redundancy)

## Input
- Image: a projection view with dimensions

## Rules
- A dimension is "duplicate" if the same feature is dimensioned more than once with the same value
- Over-dimensioning occurs when chain dimensions plus an overall dimension fully constrain the same geometry (one should be marked as reference)
- Reference dimensions (in parentheses) are acceptable and not duplicates

Return valid JSON only:
{
  "duplicates": [
    {
      "value": "25.0",
      "count": 2,
      "locations": [
        {"bbox": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}}
      ],
      "description": "Same 25.0mm dimension appears twice for the same feature"
    }
  ],
  "hasDuplicates": false,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}
