#!/usr/bin/env bash
# Run by release.yml when the publish block fails: passes only when npm has
# this package version, published from the checked-out commit through npm
# trusted publishing (OIDC). Waits up to ATTEMPTS x INTERVAL seconds, since npm
# can take a few minutes to show a new version.
set -euo pipefail

if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "::error::The dry run failed; see the publish step's log."
  exit 1
fi

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
commit=$(git rev-parse HEAD)
oidc_user="GitHub Actions <npm-oidc-no-reply@github.com>"
attempts=${ATTEMPTS:-40}
interval=${INTERVAL:-15}

for attempt in $(seq 1 "$attempts"); do
  # npm exits non-zero (E404) until the version is visible.
  if published=$(npm view "$name@$version" gitHead _npmUser --json --registry https://registry.npmjs.org 2>/dev/null) &&
    [ -n "$published" ]; then
    head=$(node -p 'JSON.parse(process.argv[1]).gitHead ?? ""' "$published")
    user=$(node -p 'JSON.parse(process.argv[1])._npmUser ?? ""' "$published")
    if [ "$head" = "$commit" ] && [ "$user" = "$oidc_user" ]; then
      echo "$name@$version is on npm, published from $commit through trusted publishing."
      exit 0
    fi
    echo "::error::$name@$version is on npm, but from commit ${head:-unknown} by ${user:-unknown}, not from $commit through trusted publishing."
    exit 1
  fi
  echo "Attempt $attempt/$attempts: $name@$version is not on npm yet."
  [ "$attempt" -lt "$attempts" ] && sleep "$interval"
done

echo "::error::$name@$version is not on npm. See the publish step's log for why."
exit 1
