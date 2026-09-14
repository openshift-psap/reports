#!/bin/bash
set -euo pipefail

FUNCTION_NAME="psap-reports-token-admin"
ROLE_NAME="psap-reports-token-admin-role"
API_NAME="psap-reports-token-admin"
REGION="us-east-1"
DIST_ID="E3URYTY8ICV8ON"
ROUTE_PREFIX="/_admin-api"
ORIGIN_ID="psap-reports-token-admin-api"

: "${COOKIE_SECRET:?Set COOKIE_SECRET to the persistent auth cookie secret}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_DIR="$SCRIPT_DIR/lambda-token-admin"
S3_BUCKET=$(python3 -c "import json; print(json.load(open('_generator/s3_config.json'))['bucket'])")
S3_REGION=$(python3 -c "import json; print(json.load(open('_generator/s3_config.json'))['region'])")
CF_DOMAIN=$(python3 -c "import json; print(json.load(open('_generator/s3_config.json'))['cloudfront_domain'])")
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "=== Package token-admin Lambda ==="
cp "$LAMBDA_DIR/index.js" "$LAMBDA_DIR/package.json" "$LAMBDA_DIR/package-lock.json" "$WORK_DIR/"
(cd "$WORK_DIR" && npm ci --omit=dev --ignore-scripts && zip -qr function.zip index.js node_modules)

echo "=== Create or update IAM role ==="
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name psap-reports-token-admin-data --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\"],\"Resource\":\"arn:aws:s3:::$S3_BUCKET/tokens.json\"}]}"

echo "=== Create or update Lambda ==="
ENVIRONMENT="Variables={S3_BUCKET=$S3_BUCKET,S3_REGION=$S3_REGION,COOKIE_SECRET=$COOKIE_SECRET}"
if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNCTION_NAME" --zip-file "fileb://$WORK_DIR/function.zip" --region "$REGION" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FUNCTION_NAME" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FUNCTION_NAME" --environment "$ENVIRONMENT" --region "$REGION" >/dev/null
else
  aws lambda create-function --function-name "$FUNCTION_NAME" --runtime nodejs20.x --role "$ROLE_ARN" --handler index.handler --zip-file "fileb://$WORK_DIR/function.zip" --timeout 10 --memory-size 128 --environment "$ENVIRONMENT" --region "$REGION" >/dev/null
fi
aws lambda wait function-active-v2 --function-name "$FUNCTION_NAME" --region "$REGION"
FUNCTION_ARN=$(aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" --query 'Configuration.FunctionArn' --output text)

echo "=== Create or update API Gateway ==="
API_ID=$(aws apigateway get-rest-apis --query "items[?name=='$API_NAME'].id | [0]" --output text)
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  API_ID=$(aws apigateway create-rest-api --name "$API_NAME" --endpoint-configuration types=REGIONAL --query id --output text)
fi
ROOT_ID=$(aws apigateway get-resources --rest-api-id "$API_ID" --query "items[?path=='/'].id | [0]" --output text)
PREFIX_ID=$(aws apigateway get-resources --rest-api-id "$API_ID" --query "items[?path=='$ROUTE_PREFIX'].id | [0]" --output text)
if [ -z "$PREFIX_ID" ] || [ "$PREFIX_ID" = "None" ]; then
  PREFIX_ID=$(aws apigateway create-resource --rest-api-id "$API_ID" --parent-id "$ROOT_ID" --path-part "${ROUTE_PREFIX#/}" --query id --output text)
fi
TOKENS_ID=$(aws apigateway get-resources --rest-api-id "$API_ID" --query "items[?path=='$ROUTE_PREFIX/tokens'].id | [0]" --output text)
if [ -z "$TOKENS_ID" ] || [ "$TOKENS_ID" = "None" ]; then
  TOKENS_ID=$(aws apigateway create-resource --rest-api-id "$API_ID" --parent-id "$PREFIX_ID" --path-part tokens --query id --output text)
fi
INTEGRATION_URI="arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${FUNCTION_ARN}/invocations"
for method in GET POST DELETE; do
  if ! aws apigateway get-method --rest-api-id "$API_ID" --resource-id "$TOKENS_ID" --http-method "$method" >/dev/null 2>&1; then
    aws apigateway put-method --rest-api-id "$API_ID" --resource-id "$TOKENS_ID" --http-method "$method" --authorization-type NONE --no-api-key-required >/dev/null
  fi
  aws apigateway put-integration --rest-api-id "$API_ID" --resource-id "$TOKENS_ID" --http-method "$method" --type AWS_PROXY --integration-http-method POST --uri "$INTEGRATION_URI" >/dev/null
done
if ! aws lambda get-policy --function-name "$FUNCTION_NAME" --region "$REGION" --query Policy --output text 2>/dev/null | grep -q 'AllowApiGatewayInvoke'; then
  aws lambda add-permission --function-name "$FUNCTION_NAME" --statement-id AllowApiGatewayInvoke --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*/*" --region "$REGION" >/dev/null
fi
aws apigateway create-deployment --rest-api-id "$API_ID" --stage-name prod --description "Token admin deployment $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null

echo "=== Route the API through CloudFront ==="
ETAG=$(aws cloudfront get-distribution-config --id "$DIST_ID" --query ETag --output text)
aws cloudfront get-distribution-config --id "$DIST_ID" --query DistributionConfig > "$WORK_DIR/cf-config.json"
API_DOMAIN="${API_ID}.execute-api.${REGION}.amazonaws.com"
python3 - "$WORK_DIR/cf-config.json" "$ORIGIN_ID" "$API_DOMAIN" "$ROUTE_PREFIX" <<'PY'
import copy
import json
import sys

path, origin_id, api_domain, route = sys.argv[1:]
with open(path) as f:
    config = json.load(f)

origins = config['Origins']['Items']
origin = {
    'Id': origin_id,
    'DomainName': api_domain,
    'OriginPath': '/prod',
    'CustomHeaders': {'Quantity': 0},
    'CustomOriginConfig': {
        'HTTPPort': 80,
        'HTTPSPort': 443,
        'OriginProtocolPolicy': 'https-only',
        'OriginSslProtocols': {'Quantity': 1, 'Items': ['TLSv1.2']},
        'OriginReadTimeout': 30,
        'OriginKeepaliveTimeout': 5,
    },
    'ConnectionAttempts': 3,
    'ConnectionTimeout': 10,
    'OriginShield': {'Enabled': False},
}
for i, current in enumerate(origins):
    if current['Id'] == origin_id:
        origins[i] = origin
        break
else:
    origins.append(origin)
config['Origins']['Quantity'] = len(origins)

behavior = copy.deepcopy(config['DefaultCacheBehavior'])
behavior['PathPattern'] = route + '/*'
behavior['TargetOriginId'] = origin_id
behavior['ViewerProtocolPolicy'] = 'https-only'
behavior['AllowedMethods'] = {
    'Quantity': 7,
    'Items': ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
    'CachedMethods': {'Quantity': 2, 'Items': ['GET', 'HEAD']},
}
behavior['ForwardedValues'] = {
    'QueryString': False,
    'Cookies': {'Forward': 'whitelist', 'WhitelistedNames': {'Quantity': 1, 'Items': ['psap_auth']}},
    'Headers': {'Quantity': 2, 'Items': ['Content-Type', 'Origin']},
    'QueryStringCacheKeys': {'Quantity': 0},
}
behavior['MinTTL'] = 0
behavior['DefaultTTL'] = 0
behavior['MaxTTL'] = 0
behaviors = config.setdefault('CacheBehaviors', {'Quantity': 0, 'Items': []})
behavior_items = behaviors.setdefault('Items', [])
for i, current in enumerate(behavior_items):
    if current['PathPattern'] == behavior['PathPattern']:
        behavior_items[i] = behavior
        break
else:
    behavior_items.append(behavior)
behaviors['Quantity'] = len(behavior_items)

with open(path, 'w') as f:
    json.dump(config, f)
PY
aws cloudfront update-distribution --id "$DIST_ID" --if-match "$ETAG" --distribution-config "file://$WORK_DIR/cf-config.json" --query 'Distribution.Status' --output text

echo ""
echo "Token admin API deployed."
echo "Admin page: https://${CF_DOMAIN}/admin/index.html"
