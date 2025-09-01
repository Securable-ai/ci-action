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
    const mode = core.getInput("mode");
    const imageName = core.getInput("image_name");

    const zipFile = mode === "docker" ? "docker-image.tar" : "code.zip";

    if (mode === "docker") {
      if (!imageName) {
        throw new Error("image_name is required when mode=docker");
      }
      // save docker image
      await exec.exec("docker", ["save", imageName, "-o", zipFile]);
    } else {
      // zip folder
      await exec.exec("zip", ["-r", zipFile, folder]);
    }

    const form = new FormData();
    form.append("file", fs.createReadStream(zipFile));

    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    core.info("📋 Codex Scan Response:");
    core.info(JSON.stringify(json, null, 2));

    if (json.status && json.status.toUpperCase() === "FAIL") {
      core.setFailed("❌ Codex SCA issues found, failing pipeline.");
    } else {
      core.info("✅ Codex scan passed with no blocking issues.");
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
