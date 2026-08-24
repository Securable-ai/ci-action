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
async function uploadArchive(serverUrl, apiKey, tarFile, contentType = "application/gzip") {
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
      body: JSON.stringify({ filename, contentType }),
    });
    const presignRaw = await presign.body.text();
    if (presign.statusCode < 200 || presign.statusCode >= 300) {
      throw new Error(`Presign failed: ${presign.statusCode} - ${presignRaw.slice(0, 500)}`);
    }
    const { uploadUrl, fileUrl } = JSON.parse(presignRaw);
    if (!uploadUrl || !fileUrl) throw new Error("Presign response missing uploadUrl/fileUrl");

    const put = await undiciRequest(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
    await put.body.text();
    if (put.statusCode < 200 || put.statusCode >= 300) {
      throw new Error(`Upload PUT failed: ${put.statusCode}`);
    }
    return fileUrl;
  }

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), filename);
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

// Public GCS, not the GitHub release: o3-ci is a private repo, so a customer's
// runner gets a 404 from its releases. This bucket is world-readable, so the
// download needs no credentials.
const SCANNER_RELEASE = "https://storage.googleapis.com/o3-releases/o3-ci/latest";

/**
 * Download and unpack the scan bundle, returning the directory holding it.
 *
 * The bundle carries o3-ci plus the two tools the engine shells out to —
 * osv-scanner and gitleaks — so a runner needs nothing preinstalled beyond
 * docker, which GitHub-hosted runners already have. Extracting them all into one
 * directory and putting it first on PATH is what lets the engine find them.
 *
 * Re-downloaded per job (~35 MB, a couple of seconds). Callers that want it
 * cached should wrap the step with actions/cache keyed on runner.arch.
 */
async function ensureScanner() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const dir = path.join(process.env.RUNNER_TEMP || "/tmp", "o3-scanner");
  const marker = path.join(dir, "o3-ci");
  if (fs.existsSync(marker)) return dir;

  fs.mkdirSync(dir, { recursive: true });
  const url = `${SCANNER_RELEASE}/o3-ci_linux_${arch}.tar.gz`;
  core.info(`Fetching scanner bundle (${arch})…`);

  const res = await undiciRequest(url, { maxRedirections: 5 });
  if (res.statusCode !== 200) {
    throw new Error(`Failed to download scanner bundle: HTTP ${res.statusCode} from ${url}`);
  }
  const tarPath = path.join(dir, "bundle.tar.gz");
  fs.writeFileSync(tarPath, Buffer.from(await res.body.arrayBuffer()));
  await exec.exec("tar", ["-xzf", tarPath, "-C", dir]);
  fs.unlinkSync(tarPath);

  for (const tool of ["o3-ci", "osv-scanner", "gitleaks"]) {
    const p = path.join(dir, tool);
    if (!fs.existsSync(p)) throw new Error(`Scanner bundle is missing ${tool}`);
    fs.chmodSync(p, 0o755);
  }
  core.info("Scanner ready: o3-ci, osv-scanner, gitleaks");
  return dir;
}

/** Ask the platform for the policy verdict and fail the build on denials. */
async function gate(graphqlUrl, apiKey, jobId, failOnPolicy) {
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
}

async function run() {
  try {
    const serverUrl = core.getInput("server_url").replace(/\/+$/, "");
    const graphqlUrl = joinUrl(serverUrl, "graphql");
    const apiKey = core.getInput("api_key");
    const repoUrl = core.getInput("repo_url");
    const imageUri = core.getInput("image_uri");
    const registryId = core.getInput("registry_id");
    const imageName = core.getInput("image_name");
    // `mode` is a legacy selector: image_name already says "an image in this
    // runner", so the two could disagree. Kept working for existing workflows,
    // but the input alone decides the path — same as image_uri and repo_url.
    const mode = (core.getInput("mode") || "").toLowerCase();
    if (mode && mode !== "source" && mode !== "docker") {
      throw new Error(`Unknown mode '${mode}'. Set image_name, image_uri or repo_url instead.`);
    }
    const scanLocalImage = Boolean(imageName) || mode === "docker";
    const failOnPolicy = core.getBooleanInput("fail_on_policy");
    const timeoutMs = Number(core.getInput("timeout_minutes") || 20) * 60 * 1000;

    const scanTypes = core
      .getInput("scan_types")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (scanTypes.length === 0) throw new Error("scan_types must list at least one scan type");

    let jobId;

    if (scanLocalImage) {
      // Gate an image BEFORE it is pushed: it exists only in this runner's Docker
      // daemon, so there is nothing to pull and nothing worth uploading. Scan it
      // here with o3-ci — the same engine the platform runs server-side, built
      // small enough to download — and report against a job so the policy gate
      // decides in one place.
      if (!imageName) throw new Error("image_name is required to scan a locally built image");

      const mutation = `mutation($image_uri: String, $scanTypes: [String!]) {
        ScheduleScan(
          repoUrls: [],
          assetType: "containerImage",
          image_uri: $image_uri,
          scanTypes: $scanTypes,
          via: "cli"
        ) { message status data }
      }`;
      const data = await graphql(graphqlUrl, apiKey, mutation, {
        image_uri: imageName,
        scanTypes,
      });
      const result = Array.isArray(data?.ScheduleScan) ? data.ScheduleScan[0] : data?.ScheduleScan;
      if (result?.status !== "success") {
        throw new Error(`Failed to schedule image scan: ${JSON.stringify(result)}`);
      }
      // This branch returns the job id as a bare string; the source path returns
      // an object. Accept both so one reader works for either.
      jobId = typeof result.data === "string" ? result.data : result.data?._id;
      if (!jobId) throw new Error("No jobId returned from the API");
      core.info(`Scan job: ${jobId}`);
      core.setOutput("job_id", jobId);

      const scannerDir = await ensureScanner();
      // The scan uploads its own findings, so there is no job to poll — go
      // straight to the verdict once it returns.
      await exec.exec(path.join(scannerDir, "o3-ci"), [
        "--job-id", jobId,
        "--image", imageName,
        "--path", core.getInput("folder") || ".",
        "--server-url", graphqlUrl,
        "--api-key", apiKey,
        "--scan-types", scanTypes.join(","),
        ...(process.env.GITHUB_REF_NAME ? ["--branch", process.env.GITHUB_REF_NAME] : []),
        ...(process.env.GITHUB_SHA ? ["--commit-sha", process.env.GITHUB_SHA] : []),
      ], { env: { ...process.env, PATH: `${scannerDir}:${process.env.PATH}` } });

      return await gate(graphqlUrl, apiKey, jobId, failOnPolicy);
    } else if (imageUri) {
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

    return await gate(graphqlUrl, apiKey, jobId, failOnPolicy);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
