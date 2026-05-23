/**
 * Commit 0: Prototype validation
 * Sends 3 design briefs to GPT Image API via Responses API.
 * Validates: text rendering quality, layout accuracy, visual coherence.
 *
 * Run: OPENAI_API_KEY=$(cat ~/.gstack/openai.json | python3 -c "import sys,json;print(json.load(sys.stdin)['api_key'])") bun run design/prototype.ts
 */

import fs from "fs";
import path from "path";

const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error("No API key found. Set OPENAI_API_KEY or save to ~/.gstack/openai.json");
  process.exit(1);
}

const OUTPUT_DIR = "/tmp/gstack-prototype-" + Date.now();
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const briefs = [
  {
    name: "dashboard",
    prompt: `Generate a pixel-perfect UI mockup of a web dashboard for a coding assessment platform. Dark theme (#1a1a1a background), cream accent (#f5e6c8). Show: a header with "Builder Profile" title, a circular score badge showing "87/100", a card with a narrative assessment paragraph (use realistic lorem text about coding skills), and 3 score cards in a row (Code Quality: 92, Problem Solving: 85, Communication: 84). Modern, clean typography. 1536x1024 pixels.`
  },
  {
    name: "landing-page",
    prompt: `Generate a pixel-perfect UI mockup of a SaaS landing page for a developer tool called "Stackflow". White background, one accent color (deep blue #1e40af). Hero section with: large headline "Ship code faster with AI review", subheadline "Automated code review that catches bugs before your users do", a primary CTA button "Start free trial", and a secondary link "See how it works". Below the fold: 3 feature cards with icons. Modern, minimal, NOT generic AI-looking. 1536x1024 pixels.`
  },
  {
    name: "mobile-app",
    prompt: `Generate a pixel-perfect UI mockup of a mobile app screen (iPhone 15 Pro frame, 390x844 viewport shown on a light gray background). The app is a task manager. Show: a top nav bar with "Today" title and a profile avatar, 4 task items with checkboxes (2 checked, 2 unchecked) with realistic task names, a floating action button (+) in the bottom right, and a bottom tab bar with 4 icons (Home, Calendar, Search, Settings). Use iOS-native styling with SF Pro font. Clean, minimal.`
  }
];

async function generateMockup(brief: { name: string; prompt: string }) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Generating: ${brief.name}`);
  console.log(`${"=".repeat(60)}`);

  const startTime = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      input: brief.prompt,
      tools: [{
        type: "image_generation",
        size: "1536x1024",
        quality: "high"
      }],
    }),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!response.ok) {
    const error = await response.text();
    console.error(`FAILED (${response.status}): ${error}`);
    return null;
  }

  const data = await response.json() as any;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Find the image generation result in output
  const imageItem = data.output?.find((item: any) =>
    item.type === "image_generation_call"
  );

  if (!imageItem?.result) {
    console.error("No image data in response. Output types:",
      data.output?.map((o: any) => o.type));
    console.error("Full response:", JSON.stringify(data, null, 2).slice(0, 500));
    return null;
  }

  const safeName = brief.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const outputPath = OUTPUT_DIR + "/" + safeName + ".png";
  const imageBuffer = Buffer.from(imageItem.result, "base64");
  fs.writeFileSync(outputPath, imageBuffer);

  console.log(`OK (${elapsed}s) → ${outputPath}`);
  console.log(`   Size: ${(imageBuffer.length / 1024).toFixed(0)} KB`);
  console.log(`   Usage: ${JSON.stringify(data.usage || {})}`);

  return outputPath;
}

async function main() {
  console.log("Design Tools Prototype Validation");
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log(`Briefs: ${briefs.length}`);
  console.log();

  const results: { name: string; path: string | null; }[] = [];

  for (const brief of briefs) {
    try {
      const resultPath = await generateMockup(brief);
      results.push({ name: brief.name, path: resultPath });
    } catch (err) {
      console.error("ERROR generating:", brief.name, err);
      results.push({ name: brief.name, path: null });
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("RESULTS");
  console.log(`${"=".repeat(60)}`);

  const succeeded = results.filter(r => r.path);
  const failed = results.filter(r => !r.path);

  console.log(`${succeeded.length}/${results.length} generated successfully`);

  if (failed.length > 0) {
    console.log("Failed:", failed.map(f => f.name).join(", "));
  }

  if (succeeded.length > 0) {
    console.log(`\nGenerated mockups:`);
    for (const r of succeeded) {
      console.log(`  ${r.path}`);
    }
    console.log(`\nOpen in Finder: open ${OUTPUT_DIR}`);
  }

  if (succeeded.length === 0) {
    console.log("\nPROTOTYPE FAILED: No mockups generated. Re-evaluate approach.");
    process.exit(1);
  }
}

main().catch(console.error);
