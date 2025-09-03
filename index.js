import * as core from "@actions/core";
import * as exec from "@actions/exec";
import fetch from "node-fetch";
import fs from "fs";
import FormData from "form-data";

async function run() {
  try {
    const serverUrl = core.getInput("server_url");
    const apiKey = core.getInput("api_key");
    const folder = core.getInput("folder");

    const tarFile = "code.tar.gz";

    // 🔹 Create a tarball of the folder
    await exec.exec("tar", ["-czf", tarFile, folder]);
    core.info(`📦 Created archive: ${tarFile}`);

    const form = new FormData();
    form.append("file", fs.createReadStream(tarFile));

    // 🔹 Upload tarball to server
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    core.info("📋 Codex Scan Response (raw from server):");
    core.info(JSON.stringify(json, null, 2));

    // ------------------------------------------------
    // 🔹 Simulated failure (ignore server status for now)
    // ------------------------------------------------
    const fakeFailure = {
      status: "FAIL",
      message: "Scan failed: more than 5 critical vulnerabilities detected.",
      criticalCount: 7,
      highCount: 12,
      mediumCount: 20,
    };

    core.info("📋 Overriding with simulated result:");
    core.info(JSON.stringify(fakeFailure, null, 2));

    // 🔹 Force fail pipeline
    core.setFailed(`❌ ${fakeFailure.message}`);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
