#!/usr/bin/env bash
set -euo pipefail

REMOTE="${REMOTE:-evp}"
BRANCH="${BRANCH:-main}"
WORKFLOW="${WORKFLOW:-push-and-build.yml}"
DEFAULT_TAG="${DEFAULT_TAG:-v1.0.0.prod}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/push-and-build.sh "commit message" [tag]

Env overrides:
  REMOTE=evp          (default: evp)
  BRANCH=main         (default: main)
  WORKFLOW=push-and-build.yml (default: push-and-build.yml)
  DEFAULT_TAG=v1.0.0.prod (default: v1.0.0.prod)

Behavior:
  - git add -A
  - git commit -m <message> (only if there are changes)
  - git push <REMOTE> HEAD:<BRANCH>
  - if 'gh' is installed and authenticated: trigger workflow_dispatch with tag
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "" ]]; then
  usage
  exit 0
fi

MSG="$1"
TAG="${2:-$DEFAULT_TAG}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: Not a git repository."
  exit 1
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "ERROR: Remote '$REMOTE' not found."
  git remote -v || true
  exit 1
fi

git add -A

if git diff --cached --quiet; then
  echo "No changes to commit."
else
  git commit -m "$MSG"
fi

git push "$REMOTE" "HEAD:$BRANCH"

if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    echo "Triggering workflow '$WORKFLOW' with tag '$TAG'..."
    gh workflow run "$WORKFLOW" -f "tag=$TAG" >/dev/null
    echo "Done."
  else
    echo "Skipping workflow trigger: 'gh' not authenticated (run: gh auth login)."
  fi
else
  echo "Skipping workflow trigger: 'gh' not installed."
fi

