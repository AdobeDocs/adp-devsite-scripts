#!/bin/bash

# Script to check last successful workflow run for multiple repositories
# Usage: ./check-workflow-status.sh

# Get GitHub token from environment variable
# Set it before running: export GITHUB_TOKEN='your_token_here'
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

if [ -z "$GITHUB_TOKEN" ]; then
  echo "Warning: GITHUB_TOKEN not set. API rate limits will be lower."
  echo "Set it with: export GITHUB_TOKEN='your_token_here'"
  echo ""
fi

# Configuration
OWNER="AdobeDocs"
WORKFLOW_FILE="deploy.yml"  # Change this to your workflow filename
BRANCH="main"               # Change this to your branch name

# List of repositories to check
REPOS=(
  "adobe-dev-console"
  "adobe-connect-sdk"
  "app-builder"
  "adobe-io-events"
  "developer-distribute"
  "Developer-Distribution-Experience-Cloud"
  "cloud-storage"
  "adobe-connect-extensibility"
  "data-collection-apis"
  "commerce-cloud-tools"
  "commerce-xd-kits"
  "commerce-contributor"
  "workfront-api-explorer"
  "acrobat-sign-developer-guide"
  "commerce-admin-developer"
  "commerce-marketplace"
  "experience-platform-apis"
  "commerce-extensibility"
  "commerce-frontend-core"
  "commerce-php"
  "commerce-pwa-studio"
  "commerce-services"
  "commerce-testing"
  "commerce-webapi"
  "graphql-mesh-gateway"
  "aep-mobile-sdkdocs"
  "adobe-assurance-public-apis"
  "cc-everywhere"
  "express-add-ons-docs"
  "express-add-on-samples"
  "express-add-on-apis"
  "express-for-developers"
  "analytics-2.0-apis"
  "cc-libraries-api"
  "aem-developer-materials"
  "cja-apis"
  "cloudmanager-api-docs"
  "adobe-status"
  "cis-photoshop-api-docs"
  "cpp-at-adobe"
  "experience-manager-apis"
  "experience-manager-forms-cloud-service-developer-reference"
  "ff-services-docs"
  "firefly-api-docs"
  "firefly-services-sdk-js"
  "g11n-gcs"
  "indesign-18-dom"
  "journey-optimizer-apis"
  "lightroom-public-apis"
  "marketo-apis"
  "painter-python-api"
  "painter-shader-api"
  "pdfservices-api-documentation"
  "ppro-uxp"
  "primetime"
  "sampler-python-api"
  "stock-api-docs"
  "substance-3d-automation"
  "substance-3d-scene-automation"
  "substance-automation-toolkit"
  "uix"
  "uxp-indesign"
  "uxp-indesign-18-uxp"
  "uxp-photoshop"
  "uxp-photoshop-2021"
  "uxp-xd"
  "VIPMP"
  "xmp-docs"
  "frameio-api"
  "designer-python-api"
  "photoshop-cpp-sdk-docs"
  "indesign-api-docs"
  "dev-site"
)

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Checking Last Successful Workflow Runs"
echo "Owner: $OWNER"
echo "Workflow: $WORKFLOW_FILE"
echo "Branch: $BRANCH"
echo "=========================================="
echo ""

# Function to make API request
check_workflow_status() {
  local repo=$1
  
  echo -e "${BLUE}Repository: ${NC}${OWNER}/${repo}"
  
  # Construct API URL
  local api_url="https://api.github.com/repos/${OWNER}/${repo}/actions/runs?status=success&per_page=1"
  
  # Make API request
  if [ -n "$GITHUB_TOKEN" ]; then
    response=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
                     -H "Accept: application/vnd.github.v3+json" \
                     "$api_url")
  else
    response=$(curl -s -H "Accept: application/vnd.github.v3+json" "$api_url")
  fi
  
  # Check if request was successful by looking for workflow_runs
  if ! echo "$response" | grep -q '"workflow_runs"'; then
    # If no workflow_runs, check for an error message
    if echo "$response" | grep -q '"message"'; then
      error_message=$(echo "$response" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
      echo -e "  ${RED}Error: ${error_message}${NC}"
    else
      echo -e "  ${RED}Error: Unexpected API response${NC}"
    fi
    echo ""
    return
  fi
  
  # Parse response - check total_count
  total_count=$(echo "$response" | grep -o '"total_count":\s*[0-9]*' | grep -o '[0-9]*$')
  
  if [ -z "$total_count" ] || [ "$total_count" -eq 0 ]; then
    echo -e "  ${YELLOW}No successful workflow runs found${NC}"
    echo ""
    return
  fi
  
  # Extract last successful run details from the workflow_runs array
  # Skip the first "id" which is at the top level, get the one inside workflow_runs
  run_id=$(echo "$response" | grep -o '"id":\s*[0-9]*' | sed -n '2p' | grep -o '[0-9]*$')
  commit_sha=$(echo "$response" | grep -o '"head_sha":\s*"[^"]*"' | head -1 | cut -d'"' -f4)
  created_at=$(echo "$response" | grep -o '"created_at":\s*"[^"]*"' | head -1 | cut -d'"' -f4)
  html_url=$(echo "$response" | grep -o '"html_url":\s*"https://github.com[^"]*"' | head -1 | cut -d'"' -f4)
  conclusion=$(echo "$response" | grep -o '"conclusion":\s*"[^"]*"' | head -1 | cut -d'"' -f4)
  
  # Display results
  echo -e "  ${GREEN}✓ Last Successful Run Found${NC}"
  echo "  Run ID:     $run_id"
  echo "  Commit SHA: $commit_sha"
  echo "  Created:    $created_at"
  echo "  Conclusion: $conclusion"
  echo "  URL:        $html_url"
  echo ""
}

# Loop through all repositories
for repo in "${REPOS[@]}"; do
  check_workflow_status "$repo"
done

echo "=========================================="
echo "Check Complete"
echo "=========================================="

