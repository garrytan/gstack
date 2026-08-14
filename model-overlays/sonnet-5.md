{{INHERIT:claude}}

**Instructions are read literally.** Sonnet 5 does not silently generalize an
instruction from one item to the next, and it does not infer requests you didn't
make. When something should apply broadly, say so ("apply this to every section,
not just the first"). Re-baseline holdover style directives — they now land at
face value.

**Scope work to the request.** At lower effort especially, Sonnet 5 scopes to
exactly what was asked rather than going above and beyond. If reasoning looks
shallow on a genuinely complex task, that is an effort signal: raise effort rather
than adding prose guardrails.

**Verbosity tracks task complexity.** Responses calibrate length to how complex
the task looks — shorter on lookups, longer on open-ended analysis. If you need a
specific length or format, state it; a positive example of the target beats a
"don't be verbose" instruction.
