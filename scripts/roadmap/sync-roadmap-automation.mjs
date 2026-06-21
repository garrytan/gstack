#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function callGitHub(endpoint, token, method, body) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "ammor-roadmap-automation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = payload?.message || "GitHub API request failed";
    const details = payload?.errors ? ` ${JSON.stringify(payload.errors)}` : "";
    throw new Error(`${method} ${endpoint} -> ${response.status} ${message}${details}`);
  }
  return payload;
}

async function callGraphQL(token, query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "ammor-roadmap-automation",
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await response.json();
  if (!response.ok || data.errors) {
    throw new Error(`GraphQL request failed: ${JSON.stringify(data.errors || data)}`);
  }
  return data.data;
}

function firstMatchMilestone(labels, rules) {
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));
  for (const rule of rules) {
    if (!Array.isArray(rule.labels)) continue;
    if (rule.labels.some((label) => labelSet.has(label.toLowerCase()))) {
      return rule.milestone;
    }
  }
  return null;
}

function firstMatchProjectLabels(labels, rules) {
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));
  for (const rule of rules) {
    if (rule.labels && rule.labels.some((label) => labelSet.has(label.toLowerCase()))) {
      return rule.status;
    }
  }
  return null;
}

function output(msg) {
  process.stdout.write(`${msg}\n`);
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo = process.env.GITHUB_REPOSITORY || "";
  const [owner, repoName] = repo.split("/");
  const policyPath = process.env.ROADMAP_POLICY_PATH || ".github/ammor-roadmap-automation.json";
  const githubToken = process.env.GITHUB_TOKEN || process.env.AMMOR_ROADMAP_TOKEN;
  const policy = readJson(policyPath, null);

  if (!eventPath || !fs.existsSync(eventPath)) {
    throw new Error("GITHUB_EVENT_PATH is missing.");
  }
  if (!owner || !repoName) {
    throw new Error("GITHUB_REPOSITORY is missing or malformed.");
  }
  if (!githubToken) {
    throw new Error("GitHub token missing. Set GITHUB_TOKEN or AMMOR_ROADMAP_TOKEN.");
  }
  if (!policy?.enabled) {
    output("Roadmap automation disabled in policy file.");
    return;
  }

  const event = readJson(eventPath, {});
  const issue = event.issue || event.pull_request || null;
  if (!issue) {
    output("No issue or pull request payload found. Nothing to sync.");
    return;
  }

  const number = issue.number;
  const nodeId = issue.node_id;
  const labels = (issue.labels || []).map((label) => (typeof label === "string" ? label : label.name)).filter(Boolean);
  const currentMilestone = issue.milestone?.number ? String(issue.milestone.number) : null;

  const milestoneName =
    firstMatchMilestone(labels, policy.milestones || []) ||
    policy.default_milestone ||
    null;

  if (milestoneName) {
    const milestones = await callGitHub(
      `/repos/${owner}/${repoName}/milestones?state=all&per_page=100`,
      githubToken,
      "GET"
    );

    const match = Array.isArray(milestones)
      ? milestones.find((m) => m && m.title === milestoneName)
      : null;

    if (!match) {
      output(`Milestone "${milestoneName}" not found. Add it in repository milestones to allow auto-assign.`);
    } else if (`${match.number}` !== `${currentMilestone}`) {
      await callGitHub(
        `/repos/${owner}/${repoName}/issues/${number}`,
        githubToken,
        "PATCH",
        { milestone: match.number }
      );
      output(`Assigned ${event.pull_request ? "PR" : "Issue"} #${number} to milestone ${milestoneName}`);
    }
  }

  const projectCfg = policy.project || {};
  const projectId = process.env[projectCfg.project_id_env_var || "AMMOR_ROADMAP_PROJECT_ID"];
  const addToProject = projectCfg.enabled === true && projectId && issue.node_id;

  if (!addToProject) {
    output("Project automation not active (disabled, missing project id, or missing item id).");
    return;
  }

  const addMutation = `
    mutation AddToProjectV2($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `;

  try {
    const data = await callGraphQL(
      process.env[projectCfg.token_env_var || "AMMOR_ROADMAP_TOKEN"] || githubToken,
      addMutation,
      { projectId, contentId: nodeId }
    );
    output(`Added ${event.pull_request ? "PR" : "Issue"} #${number} to roadmap project.`);

    const status = firstMatchProjectLabels(labels, policy.project_status_rules || []);
    if (status && data?.addProjectV2ItemById?.item?.id) {
      const itemId = data.addProjectV2ItemById.item.id;
      const fieldId = projectCfg.status_field_id || process.env.AMMOR_ROADMAP_STATUS_FIELD_ID;
      if (fieldId && projectCfg.status_lookup) {
        const optionId = projectCfg.status_lookup[status];
        if (optionId) {
          const updateMutation = `
            mutation UpdateProjectV2Field($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
              updateProjectV2ItemFieldValue(
                input: {
                  projectId: $projectId,
                  itemId: $itemId,
                  fieldId: $fieldId,
                  value: { singleSelectOptionId: $optionId }
                }
              ) { clientMutationId }
            }
          `;
          await callGraphQL(
            process.env[projectCfg.token_env_var || "AMMOR_ROADMAP_TOKEN"] || githubToken,
            updateMutation,
            { projectId, itemId, fieldId, optionId }
          );
          output(`Updated project status for #${number} to ${status}.`);
        }
      }
    }
  } catch (error) {
    const msg = String(error.message || "");
    if (msg.includes("already exists") || msg.includes("could not be found")) {
      output(`Project sync note: ${msg}`);
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`[roadmap-automation] failed: ${error.message}`);
  process.exit(1);
});
