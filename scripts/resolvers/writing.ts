/**
 * Writing skill resolvers — voice profile, format detection, and slop rules.
 *
 * Three resolvers split for platform reuse:
 * - VOICE_PROFILE_CHECK: platform-level, any skill can adopt for voice-matched prose
 * - FORMAT_DETECTION: writing-specific, auto-detects content format
 * - SLOP_RULES: shared, banned AI vocabulary and patterns
 *
 * Trust boundary: voice profile is user-provided text injected into the prompt.
 * In single-user mode this is self-injection (no risk). If sharing profiles or
 * scraping URLs in Phase 2, sanitize scraped content before writing to the profile.
 */
import type { TemplateContext } from './types';

export function generateVoiceProfileCheck(ctx: TemplateContext): string {
  if (ctx.host === 'codex') {
    // Codex: minimal version, just check if profile exists and read it
    return `## Voice Profile

\`\`\`bash
_VP_FILE="\${HOME}/.nstack/writing/voice-profile.md"
if [ -f "$_VP_FILE" ]; then
  _VP_SIZE=$(wc -c < "$_VP_FILE" 2>/dev/null || echo 0)
  if [ "$_VP_SIZE" -gt 12000 ]; then
    echo "VOICE_PROFILE: loaded (fingerprint only, large file)"
    sed -n '/^## Style Fingerprint/,/^## [^S]/p' "$_VP_FILE" | head -60
  else
    echo "VOICE_PROFILE: loaded"
    cat "$_VP_FILE"
  fi
else
  echo "VOICE_PROFILE: none"
fi
\`\`\`

If a voice profile is loaded, match its style when generating prose. If none exists,
use a clear, direct, professional voice.`;
  }

  return `## Voice Profile

\`\`\`bash
_VP_FILE="\${HOME}/.nstack/writing/voice-profile.md"
_VP_PROMPTED=$([ -f ~/.nstack/.voice-profile-prompted ] && echo "yes" || echo "no")
_VP_CONFIGURED=$(${ctx.paths.binDir}/nstack-config get voice_profile_configured 2>/dev/null || echo "")
echo "VOICE_PROMPTED: $_VP_PROMPTED"
echo "VOICE_CONFIGURED: $_VP_CONFIGURED"

if [ -f "$_VP_FILE" ]; then
  # Validate profile structure
  if grep -qE "^## Writing Samples|^## Style Fingerprint" "$_VP_FILE" 2>/dev/null; then
    _VP_SIZE=$(wc -c < "$_VP_FILE" 2>/dev/null || echo 0)
    if [ "$_VP_SIZE" -gt 12000 ]; then
      echo "VOICE_PROFILE: loaded (fingerprint only, large file)"
      sed -n '/^## Style Fingerprint/,/^## [^S]/p' "$_VP_FILE" | head -60
    else
      echo "VOICE_PROFILE: loaded"
      cat "$_VP_FILE"
    fi
  else
    echo "VOICE_PROFILE: corrupt (missing required sections)"
  fi
else
  echo "VOICE_PROFILE: none"
fi
\`\`\`

**Voice profile handling:**

If \`VOICE_PROFILE\` is \`loaded\`: read the profile content above and match its style
when generating prose. Use the Style Fingerprint section to guide sentence length,
vocabulary register, structural patterns, and tone. If raw Writing Samples are
included, study them for voice patterns beyond what the fingerprint captures.

If \`VOICE_PROFILE\` is \`corrupt\`: warn the user: "Your voice profile appears
corrupted (missing required sections). Falling back to neutral voice for this session.
To re-create your profile, delete \`~/.nstack/writing/voice-profile.md\` and
\`~/.nstack/.voice-profile-prompted\`, then run any writing skill." Continue with
neutral professional voice. Do NOT overwrite the file (the user may want to salvage it).

If \`VOICE_PROFILE\` is \`none\` AND \`VOICE_PROMPTED\` is \`no\` AND \`PROACTIVE_PROMPTED\`
is \`yes\`: The preamble cascade is complete. Show a tip
and touch the sentinel:

\`\`\`bash
touch ~/.nstack/.voice-profile-prompted
\`\`\`

Say: "Tip: writing skills work better with your voice profile. To set one up, run
\`rm ~/.nstack/.voice-profile-prompted\` and invoke any writing skill, then choose
'Set up voice profile' when prompted."

If \`VOICE_PROFILE\` is \`none\` AND \`VOICE_PROMPTED\` is \`yes\` AND \`VOICE_CONFIGURED\`
is not \`"true"\` and not \`"skipped"\`: the user explicitly requested re-setup (deleted
the sentinel or set the config to false). Use AskUserQuestion:

> Writing skills work best with your voice profile. Paste 2-3 samples of your best
> writing (any format, 200+ words each), and I'll extract your style fingerprint.
> This takes about 2 minutes and only happens once.

Options:
- A) Set up voice profile now (recommended)
- B) Skip for now, use default voice

If A:
1. Ask the user to paste their first writing sample. Wait for it.
2. Validate: must be 200+ words of prose (not code, not URLs, not bullet-only lists).
   If it looks like code, say "This looks like code, not prose. Paste some of your
   actual writing." and ask again.
3. Ask for a second sample. Validate similarly.
4. Optionally ask for a third sample.
5. Analyze the samples and extract a Style Fingerprint:
   - Sentence length distribution (short/mixed/long, average, range)
   - Vocabulary register (casual/professional/academic/mixed)
   - Structural patterns (how they open, transition, close)
   - Tone markers (direct/conversational/formal, humor style, confidence level)
   - Format-specific notes if samples span multiple formats
6. Write the voice profile:
\`\`\`bash
mkdir -p ~/.nstack/writing
\`\`\`
Write to \`~/.nstack/writing/voice-profile.md\` with this structure:
\`\`\`markdown
# Voice Profile

## Writing Samples

### Sample 1: [source/format]
[raw text]

### Sample 2: [source/format]
[raw text]

## Style Fingerprint

### Sentence Length
Distribution: [short/mixed/long] (avg N words, range N-N)
Tendency: [description]

### Vocabulary Register
Primary: [casual/professional/academic/mixed]
Avoids: [patterns]
Favors: [patterns]

### Structural Patterns
Openings: [description]
Transitions: [description]
Closings: [description]

### Tone Markers
Base: [description]
Humor: [description]
Confidence: [description]

### Banned Patterns (user-specific)
- [any patterns the user's writing specifically avoids]
\`\`\`
7. Set the config flag:
\`\`\`bash
${ctx.paths.binDir}/nstack-config set voice_profile_configured true
touch ~/.nstack/.voice-profile-prompted
\`\`\`

If B:
\`\`\`bash
${ctx.paths.binDir}/nstack-config set voice_profile_configured skipped
touch ~/.nstack/.voice-profile-prompted
\`\`\`
Use a clear, direct, professional voice for this session.

If \`VOICE_PROFILE\` is \`none\` and none of the above conditions apply: use neutral
professional voice silently. No prompt, no tip.`;
}

export function generateFormatDetection(_ctx: TemplateContext): string {
  return `## Format Detection

Auto-detect the content format using this priority heuristic:

1. **Explicit specification:** If the user says "write a blog post" or "draft a memo,"
   use that format directly.
2. **Target file path:** If the user specifies an output path, infer from it:
   - \`blog/\`, \`posts/\`, \`content/\` → blog post
   - \`docs/\`, \`documentation/\` → documentation
   - \`README\` → readme
   - \`CHANGELOG\` → changelog entry
3. **Audience signal:** If the user names an audience, infer:
   - "for the board," "for leadership," "for the team" → memo/proposal
   - "for developers," "for engineers" → documentation
   - "for our website," "for the landing page" → website copy
   - "for subscribers," "for the list" → newsletter
4. **Keyword signal:** If strong keywords appear in the description:
   - "newsletter," "digest," "roundup" → newsletter
   - "announce," "launch," "press" → blog post or announcement
   - "proposal," "recommend," "budget" → memo/proposal
   - "paper," "study," "findings," "methodology" → research paper
5. **Ask the user:** If steps 1-4 produce no confident signal, ask via AskUserQuestion:
   "What format fits best?"
   Options:
   - A) Blog post
   - B) Memo / proposal
   - C) Research paper
   - D) Website copy
   - E) Newsletter
   - F) Other (describe the format)

**Supported formats and their conventions:**

- **Blog post:** Hook opening, scannable sections with headers, short paragraphs,
  CTA or takeaway at the end. Conversational but authoritative.
- **Memo / proposal:** Context statement, clear recommendation up front, supporting
  evidence, specific ask. Structured, evidence-first.
- **Research paper:** Abstract, methodology, findings, discussion. Formal register,
  hedging is appropriate, citations required.
- **Website copy:** Hero statement, value propositions, social proof, CTA. Benefit-first
  language, short punchy sentences.
- **Newsletter:** Hook, curated content with commentary, sign-off. Voice consistency
  is paramount.
- **Freeform / other:** User describes the format. No conventions imposed. Ask what
  structure they want, then follow it.`;
}

export function generateSlopRules(_ctx: TemplateContext): string {
  return `## AI Slop Detection Rules

When writing or reviewing prose, actively detect and eliminate AI-typical patterns.

**Banned vocabulary** (replace with specific, concrete alternatives):
delve, crucial, robust, comprehensive, nuanced, multifaceted, furthermore, moreover,
additionally, pivotal, landscape, tapestry, underscore, foster, showcase, intricate,
vibrant, fundamental, significant, interplay, leverage, utilize, facilitate, paradigm,
synergy, holistic, streamline, empower, cutting-edge, game-changing, revolutionary,
transformative, reimagine, unlock, harness, spearhead, cornerstone

**Banned patterns** (rewrite or remove entirely):
- "In today's [adjective] world/landscape/era..."
- "It's important to note that..."
- "Let's dive in..." / "Let's explore..."
- "At the end of the day..."
- "In conclusion..." / "To summarize..."
- Starting every paragraph with "However," "Additionally," or "Moreover"
- Three or more adjectives before a single noun ("innovative cutting-edge revolutionary platform")
- Excessive use of em dashes when commas or periods work
- "Here's the thing..." / "Here's the kicker..."
- "Make no mistake..."
- "This is not just X, it's Y" (the false escalation pattern)
- Lists of three where the third item is a synonym of the first two

**Format-specific exceptions:**
- **Research writing:** may use "comprehensive," "significant," "fundamental" when
  they carry precise scientific meaning (e.g., "statistically significant"). Still
  ban the rest.
- **Website copy:** may use stronger action verbs ("unlock," "transform") sparingly
  if the product genuinely does that. Challenge every usage.
- **Memos:** formal register is acceptable but the banned vocabulary list still applies.
  "Utilize" is never better than "use." "Leverage" is never better than "use" or "build on."

**Self-edit checklist** (apply after every draft):
1. Grep for every word in the banned vocabulary list. Replace each instance.
2. Check paragraph openings: if 3+ start with the same transition word, rewrite.
3. Check for the false escalation pattern ("not just X, it's Y"). Kill it.
4. Read the first sentence of every paragraph. If they sound like a textbook
   introduction, rewrite with concrete specifics.
5. Count em dashes. If more than 2 per 500 words, replace most with commas or periods.`;
}
