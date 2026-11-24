'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const template = JSON.parse(fs.readFileSync('_infra/publication-stack.json', 'utf8'));

function evaluate(value, parameters) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => evaluate(item, parameters));
  if (value.Ref) return parameters[value.Ref];
  if (value.Condition) return evaluate(template.Conditions[value.Condition], parameters);
  if (value['Fn::Equals']) return evaluate(value['Fn::Equals'][0], parameters) === evaluate(value['Fn::Equals'][1], parameters);
  if (value['Fn::And']) return value['Fn::And'].every(item => evaluate(item, parameters));
  if (value['Fn::Not']) return !evaluate(value['Fn::Not'][0], parameters);
  if (value['Fn::If']) {
    const [condition, yes, no] = value['Fn::If'];
    return evaluate(evaluate(template.Conditions[condition], parameters) ? yes : no, parameters);
  }
  throw new Error('Unsupported template expression');
}

test('cleanup alarm actions require both scheduling and explicit notification readiness', () => {
  assert.equal(template.Parameters.CleanupNotificationsEnabled?.Default, 'false');
  for (const scheduled of ['false','true']) for (const ready of ['false','true']) {
    const parameters = { CleanupEnabled: scheduled, CleanupNotificationsEnabled: ready };
    assert.equal(evaluate(template.Resources.Schedule.Properties.State, parameters), scheduled === 'true' ? 'ENABLED' : 'DISABLED');
    for (const resource of Object.values(template.Resources).filter(r => r.Type === 'AWS::CloudWatch::Alarm')) {
      assert.equal(evaluate(resource.Properties.ActionsEnabled, parameters), scheduled === 'true' && ready === 'true');
    }
  }
  assert.equal(template.Resources.HeartbeatAlarm.Properties.TreatMissingData, 'breaching');
  assert.equal(template.Resources.ScanAgeAlarm.Properties.TreatMissingData, 'breaching');
});

test('API staging lookup lists only the managed upload namespace', () => {
  const statements = template.Resources.ApiPublicationPolicy.Properties.PolicyDocument.Statement;
  const statement = statements.find(s => JSON.stringify(s.Resource) === JSON.stringify({ 'Fn::GetAtt': ['Staging','Arn'] }) && s.Action.includes('s3:ListBucket'));
  assert.ok(statement, 'Missing scoped staging listing permission');
  assert.deepEqual(statement.Condition, { StringLike: { 's3:prefix': ['uploads/*'] } });
  assert.deepEqual(statement.Action, ['s3:ListBucket']);
});

test('API can prove missing locators with prefix-scoped listing only', () => {
  const statements = template.Resources.ApiPublicationPolicy.Properties.PolicyDocument.Statement;
  const statement = statements.find(s => s.Condition?.StringLike?.['s3:prefix']?.includes('report-locators-v2/*'));
  assert.ok(statement, 'Missing locator absence-check permission');
  assert.deepEqual(statement.Action, ['s3:ListBucket']);
  assert.deepEqual(statement.Condition, { StringLike: { 's3:prefix': ['report-locators-v2/*'] } });
  assert.deepEqual(statement.Resource, { 'Fn::Sub': 'arn:${AWS::Partition}:s3:::${ReportBucket}' });
});

test('notification destinations are managed by the template across readiness updates', () => {
  assert.equal(template.Parameters.AlarmTopicArn.Default, '');
  for (const topic of ['', 'arn:aws:sns:us-east-1:123456789012:alerts']) {
    for (const resource of Object.values(template.Resources).filter(r => r.Type === 'AWS::CloudWatch::Alarm')) {
      assert.deepEqual(evaluate(resource.Properties.AlarmActions, { AlarmTopicArn: topic }), topic ? [topic] : []);
    }
  }
});
