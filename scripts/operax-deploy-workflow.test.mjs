import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflowPath = new URL("../.github/workflows/operax-deploy.yml", import.meta.url);

test("OperaX deployment builds a native binary and emits standard deployment alerts", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  assert.match(workflow, /actions\/setup-go@/);
  assert.match(workflow, /go test \.\/\.\.\./);
  assert.match(workflow, /go build -tags sqlite_fts5/);
  assert.match(workflow, /\/opt\/operax-wacli\/releases/);
  assert.match(workflow, /ADMIN_ALERT_URL: https:\/\/sa\.boostengine\.ai\/api\/alerts\/ingest/);
  assert.match(workflow, /\\"ruleType\\": \\"deploy_status\\"/);
  assert.match(workflow, /operax-wacli 部署成功/);
  assert.match(workflow, /operax-wacli 部署失败/);
  assert.match(workflow, /PREVIOUS_TARGET/);
});

test("OperaX deployment requires an explicit released ref", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /push:\n\s+tags:/);
  assert.match(workflow, /repos\/openclaw\/wacli\/releases\/tags/);
  assert.match(workflow, /release is draft or prerelease/);
});
