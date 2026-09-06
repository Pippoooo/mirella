import { readFile } from "node:fs/promises";
import { App } from "octokit";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function loadPrivateKey(): Promise<string> {
  // Preferred: read the PEM from a file (easy to mount into the container).
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) {
    return readFile(path, "utf8");
  }

  // Fallback: inline PEM, with literal "\n" sequences turned back into newlines.
  const key = requireEnv("GITHUB_APP_PRIVATE_KEY");
  return key.replaceAll("\\n", "\n");
}

async function main(): Promise<void> {
  const appId = requireEnv("GITHUB_APP_ID");
  const installationId = Number(requireEnv("GITHUB_INSTALLATION_ID"));
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const privateKey = await loadPrivateKey();

  if (Number.isNaN(installationId)) {
    console.error("GITHUB_INSTALLATION_ID must be a number");
    process.exit(1);
  }

  const app = new App({ appId, privateKey });

  const octokit = await app.getInstallationOctokit(installationId);

  const { data: issues } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
  });

  console.log(`Found ${issues.length} open issue(s) in ${owner}/${repo}\n`);
  for (const issue of issues) {
    console.log(`#${issue.number} ${issue.title}`);
  }
}

main().catch((err) => {
  console.error("Failed to list issues:", err);
  process.exit(1);
});