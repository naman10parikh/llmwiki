#!/usr/bin/env bash
set -euo pipefail

PURPLE='\033[0;35m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

echo ""
echo -e "${PURPLE}╦ ╦╦╦╔═╦╔╦╗╔═╗╔╦╗${RESET}"
echo -e "${PURPLE}║║║║╠╩╗║║║║║╠═╝║║║${RESET}"
echo -e "${PURPLE}╚╩╝╩╩ ╩╩╩ ╩╩╚═╝╩ ╩${RESET}"
echo -e "${DIM}Self-improving knowledge bases${RESET}"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js is required but not installed.${RESET}"
    echo -e "Install from: ${PURPLE}https://nodejs.org${RESET} (v18+)"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Node.js v18+ required. You have $(node -v).${RESET}"
    exit 1
fi

echo -e "${GREEN}✓${RESET} Node.js $(node -v) detected"

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}npm is required but not installed.${RESET}"
    exit 1
fi

echo -e "${GREEN}✓${RESET} npm $(npm -v) detected"

# Install
echo ""
echo -e "Installing ${PURPLE}wikimem${RESET}..."
npm install -g wikimem@latest

echo ""
echo -e "${GREEN}✓ wikimem installed successfully!${RESET}"
echo ""
echo -e "Get started:"
echo -e "  ${PURPLE}wikimem init my-wiki${RESET}        Create a knowledge base"
echo -e "  ${PURPLE}wikimem ingest article.pdf${RESET}  Add your first document"
echo -e "  ${PURPLE}wikimem serve${RESET}               Open the web UI"
echo ""
echo -e "${DIM}Docs: https://github.com/naman10parikh/wikimem${RESET}"
