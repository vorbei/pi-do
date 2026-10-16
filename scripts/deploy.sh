#!/usr/bin/env bash
# Deploys the pi-do Worker to the Cloudflare account named in the environment, checks its health
# and builds the extension zip pointed at it. Secret values are never printed.
#
# Usage: scripts/deploy.sh [--name <worker>] [--skip-check] [--set-secrets]
#   needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment
#   --name <worker>  Worker script name (default: WORKER_NAME in src/config.ts)
#   --skip-check     skip `npm run check` (typecheck, unit tests, config check, extension build)
#   --set-secrets    upload missing Worker secrets with the deploy: OPENROUTER_API_KEY from the
#                    environment; BOOTSTRAP_SECRET from the environment, else from
#                    .deploy/bootstrap-secret, else generated with openssl and stored there (0600)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
wrangler="$root/node_modules/.bin/wrangler"

usage() { sed -n '5,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; }
fail() { echo "FAIL: $*" >&2; exit 1; }

name=""
skip_check=false
set_secrets=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || fail "--name needs a Worker name"
      [[ "$2" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail "invalid Worker name: $2"
      name="$2"; shift 2 ;;
    --skip-check) skip_check=true; shift ;;
    --set-secrets) set_secrets=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; fail "unknown argument: $1" ;;
  esac
done

missing_env=()
for var in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN; do
  value="${!var:-}"
  [[ -n "${value//[[:space:]]/}" ]] || missing_env+=("$var")
done
[[ ${#missing_env[@]} -eq 0 ]] || fail "set ${missing_env[*]} in the environment (see README, Deploy)"
[[ -x "$wrangler" ]] || fail "wrangler is not installed: run npm ci (in the monorepo, at its root)"

if [[ -z "$name" ]]; then
  name="$(node --input-type=module -e 'import { WORKER_NAME } from "./src/config.ts"; console.log(WORKER_NAME)')"
fi
echo "==> deploying Worker $name"

echo "==> wrangler.jsonc from src/config.ts"
node scripts/wrangler-config.ts >/dev/null
node scripts/wrangler-config.ts --check

if $skip_check; then
  echo "==> npm run check skipped (--skip-check)"
else
  echo "==> npm run check"
  npm run --silent check
fi

echo "==> Worker secrets (names only)"
missing="$(node scripts/check-secrets.ts --name "$name" --missing)"
secrets_file=""
cleanup() { [[ -n "$secrets_file" ]] && rm -f "$secrets_file"; return 0; }
trap cleanup EXIT
if [[ -n "$missing" ]]; then
  if ! $set_secrets; then
    echo "missing on $name: $(echo "$missing" | tr '\n' ' ')" >&2
    echo "Set them with \`npx wrangler secret put <NAME> --name $name\`, or rerun with --set-secrets" >&2
    echo "(OPENROUTER_API_KEY from the environment; BOOTSTRAP_SECRET generated if not set)." >&2
    exit 1
  fi
  mkdir -p .deploy
  chmod 700 .deploy
  secrets_file="$(mktemp .deploy/secrets.XXXXXX)"
  chmod 600 "$secrets_file"
  for secret in $missing; do
    case "$secret" in
      OPENROUTER_API_KEY)
        [[ -n "${OPENROUTER_API_KEY:-}" ]] || fail "OPENROUTER_API_KEY is missing on $name and not set in the environment" ;;
      BOOTSTRAP_SECRET)
        if [[ -z "${BOOTSTRAP_SECRET:-}" ]]; then
          if [[ ! -s .deploy/bootstrap-secret ]]; then
            (umask 077; openssl rand -hex 32 > .deploy/bootstrap-secret)
            echo "generated BOOTSTRAP_SECRET, stored in $root/.deploy/bootstrap-secret (0600, gitignored)"
          else
            echo "using BOOTSTRAP_SECRET from $root/.deploy/bootstrap-secret"
          fi
          chmod 600 .deploy/bootstrap-secret
          BOOTSTRAP_SECRET="$(cat .deploy/bootstrap-secret)"
        fi ;;
      *) fail "no --set-secrets source for $secret" ;;
    esac
  done
  export OPENROUTER_API_KEY BOOTSTRAP_SECRET
  # One JSON object of the missing secrets; values pass through the environment, never argv.
  MISSING="$missing" node -e '
    const names = process.env.MISSING.split("\n").filter(Boolean);
    process.stdout.write(JSON.stringify(Object.fromEntries(names.map(n => [n, process.env[n]]))));
  ' > "$secrets_file"
  echo "uploading with the deploy: $(echo "$missing" | tr '\n' ' ')"
else
  echo "ok: $name has every required secret"
fi

echo "==> wrangler deploy"
deploy_args=(deploy --name "$name")
[[ -n "$secrets_file" ]] && deploy_args+=(--secrets-file "$secrets_file")
log="$(mktemp -t pi-do-deploy.XXXXXX)"
set +e
"$wrangler" "${deploy_args[@]}" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e
cleanup; secrets_file=""
[[ $status -eq 0 ]] || { rm -f "$log"; fail "wrangler deploy exited $status"; }
url="$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$log" | head -1 || true)"
version="$(sed -n 's/.*Current Version ID: *\([0-9a-f-]*\).*/\1/p' "$log" | head -1)"
rm -f "$log"
[[ -n "$url" ]] || fail "no workers.dev URL in the deploy output (does the account have a workers.dev subdomain?)"

echo "==> health check $url/api/health"
health=""
for attempt in 1 2 3 4 5 6; do
  health="$(curl -fsS --max-time 10 "$url/api/health" 2>/dev/null)" && break
  health=""
  sleep 5
done
[[ -n "$health" ]] || fail "$url/api/health did not answer 200"

echo "==> extension pointed at $url"
zip="$(node scripts/build-extension.ts --worker-url "$url" | sed -n 's/^zipped //p')"

echo
echo "Worker:     $name"
echo "URL:        $url"
echo "Version ID: ${version:-unknown}"
echo "Health:     $health"
echo "Extension:  $zip"
if [[ -s .deploy/bootstrap-secret ]]; then
  echo "Bootstrap secret file: $root/.deploy/bootstrap-secret"
fi
