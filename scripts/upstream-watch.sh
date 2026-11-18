#!/usr/bin/env bash
# Opens an issue when codehygiene's main branch moves past the commit this package expects.
#
# Run by .github/workflows/upstream-watch.yml. Needs bash, jq and (outside tests) the gh CLI.
# Everything that comes from upstream is untrusted: each value is checked against a strict
# pattern before use, nothing is expanded by the shell, and the issue text is built only from
# validated values. Commit messages and file names are never copied (a file name only decides
# one yes/no answer).
#
# Environment:
#   GITHUB_REPOSITORY  owner/name of this repository (set by Actions)
#   GH_TOKEN           token for gh (set by the workflow)
#   PIN_FILE           the pin file, default compat/codehygiene.json
#   DRY_RUN            1 prints what would be done and changes nothing
#   FIXTURE_DIR        tests only: read commit.json, compare.json, repo.json and issues.json
#                      from this folder instead of calling the API

set -euo pipefail

UPSTREAM="brianbell-x/codehygiene"
WEIGHTS_FILE="codehygiene/weights.npz"
COMPARE_FILE_LIMIT=300 # the compare API lists at most this many files
LABEL="upstream-update"
PIN_FILE="${PIN_FILE:-compat/codehygiene.json}"
DRY_RUN="${DRY_RUN:-0}"

fail() {
  echo "upstream-watch: $*" >&2
  exit 1
}

# Reads one API document: from the fixture folder in tests, otherwise from GitHub.
fetch() {
  local name="$1" path="$2"
  if [ -n "${FIXTURE_DIR:-}" ]; then
    cat "$FIXTURE_DIR/$name.json"
  else
    gh api "$path"
  fi
}

# Runs a command that changes GitHub, or only says what it would do. In a dry run each argument
# is quoted, so a multi-line issue body stays readable and nothing is lost.
act() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY_RUN would run: %s\n' "$(printf '%q ' "$@")"
  else
    "$@"
  fi
}

need() { # need <value> <pattern> <what>
  [[ "$1" =~ $2 ]] || fail "unexpected $3"
}

# --- The pin this repository expects ---------------------------------------------------------
[ -f "$PIN_FILE" ] || fail "missing $PIN_FILE"
pin=$(jq -r '.commit // empty' "$PIN_FILE")
need "$pin" '^[0-9a-f]{40}$' "pin commit"
pin_version=$(jq -r '.version // empty' "$PIN_FILE")
need "$pin_version" '^[0-9]+\.[0-9]+\.[0-9]+$' "pin version"

# --- Upstream now ----------------------------------------------------------------------------
repo=$(fetch repo "repos/$UPSTREAM") || fail "cannot read $UPSTREAM"
head=$(fetch commit "repos/$UPSTREAM/commits/main") || fail "cannot read the main branch"
sha=$(jq -r '.sha // empty' <<<"$head")
date=$(jq -r '.commit.committer.date // empty' <<<"$head")
need "$sha" '^[0-9a-f]{40}$' "upstream commit"
need "$date" '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$' "commit date"

if [ "$sha" = "$pin" ]; then
  echo "upstream-watch: up to date at ${pin:0:7}"
  exit 0
fi

archived=$(jq -r 'if .archived == true then "yes" else "no" end' <<<"$repo")
renamed=$(jq -r --arg name "$UPSTREAM" 'if (.full_name // "" | ascii_downcase) == ($name | ascii_downcase) then "no" else "yes" end' <<<"$repo")
license=$(jq -r '.license.spdx_id // "none"' <<<"$repo")
need "$license" '^[A-Za-z0-9.+-]+$' "license id"

# How far upstream is from the pin, and whether the model file changed.
if compare=$(fetch compare "repos/$UPSTREAM/compare/$pin...$sha" 2>/dev/null); then
  status=$(jq -r '.status // "unreachable"' <<<"$compare")
  ahead=$(jq -r '.ahead_by // 0' <<<"$compare")
  files=$(jq -r '(.files // []) | length' <<<"$compare")
  weights=$(jq -r --arg f "$WEIGHTS_FILE" 'if ((.files // []) | any(.filename == $f)) then "yes" else "no" end' <<<"$compare")
  if [ "$weights" = "no" ] && [ "$files" -ge "$COMPARE_FILE_LIMIT" ]; then weights="unknown"; fi
else
  status="unreachable"
  ahead="unknown" # the pin is not in upstream's history any more; a count would be a guess
  weights="unknown"
fi
need "$status" '^(ahead|behind|diverged|identical|unreachable)$' "compare status"
need "$ahead" '^([0-9]{1,6}|unknown)$' "commit count"

short=${sha:0:7}
pin_short=${pin:0:7}

# --- Has this commit been reported before? ---------------------------------------------------
# Any state counts: closing an issue without moving the pin means "seen, declined". Every commit
# the issue named stays listed in its body, so a revert to a commit already reported stays quiet.
marker="upstream-sha: $sha"
if [ -n "${FIXTURE_DIR:-}" ]; then
  issues=$(cat "$FIXTURE_DIR/issues.json") || fail "cannot read the issue fixtures"
else
  issues=$(gh issue list --label "$LABEL" --state all --limit 100 --json number,state,body) || fail "cannot list issues"
fi
jq -e 'type == "array"' <<<"$issues" >/dev/null 2>&1 || fail "the issue list is not a list"
if jq -e --arg marker "$marker" 'any(.[]; (.body // "") | contains($marker))' <<<"$issues" >/dev/null; then
  echo "upstream-watch: ${short} already reported"
  exit 0
fi
older=$(jq -r '[.[] | select(.state == "OPEN")] | first | .number // empty' <<<"$issues") || fail "cannot read the issue list"
if [ -n "$older" ]; then need "$older" '^[0-9]+$' "issue number"; fi

# Commits an open issue already named, kept so that editing it does not lose them. At most a
# handful, so the body cannot grow without bound.
reported=""
if [ -n "$older" ]; then
  reported=$(jq -r --argjson n "$older" '.[] | select(.number == $n) | .body // ""' <<<"$issues" |
    grep -E '^upstream-sha: [0-9a-f]{40}$' || true)
  reported=$(sort -u <<<"$reported" | head -n 20 | grep -E '^upstream-sha: [0-9a-f]{40}$' || true)
fi

# --- Issue text, from validated values only --------------------------------------------------
title="codehygiene upstream changed: $short"
body=$(
  cat <<EOF
$marker
$reported

Upstream main moved from \`$pin\` (v$pin_version, the pin) to \`$sha\` (committed $date).

| | |
|-|-|
| Commits ahead of the pin | $ahead |
| Relation to the pin | $status |
| \`weights.npz\` changed | $weights |
| Upstream archived | $archived |
| Upstream renamed or moved | $renamed |
| Upstream license (as GitHub detects it) | $license |

Compare: https://github.com/$UPSTREAM/compare/$pin...$sha

- [ ] Read the diff at the compare link, including the files the manifest hashes.
- [ ] Check upstream tags, releases and LICENSE by hand.
- [ ] Reinstall at the new commit, regenerate the manifest and run the tests.
- [ ] Update \`compat/codehygiene.json\`, the README and the install steps, or close this issue to decline this commit (it will not be reported again).

If this workflow stops reporting, GitHub may have disabled the schedule after 60 days without activity: run it by hand.
EOF
)

act gh label create "$LABEL" --force --description "codehygiene upstream changed" --color "ededed"

if [ -n "$older" ]; then
  # One open issue at a time: move it to the new commit and say so.
  act gh issue edit "$older" --title "$title" --body "$body"
  act gh issue comment "$older" --body "Upstream moved again to \`$short\`. This issue now tracks that commit."
  [ "$DRY_RUN" = "1" ] || echo "upstream-watch: updated issue #$older for $short"
else
  act gh issue create --title "$title" --label "$LABEL" --body "$body"
  [ "$DRY_RUN" = "1" ] || echo "upstream-watch: opened an issue for $short (pin $pin_short)"
fi
