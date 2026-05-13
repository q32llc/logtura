const [teamId, projectsJson] = process.argv.slice(2);
const projects = JSON.parse(projectsJson);
const token = process.env.VERCEL_API_TOKEN;
if (!token) {
  console.error("VERCEL_API_TOKEN is required");
  process.exit(1);
}
const seen = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function vercelJson(path, params) {
  const url = new URL(path, "https://api.vercel.com");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, {
    headers: { authorization: "Bearer " + token, accept: "application/json" },
  });
  if (!res.ok) throw new Error(String(res.status) + " " + await res.text());
  return res.json();
}

async function latestDeployment(projectId) {
  const data = await vercelJson("/v6/deployments", {
    teamId,
    projectId,
    target: "production",
    state: "READY",
    limit: "1",
  });
  return data.deployments?.[0]?.uid ?? null;
}

function remember(projectId, rowId) {
  let projectSeen = seen.get(projectId);
  if (!projectSeen) {
    projectSeen = [];
    seen.set(projectId, projectSeen);
  }
  if (projectSeen.includes(rowId)) return false;
  projectSeen.push(rowId);
  if (projectSeen.length > 5000) projectSeen.splice(0, projectSeen.length - 5000);
  return true;
}

function isExpectedStreamRestart(err) {
  return Boolean(err && typeof err === "object" && err.name === "AbortError");
}

function isExpectedTimeoutMessage(message) {
  return String(message ?? "").toLowerCase().includes("operation timed out");
}

async function tailProject(project) {
  for (;;) {
    try {
      const deploymentId = await latestDeployment(project.id);
      if (!deploymentId) {
        await sleep(10000);
        continue;
      }
      const url = new URL("/v1/projects/" + project.id + "/deployments/" + deploymentId + "/runtime-logs", "https://api.vercel.com");
      if (teamId) url.searchParams.set("teamId", teamId);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 300000);
      try {
        const res = await fetch(url, {
          headers: { authorization: "Bearer " + token, accept: "application/json" },
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(String(res.status) + " " + await res.text());
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const event = JSON.parse(trimmed);
            const rowId = String(event.rowId ?? "");
            if (!rowId || !remember(project.id, rowId)) continue;
            event.projectId = project.id;
            event.projectName = project.name;
            event.deploymentId = deploymentId;
            process.stdout.write(JSON.stringify(event) + "\n");
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isExpectedStreamRestart(err) && !isExpectedTimeoutMessage(message)) {
        console.error("vercel tail " + project.id + ": " + message);
      }
      await sleep(3000);
    }
  }
}

await Promise.all(projects.map((project) => tailProject(project)));
