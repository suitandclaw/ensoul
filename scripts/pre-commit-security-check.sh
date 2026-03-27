#!/usr/bin/env bash
#
# Pre-commit hook: scan staged files for key material patterns.
# Install: cp scripts/pre-commit-security-check.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#

RED='\033[0;31m'
NC='\033[0m'

# Get list of staged files (added or modified)
STAGED=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null)
if [ -z "$STAGED" ]; then
    exit 0
fi

FOUND=0

for file in $STAGED; do
    # Skip binary files and node_modules
    case "$file" in
        *.png|*.ico|*.jpg|*.jpeg|*.gif|*.woff|*.woff2|*.ttf|*.eot) continue ;;
        node_modules/*|.git/*|dist/*|*.lock) continue ;;
    esac

    # Skip files that are allowed to contain certain patterns
    case "$file" in
        scripts/pre-commit-security-check.sh) continue ;;
        docs/SECURITY-AUDIT.md) continue ;;
    esac

    # Check for private key patterns
    if git show ":$file" 2>/dev/null | grep -qiE '"seed"\s*:\s*"[0-9a-f]{64}"'; then
        echo -e "${RED}BLOCKED:${NC} $file contains a seed hex string"
        FOUND=1
    fi

    if git show ":$file" 2>/dev/null | grep -qiE 'PRIVATE KEY'; then
        echo -e "${RED}BLOCKED:${NC} $file contains a private key marker"
        FOUND=1
    fi

    if git show ":$file" 2>/dev/null | grep -qiE '"(private_key|secret_key|privateKey|secretKey)"\s*:'; then
        echo -e "${RED}BLOCKED:${NC} $file contains a private/secret key field"
        FOUND=1
    fi

    # Check for Telegram bot tokens (numeric:alphanumeric pattern)
    if git show ":$file" 2>/dev/null | grep -qE '[0-9]{8,}:AA[A-Za-z0-9_-]{30,}'; then
        echo -e "${RED}BLOCKED:${NC} $file appears to contain a Telegram bot token"
        FOUND=1
    fi

    # Check for .env content being committed
    case "$file" in
        *.env|*.env.*)
            echo -e "${RED}BLOCKED:${NC} $file is an environment file (should be in .gitignore)"
            FOUND=1
            ;;
    esac
done

if [ "$FOUND" -ne 0 ]; then
    echo ""
    echo "Commit blocked: potential secret material detected in staged files."
    echo "If this is intentional, use git commit with the appropriate flag to bypass."
    exit 1
fi

exit 0
