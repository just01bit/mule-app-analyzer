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
const DOWNLOAD_CONCURRENCY = Math.max(1, Number(process.env.DOWNLOAD_CONCURRENCY || 10));
const DOWNLOAD_RETRIES = Math.max(0, Number(process.env.DOWNLOAD_RETRIES || 2));

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
  salesforceAuthRows: [],
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
  updateState("running", `Downloading ${candidates.length} applications with concurrency ${DOWNLOAD_CONCURRENCY}...`);
  await runWithConcurrency(candidates, DOWNLOAD_CONCURRENCY, async (app, index) => {
    const { domain, fileName } = app;
    const targetPath = path.join(DOWNLOAD_DIR, fileName);
    setApplicationStatus(index, "downloading");
    const alreadyExists = await fileExists(targetPath);

    if (alreadyExists) {
      downloadState.skipped += 1;
      downloadState.processed += 1;
      setApplicationStatus(index, "skipped");
      updateState("running", `Skipped existing file: ${fileName}`);
      return;
    }

    try {
      await downloadApplicationJarWithRetry(accessToken, domain, fileName, targetPath);
      downloadState.downloaded += 1;
      downloadState.processed += 1;
      setApplicationStatus(index, "downloaded");
      updateState("running", `Downloaded: ${fileName}`);
    } catch (error) {
      downloadState.failed += 1;
      downloadState.processed += 1;
      setApplicationStatus(index, "failed");
      updateState("running", `Failed ${fileName}: ${error.message}`);
    }
  });

  downloadState.running = false;
  downloadState.finishedAt = new Date().toISOString();
  updateState(
    "completed",
    `Done. Downloaded ${downloadState.downloaded}, skipped ${downloadState.skipped}, failed ${downloadState.failed}.`
  );
}

async function runWithConcurrency(items, concurrency, workerFn) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await workerFn(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

async function downloadApplicationJarWithRetry(accessToken, domain, fileName, targetPath) {
  let attempt = 0;
  while (attempt <= DOWNLOAD_RETRIES) {
    try {
      await downloadApplicationJar(accessToken, domain, fileName, targetPath);
      return;
    } catch (error) {
      attempt += 1;
      if (attempt > DOWNLOAD_RETRIES) {
        throw error;
      }
      const waitMs = Math.min(3000, 250 * 2 ** attempt);
      await wait(waitMs);
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  updateAnalyzeState("running", "Scanning mule-apps folder for jar/zip files...");

  const appArchiveFiles = await listAppArchiveFiles(DOWNLOAD_DIR);
  analyzeState.total = appArchiveFiles.length;
  analyzeState.dependencyRows = appArchiveFiles.map((fileName) => ({
    fileName,
    applicationName: "",
    dependency: "",
    version: "",
    status: "New",
  }));
  analyzeState.sourceEventRows = appArchiveFiles.map((fileName) => ({
    fileName,
    applicationName: "",
    flowName: "",
    sourceEventType: "",
    status: "New",
  }));
  analyzeState.salesforceAuthRows = [];

  if (appArchiveFiles.length === 0) {
    analyzeState.running = false;
    analyzeState.status = "completed";
    analyzeState.finishedAt = new Date().toISOString();
    updateAnalyzeState("completed", "No jar/zip files found in mule-apps.");
    return;
  }

  for (const fileName of appArchiveFiles) {
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
      const salesforceAuthTypes = extractSalesforceAuthTypesFromJar(zip);

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
      if (salesforceAuthTypes.length > 0) {
        replaceAnalyzeRowsForFile(
          "salesforceAuthRows",
          fileName,
          salesforceAuthTypes.map((item) => ({
            fileName,
            applicationName,
            salesforceAuthType: item.salesforceAuthType || "",
            status: "Complete",
          }))
        );
      }

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
      // Only include Salesforce rows for apps that actually have Salesforce config.
      // On failure we keep this table clean instead of emitting empty placeholder rows.

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

async function listAppArchiveFiles(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isSupportedAppArchive(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isSupportedAppArchive(fileName) {
  const lowerName = fileName.toLowerCase();
  return lowerName.endsWith(".jar") || lowerName.endsWith(".zip");
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

function extractSalesforceAuthTypesFromJar(zip) {
  const muleXmlEntries = zip.getEntries().filter(
    (entry) =>
      !entry.isDirectory &&
      isMuleFlowXmlPath(entry.entryName) &&
      entry.entryName.toLowerCase().endsWith(".xml")
  );

  const authTypes = [];
  const uniqueTypes = new Set();
  for (const entry of muleXmlEntries) {
    const xmlContent = zip.readAsText(entry, "utf8");
    for (const item of extractSalesforceAuthTypesFromMuleXml(xmlContent)) {
      const key = item.salesforceAuthType;
      if (uniqueTypes.has(key)) {
        continue;
      }
      uniqueTypes.add(key);
      authTypes.push(item);
    }
  }
  return authTypes;
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

function extractSalesforceAuthTypesFromMuleXml(xmlContent) {
  const authTypes = [];
  const sfdcConfigRegex = /<salesforce:sfdc-config\b[\s\S]*?<\/salesforce:sfdc-config>/g;
  const configBlocks = xmlContent.match(sfdcConfigRegex) || [];

  for (const configBlock of configBlocks) {
    const connectionRegex = /<salesforce:([A-Za-z0-9_-]+)-connection\b[^>]*\/?>/g;
    for (const match of configBlock.matchAll(connectionRegex)) {
      const authType = match[1] || "";
      if (!authType) {
        continue;
      }
      authTypes.push({ salesforceAuthType: authType });
    }
  }

  return authTypes;
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
  analyzeState.salesforceAuthRows = [];
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
  if (targetTable === "salesforceAuthRows" || targetTable === "both") {
    analyzeState.salesforceAuthRows = analyzeState.salesforceAuthRows.map((row) =>
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
    body {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      color: #0f172a;
      background: linear-gradient(160deg, #f3fcff 0%, #eef4ff 50%, #f6f7ff 100%);
    }
    .container {
      max-width: 1120px;
      margin: 2rem auto;
      padding: 1.25rem 1.5rem 2rem;
      background: #ffffff;
      border: 1px solid #d9e7ff;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(82, 90, 255, 0.08);
    }
    h1 {
      margin-top: 0.25rem;
      margin-bottom: 1rem;
      font-size: 2rem;
      letter-spacing: -0.02em;
      color: #1a2a57;
    }
    button {
      margin-right: 0.75rem;
      margin-bottom: 0.75rem;
      padding: 0.62rem 1.05rem;
      border: 0;
      border-radius: 10px;
      background: linear-gradient(135deg, #4ab5b5 0%, #525aff 100%);
      color: #ffffff;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      box-shadow: 0 6px 14px rgba(82, 90, 255, 0.22);
      transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
    }
    button:hover { transform: translateY(-1px); box-shadow: 0 8px 18px rgba(82, 90, 255, 0.28); }
    button.secondary {
      background: linear-gradient(135deg, #6d8bc0 0%, #4ab5b5 100%);
      box-shadow: 0 6px 14px rgba(74, 181, 181, 0.22);
    }
    button:disabled { opacity: 0.62; cursor: not-allowed; transform: none; box-shadow: none; }
    .progress-wrap {
      margin-top: 1rem;
      padding: 0.85rem 1rem;
      border: 1px solid #d7e4ff;
      border-radius: 12px;
      background: #f8fbff;
    }
    progress {
      width: 100%;
      height: 14px;
      border: 0;
      border-radius: 999px;
      overflow: hidden;
      background-color: #dbeafe;
    }
    progress::-webkit-progress-bar { background-color: #dbeafe; border-radius: 999px; }
    progress::-webkit-progress-value {
      background: linear-gradient(90deg, #8fd9fb 0%, #4ab5b5 45%, #525aff 100%);
      border-radius: 999px;
    }
    progress::-moz-progress-bar {
      background: linear-gradient(90deg, #8fd9fb 0%, #4ab5b5 45%, #525aff 100%);
      border-radius: 999px;
    }
    .meta { margin-top: 0.5rem; color: #334155; font-size: 0.95rem; }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      border: 1px solid #d7e4ff;
      border-radius: 12px;
      overflow: hidden;
      background: #ffffff;
    }
    .table-scroll {
      margin-top: 0.75rem;
      max-height: 360px;
      overflow-y: auto;
      border-radius: 12px;
      box-shadow: inset 0 0 0 1px #d7e4ff;
    }
    th, td {
      border-bottom: 1px solid #e6eeff;
      padding: 0.62rem 0.72rem;
      text-align: left;
      vertical-align: top;
      font-size: 0.92rem;
    }
    th {
      background: linear-gradient(180deg, #f0f6ff 0%, #e7f3ff 100%);
      color: #1e3a8a;
      font-weight: 700;
      border-bottom: 1px solid #cfe0ff;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .filter-row th {
      position: sticky;
      top: 38px;
      background: #f8fbff;
      z-index: 2;
      padding: 0.4rem 0.52rem;
    }
    .filter-input, .filter-select {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #c9d8ff;
      border-radius: 8px;
      padding: 0.32rem 0.45rem;
      font-size: 0.82rem;
      color: #1e293b;
      background: #ffffff;
    }
    .filter-input:focus, .filter-select:focus {
      outline: none;
      border-color: #6d8bc0;
      box-shadow: 0 0 0 2px rgba(109, 139, 192, 0.18);
    }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) td { background: #fbfdff; }
    .table-header { margin-top: 1.1rem; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
    .table-header h3 { margin: 0; color: #1e3a8a; font-size: 1.06rem; }
    .table-header button { margin: 0; padding: 0.45rem 0.8rem; font-size: 0.88rem; }
    .status-new { color: #334155; font-weight: 600; }
    .status-downloading { color: #525aff; font-weight: 700; }
    .status-downloaded { color: #0f766e; font-weight: 700; }
    .status-skipped { color: #64748b; font-weight: 600; }
    .status-failed { color: #b91c1c; font-weight: 700; }
    .status-New { color: #334155; font-weight: 600; }
    .status-Analyzing { color: #525aff; font-weight: 700; }
    .status-Complete { color: #0f766e; font-weight: 700; }
    .status-Failed { color: #b91c1c; font-weight: 700; }
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
      <div class="meta" id="downloadTimeText">Start time: - | Complete time: -</div>
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Application Name</th>
            <th>File Name</th>
            <th>Status</th>
          </tr>
          <tr class="filter-row">
            <th><input id="downloadFilterAppName" class="filter-input" type="text" placeholder="Filter" /></th>
            <th><input id="downloadFilterFileName" class="filter-input" type="text" placeholder="Filter" /></th>
            <th>
              <select id="downloadFilterStatus" class="filter-select">
                <option value="">All</option>
                <option value="new">new</option>
                <option value="downloading">downloading</option>
                <option value="downloaded">downloaded</option>
                <option value="skipped">skipped</option>
                <option value="failed">failed</option>
              </select>
            </th>
          </tr>
        </thead>
        <tbody id="outputRows"></tbody>
      </table>
    </div>

    <div class="progress-wrap">
      <progress id="analyzeProgressBar" max="100" value="0"></progress>
      <div class="meta" id="analyzeProgressText">Analyze Progress: 0%</div>
      <div class="meta" id="analyzeTimeText">Start time: - | Complete time: -</div>
    </div>

    <div class="table-header">
      <h3>Dependencies</h3>
      <button id="downloadDependenciesCsvBtn" class="secondary">Download Result</button>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>File Name</th>
            <th>Application Name</th>
            <th>Dependency</th>
            <th>Version</th>
            <th>Status</th>
          </tr>
          <tr class="filter-row">
            <th><input id="depFilterFileName" class="filter-input" type="text" placeholder="Filter" /></th>
            <th><input id="depFilterAppName" class="filter-input" type="text" placeholder="Filter" /></th>
            <th><input id="depFilterDependency" class="filter-input" type="text" placeholder="Filter" /></th>
            <th><input id="depFilterVersion" class="filter-input" type="text" placeholder="Filter" /></th>
            <th>
              <select id="depFilterStatus" class="filter-select">
                <option value="">All</option>
                <option value="New">New</option>
                <option value="Analyzing">Analyzing</option>
                <option value="Complete">Complete</option>
                <option value="Failed">Failed</option>
              </select>
            </th>
          </tr>
        </thead>
        <tbody id="dependencyRows"></tbody>
      </table>
    </div>

    <div class="table-header">
      <h3>Source Event Type</h3>
      <button id="downloadSourceEventCsvBtn" class="secondary">Download Result</button>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>File Name</th>
            <th>Application Name</th>
            <th>Flow Name</th>
            <th>Source Event Type</th>
            <th>Status</th>
          </tr>
          <tr class="filter-row">
            <th><input id="sourceFilterFileName" class="filter-input" type="text" placeholder="Filter" /></th>
            <th><input id="sourceFilterAppName" class="filter-input" type="text" placeholder="Filter" /></th>
            <th><input id="sourceFilterFlowName" class="filter-input" type="text" placeholder="Filter" /></th>
            <th><input id="sourceFilterEventType" class="filter-input" type="text" placeholder="Filter" /></th>
            <th>
              <select id="sourceFilterStatus" class="filter-select">
                <option value="">All</option>
                <option value="New">New</option>
                <option value="Analyzing">Analyzing</option>
                <option value="Complete">Complete</option>
                <option value="Failed">Failed</option>
              </select>
            </th>
          </tr>
        </thead>
        <tbody id="sourceEventRows"></tbody>
      </table>
    </div>

    <div class="table-header">
      <h3>Salesforce Auth Type</h3>
      <button id="downloadSalesforceAuthCsvBtn" class="secondary">Download Result</button>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>File Name</th>
            <th>Application Name</th>
            <th>Salesforce Auth Type</th>
            <th>Status</th>
          </tr>
          <tr class="filter-row">
            <th><input id="sfFilterFileName" class="filter-input" type="text" placeholder="Filter" /></th>
            <th><input id="sfFilterAppName" class="filter-input" type="text" placeholder="Filter" /></th>
            <th><input id="sfFilterAuthType" class="filter-input" type="text" placeholder="Filter" /></th>
            <th>
              <select id="sfFilterStatus" class="filter-select">
                <option value="">All</option>
                <option value="New">New</option>
                <option value="Analyzing">Analyzing</option>
                <option value="Complete">Complete</option>
                <option value="Failed">Failed</option>
              </select>
            </th>
          </tr>
        </thead>
        <tbody id="salesforceAuthRows"></tbody>
      </table>
    </div>
  </div>

  <script>
    const progressBar = document.getElementById("progressBar");
    const progressText = document.getElementById("progressText");
    const downloadTimeText = document.getElementById("downloadTimeText");
    const outputRows = document.getElementById("outputRows");
    const downloadBtn = document.getElementById("downloadBtn");
    const analyzeBtn = document.getElementById("analyzeBtn");
    const analyzeProgressBar = document.getElementById("analyzeProgressBar");
    const analyzeProgressText = document.getElementById("analyzeProgressText");
    const analyzeTimeText = document.getElementById("analyzeTimeText");
    const dependencyRows = document.getElementById("dependencyRows");
    const sourceEventRows = document.getElementById("sourceEventRows");
    const salesforceAuthRows = document.getElementById("salesforceAuthRows");
    const downloadDependenciesCsvBtn = document.getElementById("downloadDependenciesCsvBtn");
    const downloadSourceEventCsvBtn = document.getElementById("downloadSourceEventCsvBtn");
    const downloadSalesforceAuthCsvBtn = document.getElementById("downloadSalesforceAuthCsvBtn");
    const downloadFilterAppName = document.getElementById("downloadFilterAppName");
    const downloadFilterFileName = document.getElementById("downloadFilterFileName");
    const downloadFilterStatus = document.getElementById("downloadFilterStatus");
    const depFilterFileName = document.getElementById("depFilterFileName");
    const depFilterAppName = document.getElementById("depFilterAppName");
    const depFilterDependency = document.getElementById("depFilterDependency");
    const depFilterVersion = document.getElementById("depFilterVersion");
    const depFilterStatus = document.getElementById("depFilterStatus");
    const sourceFilterFileName = document.getElementById("sourceFilterFileName");
    const sourceFilterAppName = document.getElementById("sourceFilterAppName");
    const sourceFilterFlowName = document.getElementById("sourceFilterFlowName");
    const sourceFilterEventType = document.getElementById("sourceFilterEventType");
    const sourceFilterStatus = document.getElementById("sourceFilterStatus");
    const sfFilterFileName = document.getElementById("sfFilterFileName");
    const sfFilterAppName = document.getElementById("sfFilterAppName");
    const sfFilterAuthType = document.getElementById("sfFilterAuthType");
    const sfFilterStatus = document.getElementById("sfFilterStatus");
    let downloadPollTimer = null;
    let analyzePollTimer = null;
    let latestDownloadStatus = { applications: [] };
    let latestAnalyzeStatus = {
      dependencyRows: [],
      sourceEventRows: [],
      salesforceAuthRows: [],
    };

    function escapeHtml(value) {
      return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function renderStatus(data) {
      latestDownloadStatus = data || latestDownloadStatus;
      progressBar.value = data.percentage || 0;
      const startTime = data.startedAt ? new Date(data.startedAt).toLocaleString() : "-";
      const completeTime = data.finishedAt ? new Date(data.finishedAt).toLocaleString() : "-";
      progressText.textContent =
        "Progress: " + (data.percentage || 0) + "% (" + data.processed + "/" + data.total + "), downloaded: " +
        data.downloaded + ", skipped: " + data.skipped + ", failed: " + data.failed;
      downloadTimeText.textContent = "Start time: " + startTime + " | Complete time: " + completeTime;

      renderDownloadRows(data.applications || []);
      
      if (!data.running && downloadPollTimer) {
        clearInterval(downloadPollTimer);
        downloadPollTimer = null;
        downloadBtn.disabled = false;
      }
    }

    function matchesFilterValue(value, filterText) {
      const text = String(value === undefined || value === null ? "" : value).toLowerCase();
      return text.includes(filterText.toLowerCase());
    }

    function renderDownloadRows(rows) {
      const appFilter = downloadFilterAppName.value.trim();
      const fileFilter = downloadFilterFileName.value.trim();
      const statusFilter = downloadFilterStatus.value.trim();
      outputRows.innerHTML = (rows || [])
        .filter((app) => {
          const appName = app.domain || "";
          const fileName = app.fileName || "";
          const status = app.status || "";
          return (
            (!appFilter || matchesFilterValue(appName, appFilter)) &&
            (!fileFilter || matchesFilterValue(fileName, fileFilter)) &&
            (!statusFilter || status === statusFilter)
          );
        })
        .map((app) => {
          const safeStatus = escapeHtml(app.status || "new");
          return "<tr>" +
            "<td>" + escapeHtml(app.domain || "") + "</td>" +
            "<td>" + escapeHtml(app.fileName || "") + "</td>" +
            "<td class=\\"status-" + safeStatus + "\\">" + safeStatus + "</td>" +
            "</tr>";
        })
        .join("");
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
      latestAnalyzeStatus = data || latestAnalyzeStatus;
      analyzeProgressBar.value = data.percentage || 0;
      const startTime = data.startedAt ? new Date(data.startedAt).toLocaleString() : "-";
      const completeTime = data.finishedAt ? new Date(data.finishedAt).toLocaleString() : "-";
      analyzeProgressText.textContent =
        "Analyze Progress: " + (data.percentage || 0) + "% (" + data.processed + "/" + data.total +
        "), complete: " + data.complete + ", failed: " + data.failed;
      analyzeTimeText.textContent = "Start time: " + startTime + " | Complete time: " + completeTime;
      renderDependencyRows(data.dependencyRows || []);
      renderSourceEventRows(data.sourceEventRows || []);
      renderSalesforceAuthRows(data.salesforceAuthRows || []);
      
      if (!data.running && analyzePollTimer) {
        clearInterval(analyzePollTimer);
        analyzePollTimer = null;
        analyzeBtn.disabled = false;
      }
    }

    function renderDependencyRows(rows) {
      const fileFilter = depFilterFileName.value.trim();
      const appFilter = depFilterAppName.value.trim();
      const dependencyFilter = depFilterDependency.value.trim();
      const versionFilter = depFilterVersion.value.trim();
      const statusFilter = depFilterStatus.value.trim();
      dependencyRows.innerHTML = (rows || [])
        .filter((row) =>
          (!fileFilter || matchesFilterValue(row.fileName, fileFilter)) &&
          (!appFilter || matchesFilterValue(row.applicationName, appFilter)) &&
          (!dependencyFilter || matchesFilterValue(row.dependency, dependencyFilter)) &&
          (!versionFilter || matchesFilterValue(row.version, versionFilter)) &&
          (!statusFilter || row.status === statusFilter)
        )
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
    }

    function renderSourceEventRows(rows) {
      const fileFilter = sourceFilterFileName.value.trim();
      const appFilter = sourceFilterAppName.value.trim();
      const flowFilter = sourceFilterFlowName.value.trim();
      const eventTypeFilter = sourceFilterEventType.value.trim();
      const statusFilter = sourceFilterStatus.value.trim();
      sourceEventRows.innerHTML = (rows || [])
        .filter((row) =>
          (!fileFilter || matchesFilterValue(row.fileName, fileFilter)) &&
          (!appFilter || matchesFilterValue(row.applicationName, appFilter)) &&
          (!flowFilter || matchesFilterValue(row.flowName, flowFilter)) &&
          (!eventTypeFilter || matchesFilterValue(row.sourceEventType, eventTypeFilter)) &&
          (!statusFilter || row.status === statusFilter)
        )
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
    }

    function renderSalesforceAuthRows(rows) {
      const fileFilter = sfFilterFileName.value.trim();
      const appFilter = sfFilterAppName.value.trim();
      const authTypeFilter = sfFilterAuthType.value.trim();
      const statusFilter = sfFilterStatus.value.trim();
      salesforceAuthRows.innerHTML = (rows || [])
        .filter((row) =>
          (!fileFilter || matchesFilterValue(row.fileName, fileFilter)) &&
          (!appFilter || matchesFilterValue(row.applicationName, appFilter)) &&
          (!authTypeFilter || matchesFilterValue(row.salesforceAuthType, authTypeFilter)) &&
          (!statusFilter || row.status === statusFilter)
        )
        .map((row) => {
          const safeStatus = escapeHtml(row.status || "New");
          return "<tr>" +
            "<td>" + escapeHtml(row.fileName || "") + "</td>" +
            "<td>" + escapeHtml(row.applicationName || "") + "</td>" +
            "<td>" + escapeHtml(row.salesforceAuthType || "") + "</td>" +
            "<td class=\\"status-" + safeStatus + "\\">" + safeStatus + "</td>" +
            "</tr>";
        })
        .join("");
    }

    async function fetchAnalyzeStatus() {
      const response = await fetch("/api/analyze-status");
      const data = await response.json();
      renderAnalyzeStatus(data);
    }

    function toCsvValue(value) {
      const text = value === undefined || value === null ? "" : String(value);
      return '"' + text.replaceAll('"', '""') + '"';
    }

    function buildCsvContent(headers, rows, rowMapper) {
      const headerLine = headers.map(toCsvValue).join(",");
      const dataLines = (rows || []).map((row) => rowMapper(row).map(toCsvValue).join(","));
      return [headerLine].concat(dataLines).join("\\n");
    }

    async function saveCsv(fileName, csvContent) {
      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: fileName,
            types: [
              {
                description: "CSV file",
                accept: { "text/csv": [".csv"] },
              },
            ],
          });
          const writable = await handle.createWritable();
          await writable.write(csvContent);
          await writable.close();
          return;
        } catch (error) {
          // Fall back to browser download when picker is cancelled or unsupported.
        }
      }

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
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

    downloadDependenciesCsvBtn.addEventListener("click", async () => {
      const csvContent = buildCsvContent(
        ["File Name", "Application Name", "Dependency", "Version", "Status"],
        latestAnalyzeStatus.dependencyRows || [],
        (row) => [row.fileName, row.applicationName, row.dependency, row.version, row.status]
      );
      await saveCsv("dependencies-result.csv", csvContent);
    });

    downloadSourceEventCsvBtn.addEventListener("click", async () => {
      const csvContent = buildCsvContent(
        ["File Name", "Application Name", "Flow Name", "Source Event Type", "Status"],
        latestAnalyzeStatus.sourceEventRows || [],
        (row) => [row.fileName, row.applicationName, row.flowName, row.sourceEventType, row.status]
      );
      await saveCsv("source-event-type-result.csv", csvContent);
    });

    downloadSalesforceAuthCsvBtn.addEventListener("click", async () => {
      const csvContent = buildCsvContent(
        ["File Name", "Application Name", "Salesforce Auth Type", "Status"],
        latestAnalyzeStatus.salesforceAuthRows || [],
        (row) => [row.fileName, row.applicationName, row.salesforceAuthType, row.status]
      );
      await saveCsv("salesforce-auth-type-result.csv", csvContent);
    });

    function registerFilterListeners() {
      const downloadFilterEls = [downloadFilterAppName, downloadFilterFileName, downloadFilterStatus];
      const depFilterEls = [depFilterFileName, depFilterAppName, depFilterDependency, depFilterVersion, depFilterStatus];
      const sourceFilterEls = [
        sourceFilterFileName,
        sourceFilterAppName,
        sourceFilterFlowName,
        sourceFilterEventType,
        sourceFilterStatus,
      ];
      const sfFilterEls = [sfFilterFileName, sfFilterAppName, sfFilterAuthType, sfFilterStatus];

      downloadFilterEls.forEach((el) =>
        el.addEventListener("input", () => renderDownloadRows(latestDownloadStatus.applications || []))
      );
      depFilterEls.forEach((el) =>
        el.addEventListener("input", () => renderDependencyRows(latestAnalyzeStatus.dependencyRows || []))
      );
      sourceFilterEls.forEach((el) =>
        el.addEventListener("input", () => renderSourceEventRows(latestAnalyzeStatus.sourceEventRows || []))
      );
      sfFilterEls.forEach((el) =>
        el.addEventListener("input", () => renderSalesforceAuthRows(latestAnalyzeStatus.salesforceAuthRows || []))
      );
    }

    registerFilterListeners();
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
