import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const ANALYTICS_PATH = join(homedir(), ".gstack", "analytics", "skill-usage.jsonl");

function dayKey(ts) {
  return new Date(ts).toISOString().split("T")[0];
}

function run() {
  if (!existsSync(ANALYTICS_PATH)) {
    console.log("No analytics data found. Run some skills to build a streak.");
    process.exit(0);
  }

  const text = readFileSync(ANALYTICS_PATH, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  const dailyActivity = new Map();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const date = dayKey(entry.ts);
      const skills = dailyActivity.get(date) || new Set();
      skills.add(String(entry.skill || "unknown"));
      dailyActivity.set(date, skills);
    } catch {
      // ignore
    }
  }

  const sortedDates = Array.from(dailyActivity.keys()).sort((a, b) => b.localeCompare(a));
  if (sortedDates.length === 0) {
    console.log("No activity recorded yet. Time to ship.");
    process.exit(0);
  }

  let streak = 0;
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

  let checkDateStr = sortedDates[0];
  if (checkDateStr !== today && checkDateStr !== yesterday) {
    streak = 0;
  } else {
    let current = new Date(checkDateStr);
    while (dailyActivity.has(current.toISOString().split("T")[0])) {
      streak++;
      current.setDate(current.getDate() - 1);
    }
  }

  console.log("\nGSTACK SHIPPING STREAK");
  console.log("======================");
  console.log(`Current Streak: ${streak} day${streak === 1 ? "" : "s"}`);
  console.log("");
  console.log("Last 7 Days of Activity:");

  const last7Days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const dStr = d.toISOString().split("T")[0];
    const skills = dailyActivity.get(dStr);
    last7Days.push({
      Date: dStr,
      Status: skills ? "ACTIVE" : "idle",
      Skills: skills ? Array.from(skills).join(", ") : "-",
    });
  }

  console.table(last7Days);
}

run();
