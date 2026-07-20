import { readFileSync } from "node:fs";

const workflowUrl = new URL("../.github/workflows/publish.yml", import.meta.url);
const workflow = readFileSync(workflowUrl, "utf8");

const requiredSnippets = [
  ["完整检出历史", "fetch-depth: 0"],
  [
    "显式获取远端 master",
    "git fetch --no-tags --prune origin +refs/heads/master:refs/remotes/origin/master",
  ],
  [
    "校验 tag 提交属于 master 历史",
    'git merge-base --is-ancestor "$GITHUB_SHA" origin/master',
  ],
  ["受保护的 npm environment", "environment: npm"],
  ["OIDC 最小权限", "id-token: write"],
  ["显式启用变量", "vars.NPM_TRUSTED_PUBLISHING_ENABLED == 'true'"],
];

for (const [label, snippet] of requiredSnippets) {
  if (!workflow.includes(snippet)) {
    throw new Error(`npm 发布工作流缺少门禁：${label}`);
  }
}

const fetchMasterIndex = workflow.indexOf(requiredSnippets[1][1]);
const ancestryGuardIndex = workflow.indexOf(requiredSnippets[2][1]);
const publishIndex = workflow.indexOf("npm publish --access public --provenance");

if (!(fetchMasterIndex < ancestryGuardIndex && ancestryGuardIndex < publishIndex)) {
  throw new Error("npm 发布工作流必须先获取 master、校验提交归属，再执行 publish");
}

if (/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/.test(workflow)) {
  throw new Error("npm 发布工作流不得读取长期 npm token");
}

console.log("npm 发布工作流门禁检查通过");
