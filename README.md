# gate-image

Block a vulnerable container image **before it is pushed**.

Scans the image your job just built — in the runner, straight from the local Docker daemon — and
fails the build if it violates your security policy. Nothing is pushed and nothing is uploaded, so
a bad image never reaches a registry in the first place.

```yaml
      - name: Build image
        run: docker build -t my-app:${{ github.sha }} .

      - name: Gate the image
        uses: o3security/gate-image@main
        with:
          api_key: ${{ secrets.O3_API_KEY }}
          image_name: my-app:${{ github.sha }}
          scan_types: SCA,SECRET

      # Only reached when the gate passes.
      - name: Push image
        run: docker push my-app:${{ github.sha }}
```

## Why a gate, not a scanner

Most tools scan and print. This one **decides**: findings are evaluated against your policy
server-side, and the verdict fails the step, so `docker push` never runs. The same evaluation
backs pull-request checks and the dashboard — a build that fails in CI shows the same reasons in
the console.

## What it finds

**Software composition**

- OS packages — apk, dpkg, rpm databases inside the image
- Application dependencies — npm, PyPI, Go, Maven, RubyGems, resolved from manifests **inside the
  image**. A registry-style image scan reads only OS databases, so a vulnerable `node_modules` is
  invisible to it.
- EOL distro CVEs from O3's own vulnerability database, for distributions upstream sources no
  longer publish advisories for

Enriched exactly as a server-side scan: CVE detail, CVSS severity, EPSS probability, known
exploits, fixed versions.

**Secrets**

Credentials baked into the image's layers — copied in by a `COPY`, written by a `RUN`, or
inherited from a base image. Your organisation's custom and disabled secret rules apply.

## Speed

Measured on `ubuntu-latest`, two images:

| | 877 MB `node:12` | 899 MB `node:16` |
|---|---|---|
| Scanner download (~30 MB) | ~1s | ~1s |
| Scan (SCA + secrets) | 62s | 158s |
| **Whole job**, incl. `docker build` | **~95s** | **~210s** |

Scan time tracks the number of packages, not image size: the second image carries
74 application manifests against the first's one, so enrichment does far more work.

The scan engine ships as a ~4.9 GB image server-side; this runs the same engine from a ~30 MB
bundle, so a runner can fetch it in about a second.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api_key` | yes | — | O3 API key. Always via `secrets`. |
| `image_name` | one of | — | Image built by this job — scanned in the runner. |
| `image_uri` | one of | — | Image already in a registry; the platform pulls it. |
| `repo_url` | one of | — | Source tree; scanned on the platform (supports SAST). |
| `scan_types` | yes | — | `SCA`, `SECRET`, `SAST` (source only). |
| `server_url` | no | `https://api.o3.security` | API base URL. |
| `fail_on_policy` | no | `true` | `false` reports without blocking. |
| `registry_id` | no | — | Registry connection id, for a private `image_uri`. |
| `folder` | no | `.` | Directory scanned for secrets; also the source root with `repo_url`. |
| `timeout_minutes` | no | `20` | Upper bound before the step fails. |

One input selects what gets scanned — there is no mode to set. `mode` is still
accepted for workflows written against the previous release, but it selects
nothing the inputs above do not.

## Outputs

| Output | Description |
|---|---|
| `job_id` | Scan job id — links to the finding in the console |
| `policy_status` | `PASS`, `FAIL`, `NOT_EVALUATED` |
| `denied_count` | Number of blocking violations |

`NOT_EVALUATED` means no policy is configured for the namespace — surfaced as a warning, because a
green build with nothing enforced is not the same as a clean one.

## Requirements

Docker on the runner (already present on GitHub-hosted runners) and outbound HTTPS to
`storage.googleapis.com` for the scanner bundle and `api.o3.security` for the verdict.

Nothing about the image leaves the runner — no layers, no filesystem. What travels to the API is
finding metadata: package names and versions, CVE ids, and the path plus rule id of a matched
secret.

`linux/amd64` and `linux/arm64` are both supported; the architecture is detected automatically.

The bundle carries the secret-detection ruleset alongside the binaries, so the runner
needs no rule assets of its own. A bundle missing it fails the step rather than
scanning with an empty ruleset — which would report zero secrets and look like a pass.

## Documentation

[docs.o3.security/docs/image-security](https://docs.o3.security/docs/image-security/overview)

## Development

```bash
npm install
npm run build      # bundles index.js -> dist/index.js via ncc
```

`dist/` is committed and is what the runner executes — rebuild and commit it with any source
change.
