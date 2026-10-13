// Keeps the Terraform module, the deploy script and the docs in step: `npm run test:scripts`.
// (`terraform validate` itself runs in CI.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SETTINGS } from "../deploy-release.mjs";

const read = (path) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

test("every setting the module outputs for the deploy script is one the script reads", () => {
	const outputs = read("infra/terraform/outputs.tf");
	const block = outputs.slice(outputs.indexOf('output "deploy_env"'));
	const keys = block.match(/\b[A-Z][A-Z0-9_]{3,}\b(?=\s*=)/g) ?? [];
	assert.ok(keys.length >= 10, "deploy_env lists the settings");
	for (const key of keys) assert.ok(SETTINGS.includes(key), `${key} is not a deploy-release setting`);
	// The other way round: the module supplies every setting but the optional per-install tweaks.
	for (const key of SETTINGS) assert.ok(keys.includes(key), `deploy_env does not output ${key}`);
});

test("the example pins the module to the version of this repository", () => {
	const { version } = JSON.parse(read("package.json"));
	for (const file of ["infra/terraform/examples/basic/main.tf", "infra/terraform/README.md", "docs/deploy.md"])
		assert.match(read(file), new RegExp(`infra/terraform\\?ref=v${version}"`), file);
	assert.match(read("infra/terraform/examples/basic/kitting-deploy.yml"), new RegExp(`KITTING_VERSION: "${version}"`));
});

test("the CI example is the one the docs show", () => {
	const workflow = read("infra/terraform/examples/basic/kitting-deploy.yml");
	assert.ok(read("docs/deploy.md").includes(workflow), "docs/deploy.md must contain kitting-deploy.yml verbatim");
});
