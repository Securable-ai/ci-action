import * as core from "@actions/core";
import * as exec from "@actions/exec";
import fs from "fs";
import path from "path";
import { request as undiciRequest } from "undici";

const POLL_INTERVAL_MS = 5000;
const TERMINAL_FAILURE_STATUSES = new Set(["FAILED", "CANCELLED", "TIMEOUT"]);

const joinUrl = (base, suffix) =>
  base + (base.endsWith("/") ? "" : "/") + suffix;

/** POST a GraphQL document and return `data`, throwing on transport/GraphQL errors. */
async function graphql(graphqlUrl, apiKey, query, variables) {
  const res = await undiciRequest(graphqlUrl, {
    method: "POST",
    headers: {
      Authorization: `apikey ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const raw = await res.body.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${res.statusCode} from API — non-JSON response: ${raw.slice(0, 500)}`);
  }

  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`${res.statusCode} from API: ${raw.slice(0, 500)}`);
  }
  return json.data;
}

/**
 * Upload the archive and return a URL the scanner can read.
 *
 * Servers report which flow they support via GET /upload/mode: SaaS mints a
 * presigned PUT (bytes bypass the backend and any proxy body-size limit),
 * on-prem takes a multipart POST. Older builds have neither, so a 404 falls
 * back to the direct flow rather than failing the run.
 */
async function uploadArchive(serverUrl, apiKey, tarFile) {
  const auth = { Authorization: `apikey ${apiKey}` };
  const bytes = fs.readFileSync(tarFile);
  const filename = path.basename(tarFile);

  let mode = "direct";
  const modeRes = await undiciRequest(joinUrl(serverUrl, "upload/mode"), { headers: auth });
  const modeBody = await modeRes.body.text();
  if (modeRes.statusCode === 200) {
    try {
      mode = JSON.parse(modeBody).mode || "direct";
    } catch {
      /* unparseable — keep the direct default */
    }
  } else if (modeRes.statusCode === 401 || modeRes.statusCode === 403) {
    throw new Error(`API key rejected by ${serverUrl} (HTTP ${modeRes.statusCode}). Check the api_key input.`);
  }
  core.info(`Upload mode: ${mode}`);

  if (mode === "presigned") {
    const presign = await undiciRequest(joinUrl(serverUrl, "upload/presign"), {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ filename, contentType: "application/gzip" }),
    });
    const presignRaw = await presign.body.text();
    if (presign.statusCode < 200 || presign.statusCode >= 300) {
      throw new Error(`Presign failed: ${presign.statusCode} - ${presignRaw.slice(0, 500)}`);
    }
    const { uploadUrl, fileUrl } = JSON.parse(presignRaw);
    if (!uploadUrl || !fileUrl) throw new Error("Presign response missing uploadUrl/fileUrl");

    const put = await undiciRequest(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/gzip" },
      body: bytes,
    });
    await put.body.text();
    if (put.statusCode < 200 || put.statusCode >= 300) {
      throw new Error(`Upload PUT failed: ${put.statusCode}`);
    }
    return fileUrl;
  }

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/gzip" }), filename);
  const res = await undiciRequest(joinUrl(serverUrl, "upload"), {
    method: "POST",
    headers: auth,
    body: form,
  });
  const raw = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Upload failed: ${res.statusCode} - ${raw.slice(0, 500)}`);
  }
  const json = JSON.parse(raw);
  const url = json.s3Response?.signed_url || json.fileUrl;
  if (!url) throw new Error("No file URL returned from upload");
  return url;
}

/** Poll until the job reaches a terminal state, or the timeout elapses. */
async function waitForJob(graphqlUrl, apiKey, jobId, timeoutMs) {
  const query = `query($jobId: String!) { getJobDetail(jobId: $jobId) { data } }`;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    const data = await graphql(graphqlUrl, apiKey, query, { jobId });
    const status = data?.getJobDetail?.data?.status;

    if (status && status !== lastStatus) {
      core.info(`Scan status: ${status}`);
      lastStatus = status;
    }
    if (status === "COMPLETED") return { completed: true, status };
    // FAILED_WITH_RESULTS still carries findings — let the policy gate judge it.
    if (TERMINAL_FAILURE_STATUSES.has(status)) return { completed: false, status };

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { completed: false, status: lastStatus, timedOut: true };
}

async function run() {
  try {
    const serverUrl = core.getInput("server_url").replace(/\/+$/, "");
    const graphqlUrl = joinUrl(serverUrl, "graphql");
    const apiKey = core.getInput("api_key");
    const repoUrl = core.getInput("repo_url");
    const imageUri = core.getInput("image_uri");
    const registryId = core.getInput("registry_id");
    const failOnPolicy = core.getBooleanInput("fail_on_policy");
    const timeoutMs = Number(core.getInput("timeout_minutes") || 20) * 60 * 1000;

    const scanTypes = core
      .getInput("scan_types")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (scanTypes.length === 0) throw new Error("scan_types must list at least one scan type");

    let jobId;

    if (imageUri) {
      // Container-image scan: the registry is the source of truth, so there are
      // no bytes to upload — the platform pulls the image itself.
      core.info(`Scheduling container image scan: ${imageUri}`);
      const mutation = `mutation($image_uri: String!, $registry_id: ID, $scanTypes: [String!]) {
        ScheduleContainerImageScan(image_uri: $image_uri, registry_id: $registry_id, scanTypes: $scanTypes) {
          message status data
        }
      }`;
      const data = await graphql(graphqlUrl, apiKey, mutation, {
        image_uri: imageUri,
        registry_id: registryId || null,
        scanTypes,
      });
      const result = data?.ScheduleContainerImageScan;
      if (result?.status !== "success") {
        throw new Error(`Failed to schedule image scan: ${JSON.stringify(result)}`);
      }
      jobId = result.data?.jobId;
    } else {
      if (!repoUrl) throw new Error("Provide either repo_url (source scan) or image_uri (container scan)");

      const tarFile = `repo-${Math.random().toString(36).slice(2, 10)}.tar.gz`;
      await exec.exec("git", ["archive", "--format=tar.gz", "-o", tarFile, "HEAD"]);
      core.info(`Created repo archive: ${tarFile}`);

      const codeZipUrl = await uploadArchive(serverUrl, apiKey, tarFile);
      fs.unlinkSync(tarFile);

      const mutation = `mutation($repoUrls: [String], $scanTypes: [String!], $code_zip: String, $branch: String, $commit_id: String) {
        ScheduleScan(
          repoUrls: $repoUrls,
          assetType: "githubRepos",
          scanTypes: $scanTypes,
          code_zip: $code_zip,
          branch: $branch,
          commit_id: $commit_id,
          quick_scan: true,
          via: "cli"
        ) { message status data }
      }`;
      const data = await graphql(graphqlUrl, apiKey, mutation, {
        repoUrls: [repoUrl],
        scanTypes,
        code_zip: codeZipUrl,
        branch: process.env.GITHUB_REF_NAME || null,
        commit_id: process.env.GITHUB_SHA || null,
      });
      const result = Array.isArray(data?.ScheduleScan) ? data.ScheduleScan[0] : data?.ScheduleScan;
      if (result?.status !== "success") {
        throw new Error(`Failed to schedule scan: ${JSON.stringify(result)}`);
      }
      jobId = result.data?._id;
    }

    if (!jobId) throw new Error("No jobId returned from the API");
    core.info(`Scan job: ${jobId}`);
    core.setOutput("job_id", jobId);

    const { completed, status, timedOut } = await waitForJob(graphqlUrl, apiKey, jobId, timeoutMs);
    if (timedOut) {
      // Don't green a pipeline we never got a verdict for.
      core.setFailed(`Scan did not finish within ${timeoutMs / 60000} minutes (last status: ${status}).`);
      return;
    }
    if (!completed) {
      core.setFailed(`Scan ended in status ${status} — no policy verdict available.`);
      return;
    }

    const policyQuery = `query($jobId: ID!) { checkJobPolicy(jobId: $jobId) { message status data } }`;
    const policyData = await graphql(graphqlUrl, apiKey, policyQuery, { jobId });
    const policy = policyData?.checkJobPolicy;
    if (!policy) throw new Error("No policy verdict returned");

    const denied = policy.data?.denied || [];
    const warnings = policy.data?.warnings || [];
    const policyStatus = policy.data?.policy_status;

    core.setOutput("policy_status", policyStatus || (denied.length ? "FAIL" : "PASS"));
    core.setOutput("denied_count", String(denied.length));

    if (warnings.length > 0) {
      core.warning(`Policy warnings:\n${warnings.map((w) => `- ${w.reason}`).join("\n")}`);
    }

    if (policyStatus === "NOT_EVALUATED") {
      core.warning(
        "No security policy is configured for this project's namespace — nothing was enforced. " +
          "Add a policy in the O3 console for this gate to be meaningful."
      );
    }

    if (denied.length > 0) {
      const msg = `Policy denied (${denied.length}):\n${denied.map((d) => `- ${d.reason}`).join("\n")}`;
      if (failOnPolicy) {
        core.setFailed(msg);
      } else {
        core.warning(`${msg}\n(fail_on_policy is false — not failing the build)`);
      }
      return;
    }

    // policy_status can be FAIL while denied[] is empty on older servers that
    // only shaped the verdict for PR jobs — treat that as a failure, not a pass,
    // so the gate can't be silently bypassed.
    if (policyStatus === "FAIL" && failOnPolicy) {
      core.setFailed(
        "Policy evaluation reported FAIL but returned no findings — refusing to pass. " +
          "Update the O3 backend to a build that returns the verdict for non-PR jobs."
      );
      return;
    }

    core.info("Scan completed and passed the policy check");
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
