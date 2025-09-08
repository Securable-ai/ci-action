import * as core from "@actions/core";
import * as exec from "@actions/exec";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import {
  request as undiciRequest,
  FormData as UndiciFormData,
  File as UndiciFile,
} from "undici";

async function run() {
  try {
    const serverUrl = core.getInput("server_url");
    const graphqlUrl =
      serverUrl + (serverUrl.endsWith("/") ? "" : "/") + "graphql";
    const apiKey = core.getInput("api_key");

    // Inputs for mutation
    const repoUrl = core.getInput("repo_url"); // single repo URL
    const scanTypesInput = core.getInput("scan_types"); // comma-separated list
    // Generate random tar.gz filename
    const randomSuffix = Math.random().toString(36).substring(2, 10);
    const tarFile = `repo-${randomSuffix}.tar.gz`;

    // Parse scanTypes as array
    const scanTypes = scanTypesInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Archive only tracked git files at HEAD
    await exec.exec("git", ["archive", "--format=tar.gz", "-o", tarFile, "HEAD"]);
    core.info(`📦 Created repo archive: ${tarFile}`);

    // Upload tar.gz to /upload-to-bucket to get signed_url
    const uploadUrl =
      serverUrl + (serverUrl.endsWith("/") ? "" : "/") + "upload-to-bucket";
    const uploadApiKey = core.getInput("upload_api_key") || apiKey;

    const undiciForm = new UndiciFormData();
    undiciForm.append(
      "file",
      new UndiciFile([fs.readFileSync(tarFile)], path.basename(tarFile), {
        type: "application/gzip",
      })
    );

    const undiciRes = await undiciRequest(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `apikey ${uploadApiKey}`,
      },
      body: undiciForm,
    });

    // --- FIXED: read body only once ---
    const rawText = await undiciRes.body.text();
    core.info("📋 Upload Response (raw):");
    core.info(rawText);

    let uploadJson;
    try {
      uploadJson = JSON.parse(rawText);
    } catch (e) {
      throw new Error(
        `Upload failed: ${undiciRes.statusCode} ${undiciRes.statusMessage} - ${rawText}`
      );
    }

    if (undiciRes.statusCode < 200 || undiciRes.statusCode >= 300) {
      throw new Error(
        `Upload failed: ${undiciRes.statusCode} ${undiciRes.statusMessage} - ${JSON.stringify(
          uploadJson
        )}`
      );
    }

    const codeZipUrl = uploadJson.s3Response?.signed_url || uploadJson.fileUrl;
    if (!codeZipUrl) {
      throw new Error("No signed_url returned from upload");
    }

    // Prepare GraphQL mutation
    const mutation = `mutation {
      ScheduleScan(
        repoUrls: ["${repoUrl}"],
        assetType: "githubRepos",
        scanTypes: [${scanTypes.map((t) => `"${t}"`).join(",")}],
        code_zip: "${codeZipUrl}",
        quick_scan: true,
        via: "web"
      ) {
        message
        status
        data
      }
    }`;
    core.info("📋 ScheduleScan Mutation:")
    core.info(mutation);
    // Send mutation to server
    const res = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `apikey ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: mutation }),
    });

    let json;
    try {
      const json = await res.json();
      core.info("📋 Codex Scan Response (raw from server):");
      core.info(JSON.stringify(json, null, 2));

      // Check for success status in response
      let scanStatus = null;
      let scanMessage = null;
      if (json && json.data && json.data.ScheduleScan && Array.isArray(json.data.ScheduleScan)) {
        scanStatus = json.data.ScheduleScan[0]?.status;
        scanMessage = json.data.ScheduleScan[0]?.message;
      }

      if (typeof scanStatus === "string" && scanStatus.toLowerCase() === "success") {
        core.info(`✅ ${scanMessage || "Scan job scheduled successfully."}`);
      } else {
        core.setFailed(`❌ Scan failed - ${JSON.stringify(json)}`);
      }
        `❌ ${
          json.data?.ScheduleScan?.message || "Scan failed"
        } - ${JSON.stringify(json)}`
      );
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
