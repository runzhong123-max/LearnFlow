import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(root, 'apps/role-atlas');
const require = createRequire(resolve(app, 'package.json'));
const { parse } = require('yaml');
const deploy = resolve(app, 'deploy/cohost');
const config = parse(readFileSync(resolve(deploy, 'compose.yaml'), 'utf8'));
const defaultContext = value => value.replace(/^\$\{LEARNFLOW_REPO_PATH:-([^}]+)\}$/, '$1');

assert.equal(existsSync(resolve(app, '.git')), false, 'Role Atlas must not be a nested Git repository');
for (const service of ['learnflow-backend', 'learnflow-frontend', 'role-atlas']) {
  const build = config.services[service].build;
  assert.equal(resolve(deploy, defaultContext(build.context)), root, `${service} must build from the same checkout`);
  assert.ok(existsSync(resolve(root, build.dockerfile)), `${service} Dockerfile missing`);
}
for (const name of ['graph.json', 'learnflow-learning-path.json', 'object-index.jsonl', 'validation-report.json', 'work-process-validation-report.json', 'work-process.json']) {
  assert.ok(existsSync(resolve(app, 'public/data', name)), `versioned fixture missing: ${name}`);
}
const example = readFileSync(resolve(deploy, '.env.example'), 'utf8');
const configured = example.match(/^LEARNFLOW_REPO_PATH=(.+)$/m)?.[1];
assert.ok(configured, 'deployment example must document the same-checkout path');
assert.equal(resolve(deploy, configured), root);
console.log('Role Atlas integration layout: same-checkout build contexts, source fixtures and Git boundary verified.');
