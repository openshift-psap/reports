#!/bin/bash
set -euo pipefail

BUCKET="psap-reports"
REGION="us-east-1"
COMMENT="PSAP Reports CDN"

echo "=== Step 1: Create S3 Bucket ==="
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    echo "Bucket $BUCKET already exists, skipping creation"
else
    aws s3 mb "s3://$BUCKET" --region "$REGION"
    echo "Created bucket $BUCKET"
fi

aws s3api put-public-access-block \
    --bucket "$BUCKET" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
echo "Public access blocked on $BUCKET"

echo ""
echo "=== Step 2: Create CloudFront Origin Access Control ==="
OAC_ID=$(aws cloudfront list-origin-access-controls \
    --query "OriginAccessControlList.Items[?Name=='psap-reports-oac'].Id" \
    --output text 2>/dev/null || true)

if [ -n "$OAC_ID" ] && [ "$OAC_ID" != "None" ]; then
    echo "OAC already exists: $OAC_ID"
else
    OAC_RESULT=$(aws cloudfront create-origin-access-control \
        --origin-access-control-config \
        "Name=psap-reports-oac,Description=OAC for PSAP reports S3 bucket,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3")
    OAC_ID=$(echo "$OAC_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['OriginAccessControl']['Id'])")
    echo "Created OAC: $OAC_ID"
fi

echo ""
echo "=== Step 3: Create CloudFront Distribution ==="
EXISTING_DIST=$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Comment=='$COMMENT'].Id" \
    --output text 2>/dev/null || true)

if [ -n "$EXISTING_DIST" ] && [ "$EXISTING_DIST" != "None" ]; then
    DIST_ID="$EXISTING_DIST"
    CF_DOMAIN=$(aws cloudfront list-distributions \
        --query "DistributionList.Items[?Comment=='$COMMENT'].DomainName" \
        --output text)
    echo "Distribution already exists: $DIST_ID ($CF_DOMAIN)"
else
    CALLER_REF="psap-reports-$(date +%s)"

    cat > /tmp/cf-config.json << CFEOF
{
  "CallerReference": "$CALLER_REF",
  "Comment": "$COMMENT",
  "DefaultCacheBehavior": {
    "TargetOriginId": "psap-reports-s3",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
    "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
    "ForwardedValues": {"QueryString": false, "Cookies": {"Forward": "none"}},
    "MinTTL": 0,
    "DefaultTTL": 86400,
    "MaxTTL": 31536000,
    "Compress": true
  },
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "psap-reports-s3",
      "DomainName": "$BUCKET.s3.$REGION.amazonaws.com",
      "OriginAccessControlId": "$OAC_ID",
      "S3OriginConfig": {"OriginAccessIdentity": ""}
    }]
  },
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "PriceClass": "PriceClass_100",
  "HttpVersion": "http2and3"
}
CFEOF

    DIST_RESULT=$(aws cloudfront create-distribution --distribution-config file:///tmp/cf-config.json)
    DIST_ID=$(echo "$DIST_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['Distribution']['Id'])")
    CF_DOMAIN=$(echo "$DIST_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['Distribution']['DomainName'])")
    echo "Created distribution: $DIST_ID"
    echo "CloudFront domain: $CF_DOMAIN"
    rm /tmp/cf-config.json
fi

echo ""
echo "=== Step 4: Set S3 Bucket Policy ==="
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

cat > /tmp/bucket-policy.json << BPEOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontOAC",
    "Effect": "Allow",
    "Principal": {"Service": "cloudfront.amazonaws.com"},
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::$BUCKET/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"
      }
    }
  }]
}
BPEOF

aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/bucket-policy.json
echo "Bucket policy set — only CloudFront distribution $DIST_ID can read"
rm /tmp/bucket-policy.json

echo ""
echo "=== Step 5: Upload Test Report ==="
echo '<html><body><h1>PSAP Test Report</h1><p>S3 + CloudFront works.</p></body></html>' | \
    aws s3 cp - "s3://$BUCKET/test/index.html" --content-type text/html
echo "Test report uploaded to s3://$BUCKET/test/index.html"

echo ""
echo "========================================"
echo "  Setup Complete"
echo "========================================"
echo ""
echo "  S3 Bucket:    $BUCKET"
echo "  CloudFront:   https://$CF_DOMAIN"
echo "  Distribution: $DIST_ID"
echo "  OAC:          $OAC_ID"
echo ""
echo "  Test URL:     https://$CF_DOMAIN/test/index.html"
echo "  (CloudFront may take 5-10 min to deploy)"
echo ""
echo "  Update _generator/s3_config.json:"
echo "  {\"bucket\": \"$BUCKET\", \"region\": \"$REGION\", \"cloudfront_domain\": \"$CF_DOMAIN\"}"
echo ""
