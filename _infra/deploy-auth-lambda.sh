#!/bin/bash
set -euo pipefail

FUNCTION_NAME="psap-reports-auth"
ROLE_NAME="psap-reports-lambda-edge-role"
REGION="us-east-1"
DIST_ID="E3URYTY8ICV8ON"

# Check required env vars
: "${GITHUB_CLIENT_ID:?Set GITHUB_CLIENT_ID}"
: "${GITHUB_CLIENT_SECRET:?Set GITHUB_CLIENT_SECRET}"

COOKIE_SECRET="${COOKIE_SECRET:-$(openssl rand -base64 32)}"
echo "Cookie secret: $COOKIE_SECRET"
echo "(Save this — needed if you redeploy)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_DIR="$SCRIPT_DIR/lambda-auth"
WORK_DIR=$(mktemp -d)
trap "rm -rf $WORK_DIR" EXIT

echo ""
echo "=== Step 1: Package Lambda ==="
cp "$LAMBDA_DIR/index.js" "$WORK_DIR/index.js"
sed -i "s|__GITHUB_CLIENT_ID__|$GITHUB_CLIENT_ID|g" "$WORK_DIR/index.js"
sed -i "s|__GITHUB_CLIENT_SECRET__|$GITHUB_CLIENT_SECRET|g" "$WORK_DIR/index.js"
sed -i "s|__COOKIE_SECRET__|$COOKIE_SECRET|g" "$WORK_DIR/index.js"
(cd "$WORK_DIR" && zip -q function.zip index.js)
echo "Packaged to $WORK_DIR/function.zip"

echo ""
echo "=== Step 2: Create/Update IAM Role ==="
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

if aws iam get-role --role-name "$ROLE_NAME" &>/dev/null; then
    echo "Role $ROLE_NAME exists"
else
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {
                    "Service": ["lambda.amazonaws.com", "edgelambda.amazonaws.com"]
                },
                "Action": "sts:AssumeRole"
            }]
        }' \
        --query 'Role.Arn' --output text
    aws iam attach-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
    echo "Created role $ROLE_NAME"
    echo "Waiting 10s for IAM propagation..."
    sleep 10
fi

echo ""
echo "=== Step 3: Create/Update Lambda Function ==="
if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" &>/dev/null; then
    aws lambda update-function-code \
        --function-name "$FUNCTION_NAME" \
        --zip-file "fileb://$WORK_DIR/function.zip" \
        --region "$REGION" \
        --query 'FunctionArn' --output text
    echo "Updated function $FUNCTION_NAME"
    sleep 3
else
    aws lambda create-function \
        --function-name "$FUNCTION_NAME" \
        --runtime "nodejs20.x" \
        --role "$ROLE_ARN" \
        --handler "index.handler" \
        --zip-file "fileb://$WORK_DIR/function.zip" \
        --region "$REGION" \
        --timeout 5 \
        --memory-size 128 \
        --query 'FunctionArn' --output text
    echo "Created function $FUNCTION_NAME"
    sleep 3
fi

echo ""
echo "=== Step 4: Publish Version ==="
VERSION_ARN=$(aws lambda publish-version \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --query 'FunctionArn' --output text)
echo "Published version: $VERSION_ARN"

echo ""
echo "=== Step 5: Associate with CloudFront ==="
ETAG=$(aws cloudfront get-distribution-config --id "$DIST_ID" --query 'ETag' --output text)
aws cloudfront get-distribution-config --id "$DIST_ID" --query 'DistributionConfig' > /tmp/cf-dist-config.json

# Add Lambda association to the default cache behavior
python3 -c "
import json
with open('/tmp/cf-dist-config.json') as f:
    config = json.load(f)
dcb = config['DefaultCacheBehavior']
dcb['LambdaFunctionAssociations'] = {
    'Quantity': 1,
    'Items': [{
        'LambdaFunctionARN': '$VERSION_ARN',
        'EventType': 'viewer-request',
        'IncludeBody': False
    }]
}
with open('/tmp/cf-dist-config.json', 'w') as f:
    json.dump(config, f, indent=2)
"

aws cloudfront update-distribution \
    --id "$DIST_ID" \
    --if-match "$ETAG" \
    --distribution-config file:///tmp/cf-dist-config.json \
    --query 'Distribution.Status' --output text

rm /tmp/cf-dist-config.json
echo "Lambda@Edge associated with CloudFront distribution $DIST_ID"

echo ""
echo "========================================"
echo "  Auth Lambda Deployed"
echo "========================================"
echo ""
echo "  Function:     $FUNCTION_NAME"
echo "  Version ARN:  $VERSION_ARN"
echo "  Distribution: $DIST_ID"
echo "  Org gate:     openshift-psap"
echo ""
echo "  CloudFront will take 5-10 min to redeploy."
echo "  Test: https://d3a5l0t7t5dflc.cloudfront.net/test/index.html"
echo "  (should redirect to GitHub login)"
echo ""
