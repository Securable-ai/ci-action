# O3 Security CI Action

Scans a repository or a built container image with O3 Security and fails the
pipeline when the org's policy gate denies.

## Usage

### Gate a Docker image before pushing to GAR / Docker Hub

Build locally, scan, and only push if the gate passes. Because the image is
scanned before the `push` step, a denied policy stops the artifact from ever
reaching the registry.

```yaml
name: Build, Scan, Push

on:
  pull_request:
  push:
    branches: [ main ]

permissions:
  contents: read
  id-token: write   # for keyless auth to GAR

jobs:
  build-scan-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 1. Source-level gate — dependencies, code, secrets.
      - name: Scan source
        uses: o3security/ci-action@main
        with:
          server_url: https://api.o3.security
          api_key: ${{ secrets.O3_API_KEY }}
          repo_url: https://github.com/${{ github.repository }}.git
          scan_types: SCA,SAST,SECRET

      - name: Build image
        run: docker build -t "$IMAGE" .
        env:
          IMAGE: asia-south1-docker.pkg.dev/my-project/my-repo/app:${{ github.sha }}

      # 2. Image gate — OS packages and secrets baked into the layers.
      #    The platform pulls the image, so it must be reachable: push to a
      #    staging tag first, or scan from a registry O3 has a connection to.
      - name: Scan image
        uses: o3security/ci-action@main
        with:
          server_url: https://api.o3.security
          api_key: ${{ secrets.O3_API_KEY }}
          image_uri: asia-south1-docker.pkg.dev/my-project/my-repo/app:${{ github.sha }}
          registry_id: ${{ secrets.O3_REGISTRY_ID }}
          scan_types: SCA,SECRET

      # 3. Only reached when both gates pass.
      - name: Push image
        run: docker push "$IMAGE"
        env:
          IMAGE: asia-south1-docker.pkg.dev/my-project/my-repo/app:${{ github.sha }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `server_url` | yes | `https://api.o3.security` | API base URL |
| `api_key` | yes | — | API key. **Always pass via `secrets`.** |
| `repo_url` | one of | — | Repo to scan (source scan) |
| `image_uri` | one of | — | Image to scan. Takes precedence over `repo_url`. |
| `registry_id` | no | — | O3 registry-connection id for private images |
| `scan_types` | yes | — | `SAST`, `SCA`, `SECRET` (comma-separated). Images support `SCA`, `SECRET`. |
| `fail_on_policy` | no | `true` | Set `false` to report without blocking |
| `timeout_minutes` | no | `20` | Wait time before the step fails |

## Outputs

| Output | Description |
|---|---|
| `job_id` | Scan job id |
| `policy_status` | `PASS`, `FAIL`, or `NOT_EVALUATED` |
| `denied_count` | Number of blocking violations |

## Notes

- **A policy must exist** for the project's namespace, otherwise nothing is
  enforced. The action emits a warning and sets `policy_status: NOT_EVALUATED`
  so this doesn't look like a pass.
- The source scan uploads `git archive HEAD`, so only committed files are
  scanned — uncommitted working-tree changes are not.
- The step fails if the scan times out or ends in a non-terminal state, rather
  than letting an unknown verdict green the build.

## Development

```bash
npm install
npm run build      # bundles index.js -> dist/index.js via ncc
```

`dist/` is committed and is what the runner executes — rebuild and commit it
with any source change.
