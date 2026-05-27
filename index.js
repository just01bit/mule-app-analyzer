#!/usr/bin/env node

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");

const TOKEN_URL = "https://anypoint.mulesoft.com/accounts/api/v2/oauth2/token";
const APPLICATIONS_URL = "https://anypoint.mulesoft.com/cloudhub/api/v2/applications";
const DOWNLOAD_URL_TEMPLATE =
  "https://anypoint.mulesoft.com/cloudhub/api/applications/{domain}/download/{fileName}";
const DOWNLOAD_DIR = "mule-apps";
const DEFAULT_PORT = Number(process.env.PORT || 3000);

const downloadState = {
  running: false,
  total: 0,
  processed: 0,
  downloaded: 0,
  skipped: 0,
  failed: 0,
  status: "idle",
  startedAt: null,
  finishedAt: null,
  messages: [],
  applications: [],
};
const analyzeState = {
  running: false,
  total: 0,
  processed: 0,
  complete: 0,
  failed: 0,
  status: "idle",
  startedAt: null,
  finishedAt: null,
  dependencyRows: [],
  sourceEventRows: [],
  messages: [],
};
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
});

async function main() {
  const [, , clientId, clientSecret] = process.argv;

  if (!clientId || !clientSecret) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  startWebApp(clientId, clientSecret);
}

function printUsage() {
  console.log("Usage:");
  console.log("  node mule-app-analyzer <connected_app_client_id> <connected_app_client_secret>");
  console.log("  # or");
  console.log("  node index.js <connected_app_client_id> <connected_app_client_secret>");
}

function startWebApp(clientId, clientSecret) {
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && requestUrl.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getHtmlPage());
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/download-status") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(buildStatusPayload()));
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/download-applications") {
        if (downloadState.running) {
          res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ message: "Download workflow is already running." }));
          return;
        }

        runDownloadWorkflow(clientId, clientSecret).catch((error) => {
          updateState("error", `Workflow failed: ${error.message}`);
          downloadState.running = false;
          downloadState.finishedAt = new Date().toISOString();
        });

        res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ message: "Download workflow started." }));
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/analyze-applications") {
        if (analyzeState.running) {
          res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ message: "Analyze workflow is already running." }));
          return;
        }

        runAnalyzeWorkflow().catch((error) => {
          updateAnalyzeState("error", `Analyze workflow failed: ${error.message}`);
          analyzeState.running = false;
          analyzeState.finishedAt = new Date().toISOString();
        });

        res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ message: "Analyze workflow started." }));
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/analyze-status") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(buildAnalyzeStatusPayload()));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ message: `Server error: ${error.message}` }));
    }
  });

  server.listen(DEFAULT_PORT, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
    console.log(`Application started. Open this URL in your browser: http://localhost:${port}`);
  });
}

async function runDownloadWorkflow(clientId, clientSecret) {
  resetDownloadState();
  downloadState.running = true;
  downloadState.startedAt = new Date().toISOString();
  updateState("running", "Getting access token...");

  const accessToken = await getAccessToken(clientId, clientSecret);
  updateState("running", "Fetching CloudHub applications...");

  const applications = await getApplications(accessToken);
  if (!Array.isArray(applications) || applications.length === 0) {
    updateState("completed", "No applications returned from CloudHub.");
    downloadState.running = false;
    downloadState.finishedAt = new Date().toISOString();
    return;
  }

  const candidates = applications.filter((app) => app?.domain && app?.fileName);
  downloadState.total = candidates.length;
  downloadState.applications = candidates.map((app) => ({
    domain: app.domain,
    fileName: app.fileName,
    status: "new",
  }));
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });

  for (let i = 0; i < candidates.length; i += 1) {
    const app = candidates[i];
    const { domain, fileName } = app;
    const targetPath = path.join(DOWNLOAD_DIR, fileName);
    setApplicationStatus(i, "downloading");
    const alreadyExists = await fileExists(targetPath);

    if (alreadyExists) {
      downloadState.skipped += 1;
      downloadState.processed += 1;
      setApplicationStatus(i, "skipped");
      updateState("running", `Skipped existing file: ${fileName}`);
      continue;
    }

    try {
      await downloadApplicationJar(accessToken, domain, fileName, targetPath);
      downloadState.downloaded += 1;
      downloadState.processed += 1;
      setApplicationStatus(i, "downloaded");
      updateState("running", `Downloaded: ${fileName}`);
    } catch (error) {
      downloadState.failed += 1;
      downloadState.processed += 1;
      setApplicationStatus(i, "failed");
      updateState("running", `Failed ${fileName}: ${error.message}`);
    }
  }

  downloadState.running = false;
  downloadState.finishedAt = new Date().toISOString();
  updateState(
    "completed",
    `Done. Downloaded ${downloadState.downloaded}, skipped ${downloadState.skipped}, failed ${downloadState.failed}.`
  );
}

function resetDownloadState() {
  downloadState.total = 0;
  downloadState.processed = 0;
  downloadState.downloaded = 0;
  downloadState.skipped = 0;
  downloadState.failed = 0;
  downloadState.status = "idle";
  downloadState.startedAt = null;
  downloadState.finishedAt = null;
  downloadState.messages = [];
  downloadState.applications = [];
}

function updateState(status, message) {
  downloadState.status = status;
  downloadState.messages.push({
    time: new Date().toISOString(),
    message,
  });
  if (downloadState.messages.length > 50) {
    downloadState.messages = downloadState.messages.slice(-50);
  }
}

function setApplicationStatus(index, status) {
  if (!downloadState.applications[index]) {
    return;
  }
  downloadState.applications[index].status = status;
}

function buildStatusPayload() {
  const percentage =
    downloadState.total > 0 ? Math.round((downloadState.processed / downloadState.total) * 100) : 0;

  return {
    ...downloadState,
    percentage,
  };
}

async function runAnalyzeWorkflow() {
  resetAnalyzeState();
  analyzeState.running = true;
  analyzeState.status = "running";
  analyzeState.startedAt = new Date().toISOString();
  updateAnalyzeState("running", "Scanning mule-apps folder for jar files...");

  const jarFiles = await listJarFiles(DOWNLOAD_DIR);
  analyzeState.total = jarFiles.length;
  analyzeState.dependencyRows = jarFiles.map((fileName) => ({
    fileName,
    applicationName: "",
    dependency: "",
    version: "",
    status: "New",
  }));
  analyzeState.sourceEventRows = jarFiles.map((fileName) => ({
    fileName,
    applicationName: "",
    flowName: "",
    sourceEventType: "",
    status: "New",
  }));

  if (jarFiles.length === 0) {
    analyzeState.running = false;
    analyzeState.status = "completed";
    analyzeState.finishedAt = new Date().toISOString();
    updateAnalyzeState("completed", "No jar files found in mule-apps.");
    return;
  }

  for (const fileName of jarFiles) {
    setAnalyzeStatusForFile(fileName, "Analyzing", "both");
    const jarPath = path.join(DOWNLOAD_DIR, fileName);

    try {
      const zip = new AdmZip(jarPath);
      const pomContent = readPomXmlFromZip(zip);
      const { applicationName, dependencies } = extractPomDetails(pomContent);
      const normalizedDependencies = dependencies.length > 0 ? dependencies : [{ artifactId: "", version: "" }];
      const sourceEvents = extractSourceEventsFromJar(zip);
      const normalizedSourceEvents =
        sourceEvents.length > 0 ? sourceEvents : [{ flowName: "", sourceEventType: "" }];

      replaceAnalyzeRowsForFile(
        "dependencyRows",
        fileName,
        normalizedDependencies.map((dependency) => ({
          fileName,
          applicationName,
          dependency: dependency.artifactId || "",
          version: dependency.version || "",
          status: "Complete",
        }))
      );
      replaceAnalyzeRowsForFile(
        "sourceEventRows",
        fileName,
        normalizedSourceEvents.map((event) => ({
          fileName,
          applicationName,
          flowName: event.flowName || "",
          sourceEventType: event.sourceEventType || "",
          status: "Complete",
        }))
      );

      analyzeState.complete += 1;
      analyzeState.processed += 1;
      updateAnalyzeState("running", `Analyzed ${fileName}`);
    } catch (error) {
      replaceAnalyzeRowsForFile("dependencyRows", fileName, [
        {
          fileName,
          applicationName: "",
          dependency: "",
          version: "",
          status: "Failed",
        },
      ]);
      replaceAnalyzeRowsForFile("sourceEventRows", fileName, [
        {
          fileName,
          applicationName: "",
          flowName: "",
          sourceEventType: "",
          status: "Failed",
        },
      ]);

      analyzeState.failed += 1;
      analyzeState.processed += 1;
      updateAnalyzeState("running", `Failed ${fileName}: ${error.message}`);
    }
  }

  analyzeState.running = false;
  analyzeState.status = "completed";
  analyzeState.finishedAt = new Date().toISOString();
  updateAnalyzeState(
    "completed",
    `Analyze complete. Total ${analyzeState.total}, complete ${analyzeState.complete}, failed ${analyzeState.failed}.`
  );
}

async function listJarFiles(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jar"))
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readPomXmlFromJar(jarPath) {
  const zip = new AdmZip(jarPath);
  return readPomXmlFromZip(zip);
}

function readPomXmlFromZip(zip) {
  const entry = zip
    .getEntries()
    .find((item) => !item.isDirectory && item.entryName.toLowerCase().endsWith("pom.xml"));

  if (!entry) {
    throw new Error("pom.xml not found");
  }

  return zip.readAsText(entry, "utf8");
}

function extractSourceEventsFromJar(zip) {
  const muleXmlEntries = zip.getEntries().filter(
    (entry) =>
      !entry.isDirectory &&
      isMuleFlowXmlPath(entry.entryName) &&
      entry.entryName.toLowerCase().endsWith(".xml")
  );

  const sourceEvents = [];
  const uniqueKeys = new Set();
  for (const entry of muleXmlEntries) {
    const xmlContent = zip.readAsText(entry, "utf8");
    for (const event of extractSourceEventsFromMuleXml(xmlContent)) {
      const key = `${event.flowName}::${event.sourceEventType}`;
      if (uniqueKeys.has(key)) {
        continue;
      }
      uniqueKeys.add(key);
      sourceEvents.push(event);
    }
  }
  return sourceEvents;
}

function isMuleFlowXmlPath(entryName) {
  const normalized = entryName.replaceAll("\\\\", "/").toLowerCase();

  // Requested path in source projects
  if (normalized.startsWith("src/main/mule/")) {
    return true;
  }

  // Common packaged Mule app layout in JARs
  if (normalized.includes("/src/main/mule/")) {
    return true;
  }

  // Many Mule apps also include deployed flow files at the jar root
  if (!normalized.includes("/") && normalized.endsWith(".xml")) {
    return true;
  }

  return false;
}

function extractSourceEventsFromMuleXml(xmlContent) {
  const events = [];
  const flowRegex = /<flow\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/flow>/g;

  for (const flowMatch of xmlContent.matchAll(flowRegex)) {
    const flowName = flowMatch[1] || "";
    const flowBody = flowMatch[2] || "";
    const listenerRegex = /<([A-Za-z0-9_-]+):listener\b/g;
    const seenTypes = new Set();

    for (const listenerMatch of flowBody.matchAll(listenerRegex)) {
      const sourceEventType = listenerMatch[1] || "";
      if (!sourceEventType || seenTypes.has(sourceEventType)) {
        continue;
      }
      seenTypes.add(sourceEventType);
      events.push({ flowName, sourceEventType });
    }
  }

  return events;
}

function extractPomDetails(pomContent) {
  const parsed = xmlParser.parse(pomContent);
  const project = parsed?.project;
  if (!project) {
    throw new Error("Invalid pom.xml: missing project node");
  }

  const applicationName = normalizeSingleValue(project.name);
  const dependencyNodes = toArray(project?.dependencies?.dependency);
  const dependencies = dependencyNodes.map((dependencyNode) => ({
    artifactId: normalizeSingleValue(dependencyNode?.artifactId),
    version: normalizeSingleValue(dependencyNode?.version),
  }));

  return { applicationName, dependencies };
}

function toArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeSingleValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function resetAnalyzeState() {
  analyzeState.running = false;
  analyzeState.total = 0;
  analyzeState.processed = 0;
  analyzeState.complete = 0;
  analyzeState.failed = 0;
  analyzeState.status = "idle";
  analyzeState.startedAt = null;
  analyzeState.finishedAt = null;
  analyzeState.dependencyRows = [];
  analyzeState.sourceEventRows = [];
  analyzeState.messages = [];
}

function updateAnalyzeState(status, message) {
  analyzeState.status = status;
  analyzeState.messages.push({
    time: new Date().toISOString(),
    message,
  });

  if (analyzeState.messages.length > 50) {
    analyzeState.messages = analyzeState.messages.slice(-50);
  }
}

function setAnalyzeStatusForFile(fileName, status, targetTable) {
  if (targetTable === "dependencyRows" || targetTable === "both") {
    analyzeState.dependencyRows = analyzeState.dependencyRows.map((row) =>
      row.fileName === fileName ? { ...row, status } : row
    );
  }
  if (targetTable === "sourceEventRows" || targetTable === "both") {
    analyzeState.sourceEventRows = analyzeState.sourceEventRows.map((row) =>
      row.fileName === fileName ? { ...row, status } : row
    );
  }
}

function replaceAnalyzeRowsForFile(tableKey, fileName, nextRows) {
  analyzeState[tableKey] = analyzeState[tableKey].filter((row) => row.fileName !== fileName).concat(nextRows);
}

function buildAnalyzeStatusPayload() {
  const percentage =
    analyzeState.total > 0 ? Math.round((analyzeState.processed / analyzeState.total) * 100) : 0;

  return {
    ...analyzeState,
    percentage,
  };
}

function getHtmlPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mule App Analyzer</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #1f2937; }
    .container { max-width: 760px; }
    button { margin-right: 0.75rem; margin-bottom: 0.75rem; padding: 0.6rem 1rem; border: 0; border-radius: 6px; background: #2563eb; color: white; cursor: pointer; }
    button.secondary { background: #4b5563; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .progress-wrap { margin-top: 1rem; }
    progress { width: 100%; height: 18px; }
    .meta { margin-top: 0.5rem; color: #4b5563; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { border: 1px solid #d1d5db; padding: 0.55rem; text-align: left; }
    th { background: #f3f4f6; }
    .status-new { color: #374151; }
    .status-downloading { color: #1d4ed8; font-weight: 600; }
    .status-downloaded { color: #047857; font-weight: 600; }
    .status-skipped { color: #6b7280; }
    .status-failed { color: #b91c1c; font-weight: 600; }
    .status-New { color: #374151; }
    .status-Analyzing { color: #1d4ed8; font-weight: 600; }
    .status-Complete { color: #047857; font-weight: 600; }
    .status-Failed { color: #b91c1c; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Mule App Analyzer</h1>
    <button id="downloadBtn">Download Applications</button>
    <button id="analyzeBtn" class="secondary">Analyze Applications</button>

    <div class="progress-wrap">
      <progress id="progressBar" max="100" value="0"></progress>
      <div class="meta" id="progressText">Progress: 0%</div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Application Name</th>
          <th>File Name</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="outputRows"></tbody>
    </table>

    <div class="progress-wrap">
      <progress id="analyzeProgressBar" max="100" value="0"></progress>
      <div class="meta" id="analyzeProgressText">Analyze Progress: 0%</div>
    </div>

    <h3>Dependencies</h3>
    <table>
      <thead>
        <tr>
          <th>File Name</th>
          <th>Application Name</th>
          <th>Dependency</th>
          <th>Version</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="dependencyRows"></tbody>
    </table>

    <h3>Source Event Type</h3>
    <table>
      <thead>
        <tr>
          <th>File Name</th>
          <th>Application Name</th>
          <th>Flow Name</th>
          <th>Source Event Type</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="sourceEventRows"></tbody>
    </table>
  </div>

  <script>
    const progressBar = document.getElementById("progressBar");
    const progressText = document.getElementById("progressText");
    const outputRows = document.getElementById("outputRows");
    const downloadBtn = document.getElementById("downloadBtn");
    const analyzeBtn = document.getElementById("analyzeBtn");
    const analyzeProgressBar = document.getElementById("analyzeProgressBar");
    const analyzeProgressText = document.getElementById("analyzeProgressText");
    const dependencyRows = document.getElementById("dependencyRows");
    const sourceEventRows = document.getElementById("sourceEventRows");
    let downloadPollTimer = null;
    let analyzePollTimer = null;

    function escapeHtml(value) {
      return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function renderStatus(data) {
      progressBar.value = data.percentage || 0;
      progressText.textContent =
        "Progress: " + (data.percentage || 0) + "% (" + data.processed + "/" + data.total + "), downloaded: " +
        data.downloaded + ", skipped: " + data.skipped + ", failed: " + data.failed;

      outputRows.innerHTML = (data.applications || [])
        .map((app) => {
          const safeStatus = escapeHtml(app.status || "new");
          return "<tr>" +
            "<td>" + escapeHtml(app.domain || "") + "</td>" +
            "<td>" + escapeHtml(app.fileName || "") + "</td>" +
            "<td class=\\"status-" + safeStatus + "\\">" + safeStatus + "</td>" +
            "</tr>";
        })
        .join("");

      if (!data.running && downloadPollTimer) {
        clearInterval(downloadPollTimer);
        downloadPollTimer = null;
        downloadBtn.disabled = false;
      }
    }

    async function fetchStatus() {
      const response = await fetch("/api/download-status");
      const data = await response.json();
      renderStatus(data);
    }

    downloadBtn.addEventListener("click", async () => {
      downloadBtn.disabled = true;
      const response = await fetch("/api/download-applications", { method: "POST" });

      if (!response.ok) {
        const error = await response.json();
        alert(error.message || "Unable to start download workflow.");
        downloadBtn.disabled = false;
        return;
      }

      await fetchStatus();
      downloadPollTimer = setInterval(fetchStatus, 1000);
    });

    function renderAnalyzeStatus(data) {
      analyzeProgressBar.value = data.percentage || 0;
      analyzeProgressText.textContent =
        "Analyze Progress: " + (data.percentage || 0) + "% (" + data.processed + "/" + data.total +
        "), complete: " + data.complete + ", failed: " + data.failed;

      dependencyRows.innerHTML = (data.dependencyRows || [])
        .map((row) => {
          const safeStatus = escapeHtml(row.status || "New");
          return "<tr>" +
            "<td>" + escapeHtml(row.fileName || "") + "</td>" +
            "<td>" + escapeHtml(row.applicationName || "") + "</td>" +
            "<td>" + escapeHtml(row.dependency || "") + "</td>" +
            "<td>" + escapeHtml(row.version || "") + "</td>" +
            "<td class=\\"status-" + safeStatus + "\\">" + safeStatus + "</td>" +
            "</tr>";
        })
        .join("");
      sourceEventRows.innerHTML = (data.sourceEventRows || [])
        .map((row) => {
          const safeStatus = escapeHtml(row.status || "New");
          return "<tr>" +
            "<td>" + escapeHtml(row.fileName || "") + "</td>" +
            "<td>" + escapeHtml(row.applicationName || "") + "</td>" +
            "<td>" + escapeHtml(row.flowName || "") + "</td>" +
            "<td>" + escapeHtml(row.sourceEventType || "") + "</td>" +
            "<td class=\\"status-" + safeStatus + "\\">" + safeStatus + "</td>" +
            "</tr>";
        })
        .join("");

      if (!data.running && analyzePollTimer) {
        clearInterval(analyzePollTimer);
        analyzePollTimer = null;
        analyzeBtn.disabled = false;
      }
    }

    async function fetchAnalyzeStatus() {
      const response = await fetch("/api/analyze-status");
      const data = await response.json();
      renderAnalyzeStatus(data);
    }

    analyzeBtn.addEventListener("click", async () => {
      analyzeBtn.disabled = true;
      const response = await fetch("/api/analyze-applications", { method: "POST" });
      const data = await response.json();

      if (!response.ok) {
        alert(data.message || "Unable to start analyze workflow.");
        analyzeBtn.disabled = false;
        return;
      }

      await fetchAnalyzeStatus();
      analyzePollTimer = setInterval(fetchAnalyzeStatus, 1000);
    });

    fetchStatus();
    fetchAnalyzeStatus();
  </script>
</body>
</html>`;
}

async function getAccessToken(clientId, clientSecret) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  await throwIfNotOk(response, "Failed to get access token");
  const data = await response.json();

  if (!data?.access_token) {
    throw new Error("Access token is missing in token response.");
  }

  return data.access_token;
}

async function getApplications(accessToken) {
  const response = await fetch(APPLICATIONS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  await throwIfNotOk(response, "Failed to get CloudHub applications");
  return response.json();
}

async function downloadApplicationJar(accessToken, domain, fileName, targetPath) {
  const downloadUrl = DOWNLOAD_URL_TEMPLATE.replace("{domain}", encodeURIComponent(domain)).replace(
    "{fileName}",
    encodeURIComponent(fileName)
  );

  const response = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  await throwIfNotOk(response, `Failed to download ${fileName}`);
  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(targetPath, Buffer.from(arrayBuffer));
}

async function throwIfNotOk(response, prefix) {
  if (response.ok) {
    return;
  }

  const body = await response.text();
  const details = body ? ` - ${body}` : "";
  throw new Error(`${prefix} (${response.status} ${response.statusText})${details}`);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

main();
