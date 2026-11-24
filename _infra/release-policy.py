#!/usr/bin/env python3
"""Generate, but never apply, OIDC permissions for existing release resources."""
import argparse
import json
import tempfile
from pathlib import Path
from release import Release, ReleaseError


def split_policy(document, maximum=5800):
    """Fit AWS managed-policy size limits without widening any statement."""
    documents = []
    current = {'Version': '2012-10-17', 'Statement': []}
    for statement in document['Statement']:
        if len(json.dumps({'Version': '2012-10-17', 'Statement': [statement]}, separators=(',', ':'))) > maximum:
            raise ReleaseError('Single permission statement exceeds policy limit')
        candidate = {**current, 'Statement': [*current['Statement'], statement]}
        if len(json.dumps(candidate, separators=(',', ':'))) > maximum:
            if not current['Statement']:
                raise ReleaseError('Single permission statement exceeds policy limit')
            documents.append(current)
            current = {'Version': '2012-10-17', 'Statement': [statement]}
        else:
            current = candidate
    if current['Statement']:
        documents.append(current)
    return documents


def policy():
    statements = []
    def allow(actions, resources, **extra):
        statements.append({'Effect': 'Allow', 'Action': actions, 'Resource': resources, **extra})
    with tempfile.TemporaryDirectory(prefix='psap-policy-') as work:
        for target in ('production', 'validation'):
            r = Release(target, work, 'bootstrap')
            c = r.config
            if r.aws('sts', 'get-caller-identity')['Account'] != c['account']:
                raise ReleaseError('Wrong account')
            region, account = c['region'], c['account']
            stack = r.aws('cloudformation', 'describe-stacks', '--stack-name', c['stack'])['Stacks'][0]
            resources = r.aws('cloudformation', 'describe-stack-resources', '--stack-name', c['stack'])['StackResources']
            ids = {x['LogicalResourceId']: x['PhysicalResourceId'] for x in resources}
            lambda_arn = f'arn:aws:lambda:{region}:{account}:function:'
            functions = [lambda_arn + c['api_function'], lambda_arn + c['edge_function'], lambda_arn + ids['Worker']]
            allow(['lambda:GetFunction', 'lambda:GetFunctionConfiguration', 'lambda:UpdateFunctionCode',
                   'lambda:UpdateFunctionConfiguration', 'lambda:PublishVersion', 'lambda:ListVersionsByFunction',
                   'lambda:GetPolicy', 'lambda:GetRuntimeManagementConfig', 'lambda:GetFunctionCodeSigningConfig',
                   'lambda:ListTags', 'lambda:TagResource', 'lambda:UntagResource'], functions)
            allow(['lambda:GetFunction', 'lambda:EnableReplication*', 'lambda:DisableReplication*'], [lambda_arn + c['edge_function'] + ':*'])
            allow(['lambda:InvokeFunction', 'lambda:AddPermission', 'lambda:RemovePermission',
                   'lambda:PutFunctionConcurrency', 'lambda:GetFunctionConcurrency'], [lambda_arn + ids['Worker']])
            roles = [f'arn:aws:iam::{account}:role/' + name for name in (c['api_role'], c['edge_role'], ids['WorkerRole'])]
            allow(['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies',
                   'iam:PutRolePolicy', 'iam:DeleteRolePolicy'], roles)
            # CloudFormation owns only the worker role; API/edge roles are external.
            allow(['iam:ListRoleTags', 'iam:TagRole', 'iam:UntagRole'],
                  [f"arn:aws:iam::{account}:role/{ids['WorkerRole']}"])
            allow(['iam:PassRole'], roles, Condition={'StringEquals': {'iam:PassedToService': 'lambda.amazonaws.com'}})
            allow(['cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:DescribeStackResources',
                   'cloudformation:GetTemplate', 'cloudformation:GetTemplateSummary', 'cloudformation:CreateChangeSet', 'cloudformation:ExecuteChangeSet',
                   'cloudformation:DescribeChangeSet', 'cloudformation:DeleteChangeSet'],
                  [stack['StackId'], f'arn:aws:cloudformation:{region}:{account}:changeSet/awscli-cloudformation-package-deploy-*/*'])
            allow(['cloudfront:GetDistribution', 'cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution',
                   'cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'], [f"arn:aws:cloudfront::{account}:distribution/{c['distribution']}"])
            allow(['apigateway:GET', 'apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH'],
                  [f"arn:aws:apigateway:{region}::/restapis/{c['api_id']}/*"])
            allow(['secretsmanager:GetSecretValue'], [f"arn:aws:secretsmanager:{region}:{account}:secret:{c['secret_id']}-??????"])
            allow(['s3:PutObject', 's3:GetObject'], [f"arn:aws:s3:::{c['artifact_bucket']}/publication/*"])
            staging = 'arn:aws:s3:::' + ids['Staging']
            allow(['s3:GetBucketLocation', 's3:ListBucket', 's3:GetBucketVersioning', 's3:PutBucketVersioning', 's3:GetBucketPolicy', 's3:PutBucketPolicy',
                   's3:GetBucketCORS', 's3:PutBucketCORS', 's3:GetLifecycleConfiguration', 's3:PutLifecycleConfiguration',
                   's3:GetEncryptionConfiguration', 's3:PutEncryptionConfiguration', 's3:GetBucketPublicAccessBlock',
                   's3:PutBucketPublicAccessBlock', 's3:GetBucketOwnershipControls', 's3:PutBucketOwnershipControls',
                   's3:GetBucketTagging', 's3:PutBucketTagging'], [staging])
            allow(['s3:GetObject'], [f"arn:aws:s3:::{c['bucket']}/report-reconciliation-v2/checkpoint.json"])
            if target == 'validation':
                allow(['s3:GetObject', 's3:PutObject'], [f"arn:aws:s3:::{c['bucket']}/report-control-v2/*"])
                allow(['s3:ListBucketVersions'], [staging, f"arn:aws:s3:::{c['bucket']}"],
                      Condition={'StringLike': {'s3:prefix': ['uploads/*', 'report-objects-v2/*']}})
            log = f"arn:aws:logs:{region}:{account}:log-group:/aws/lambda/{ids['Worker']}"
            allow(['logs:PutMetricFilter', 'logs:DeleteMetricFilter', 'logs:DescribeMetricFilters', 'logs:PutRetentionPolicy',
                   'logs:TagResource', 'logs:UntagResource', 'logs:ListTagsForResource'], [log, log + ':*'])
            alarm_arns = [f"arn:aws:cloudwatch:{region}:{account}:alarm:{x['PhysicalResourceId']}" for x in resources if x['ResourceType'] == 'AWS::CloudWatch::Alarm']
            allow(['cloudwatch:PutMetricAlarm', 'cloudwatch:DescribeAlarms', 'cloudwatch:ListTagsForResource',
                   'cloudwatch:TagResource', 'cloudwatch:UntagResource'], alarm_arns)
            rule = f"arn:aws:events:{region}:{account}:rule/{ids['Schedule']}"
            allow(['events:DescribeRule', 'events:PutRule', 'events:PutTargets', 'events:ListTargetsByRule',
                   'events:ListTagsForResource', 'events:TagResource', 'events:UntagResource'], [rule])
    allow(['sts:GetCallerIdentity'], ['*'])
    # These read-only CloudWatch/Logs APIs do not support resource-level scoping.
    allow(['cloudwatch:GetMetricStatistics', 'logs:DescribeLogGroups'], ['*'])
    return {'Version': '2012-10-17', 'Statement': statements}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.output_dir.exists() and any(args.output_dir.iterdir()):
            raise ReleaseError('Use a new or empty policy output directory')
        documents = split_policy(policy())
        args.output_dir.mkdir(parents=True, exist_ok=True)
        for index, document in enumerate(documents, 1):
            (args.output_dir / f'backend-release-{index}.json').write_text(json.dumps(document, indent=2))
    except Exception:
        raise SystemExit('Permission inventory failed; no policy was applied.') from None
    print('Wrote proposed managed policies for review. No IAM changes applied.')
