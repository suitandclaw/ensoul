#!/bin/bash
# release.sh: Cut an Ensoul release with explicit version bump + tag.
#
# Bumps version.ts, commits, creates an annotated tag, pushes both.
# This replaces the old pre-push hook that auto-bumped via commit --amend.
#
# Usage:
#   ./scripts/release.sh 1.4.134
#   ./scripts/release.sh 1.5.0
#
# The script will:
#   1. Validate the version format (semver)
#   2. Verify the repo is clean (no uncommitted changes)
#   3. Bump version.ts and package.json
#   4. Commit with a standard message
#   5. Create an annotated git tag
#   6. Push commit and tag to origin
#   7. Verify the tag is fetchable from origin
#
# After running, the tag is ready for SOFTWARE_UPGRADE broadcast.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION_FILE="packages/node/src/version.ts"
PKG_FILE="packages/node/package.json"

cd "$REPO_DIR"

# ── Validate arguments ───────────────────────────────────────────

if [ $# -ne 1 ]; then
    echo "Usage: $0 <version>"
    echo "Example: $0 1.4.134"
    exit 1
fi

NEW_VERSION="$1"

# Validate semver format (major.minor.patch)
if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "ERROR: version must be semver format (e.g., 1.4.134)"
    exit 1
fi

TAG="v${NEW_VERSION}"

# ── Check preconditions ──────────────────────────────────────────

# Verify clean working tree
if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: working tree is not clean. Commit or stash changes first."
    git status --short
    exit 1
fi

# Verify tag doesn't already exist
if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "ERROR: tag $TAG already exists."
    echo "  Points to: $(git rev-parse --short "$TAG"^{commit})"
    exit 1
fi

# Read current version
CURRENT=$(grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' "$VERSION_FILE" 2>/dev/null | tr -d '"')
if [ -z "$CURRENT" ]; then
    echo "ERROR: could not read current version from $VERSION_FILE"
    exit 1
fi

echo "Release: $CURRENT -> $NEW_VERSION ($TAG)"
echo ""

# ── Bump version ─────────────────────────────────────────────────

sed -i '' "s/\"$CURRENT\"/\"$NEW_VERSION\"/" "$VERSION_FILE"
echo "  Bumped $VERSION_FILE"

if [ -f "$PKG_FILE" ]; then
    sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$PKG_FILE"
    echo "  Bumped $PKG_FILE"
fi

# ── Commit ───────────────────────────────────────────────────────

git add "$VERSION_FILE"
[ -f "$PKG_FILE" ] && git add "$PKG_FILE"

git commit -m "release: v${NEW_VERSION}"
echo "  Committed"

# ── Tag ──────────────────────────────────────────────────────────

git tag -a "$TAG" -m "release v${NEW_VERSION}"
echo "  Tagged $TAG"

# ── Push ─────────────────────────────────────────────────────────

git push origin main
echo "  Pushed main"

git push origin "$TAG"
echo "  Pushed $TAG"

# ── Verify ───────────────────────────────────────────────────────

echo ""
REMOTE_TAG=$(git ls-remote origin "refs/tags/$TAG" | awk '{print $1}')
if [ -z "$REMOTE_TAG" ]; then
    echo "WARNING: tag $TAG not found on origin. Push may have failed."
    exit 1
fi

TAG_VERSION=$(git show "$TAG:$VERSION_FILE" | grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' | tr -d '"')
if [ "$TAG_VERSION" != "$NEW_VERSION" ]; then
    echo "WARNING: version.ts at $TAG says $TAG_VERSION, expected $NEW_VERSION"
    exit 1
fi

echo "=========================================="
echo "  Release $TAG complete"
echo "=========================================="
echo "  Commit: $(git rev-parse --short HEAD)"
echo "  Tag:    $TAG -> $(git rev-parse --short "$TAG"^{commit})"
echo "  Version: $TAG_VERSION"
echo ""
echo "  Ready for SOFTWARE_UPGRADE broadcast."
echo "  DO NOT broadcast until tested on canary."
echo ""
