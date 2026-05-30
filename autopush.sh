#!/bin/bash
# Auto-push to GitHub using GITHUB_TOKEN secret
set -e

if [ -z "$GITHUB_TOKEN" ]; then
  echo "❌ GITHUB_TOKEN is not set. Add it in Replit Secrets."
  exit 1
fi

REPO="https://gauravksharma099-boop:${GITHUB_TOKEN}@github.com/gauravksharma099-boop/Outpost-sucks1.git"

git push "$REPO" main
echo "✅ Pushed to GitHub successfully!"
