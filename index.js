#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const TOKEN_URL = "https://anypoint.mulesoft.com/accounts/api/v2/oauth2/token";
const APPLICATIONS_URL = "https://anypoint.mulesoft.com/cloudhub/api/v2/applications";
const DOWNLOAD_URL_TEMPLATE =
  "https://anypoint.mulesoft.com/cloudhub/api/applications/{domain}/download/{fileName}";
const DOWNLOAD_DIR = "mule-apps";

async function main() {
  const [, , clientId, clientSecret] = process.argv;

  if (!clientId || !clientSecret) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    const accessToken = await getAccessToken(clientId, clientSecret);
    const applications = await getApplications(accessToken);

    if (!Array.isArray(applications) || applications.length === 0) {
      console.log("No applications returned from CloudHub.");
      return;
    }

    await fs.mkdir(DOWNLOAD_DIR, { recursive: true });

    let downloadedCount = 0;
    let skippedCount = 0;

    for (const app of applications) {
      const domain = app?.domain;
      const fileName = app?.fileName;

      if (!domain || !fileName) {
        console.warn("Skipping application with missing domain/fileName.");
        continue;
      }

      const targetPath = path.join(DOWNLOAD_DIR, fileName);
      const alreadyExists = await fileExists(targetPath);

      if (alreadyExists) {
        skippedCount += 1;
        console.log(`Skipping existing file: ${fileName}`);
        continue;
      }

      await downloadApplicationJar(accessToken, domain, fileName, targetPath);
      downloadedCount += 1;
      console.log(`Downloaded: ${fileName}`);
    }

    console.log(
      `Done. Downloaded ${downloadedCount} file(s), skipped ${skippedCount} existing file(s).`
    );
  } catch (error) {
    console.error(`Failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function printUsage() {
  console.log("Usage:");
  console.log("  node mule-app-analyzer <connected_app_client_id> <connected_app_client_secret>");
  console.log("  # or");
  console.log("  node index.js <connected_app_client_id> <connected_app_client_secret>");
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
