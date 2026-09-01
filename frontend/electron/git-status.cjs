const { execFile } = require("node:child_process");
const path = require("node:path");

const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;

function runGit(args, options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  return new Promise((resolve, reject) => {
    execFileImpl(
      "git",
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: GIT_OUTPUT_LIMIT,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function sourceControlStatus(xy) {
  if (xy === "??") return "U";
  if (xy === "!!") return "";
  if (xy.includes("D")) return "D";
  if (/[ARC]/.test(xy)) return "A";
  return "M";
}

function parseGitStatus(output = "") {
  const records = String(output).split("\0");
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const xy = record.slice(0, 2);
    const relativePath = record.slice(3).replaceAll("\\", "/");
    const status = sourceControlStatus(xy);
    if (status && relativePath) entries.push({ path: relativePath, status });
    if (/[RC]/.test(xy)) index += 1;
  }
  return entries;
}

async function readGitStatus(projectRoot, options = {}) {
  const runner = options.runGit || runGit;
  try {
    const root = String(await runner(["-C", projectRoot, "rev-parse", "--show-toplevel"]))
      .trim();
    const output = await runner([
      "-C",
      projectRoot,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
    ]);
    const projectPrefix = path.relative(root, projectRoot).replaceAll("\\", "/");
    const entries = parseGitStatus(output).flatMap((entry) => {
      if (!projectPrefix) return [entry];
      const prefix = `${projectPrefix}/`;
      return entry.path.startsWith(prefix)
        ? [{ ...entry, path: entry.path.slice(prefix.length) }]
        : [];
    });
    return {
      active: true,
      entries,
      root,
    };
  } catch {
    return { active: false, entries: [], root: "" };
  }
}

function parseGitHistory(output = "") {
  return String(output)
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const normalizedRecord = record.replace(/^\n+/, "");
      const [hash = "", shortHash = "", author = "", authoredAt = "", subject = "", message = "", refsAndStats = ""] = normalizedRecord.split("\x1f");
      const [refs = "", ...statLines] = refsAndStats.split("\n");
      let insertions = 0;
      let deletions = 0;
      for (const line of statLines) {
        const [added, deleted] = line.split("\t");
        if (/^\d+$/.test(added)) insertions += Number(added);
        if (/^\d+$/.test(deleted)) deletions += Number(deleted);
      }
      return {
        author,
        authoredAt,
        deletions,
        hash,
        insertions,
        message: message.trimEnd(),
        refs,
        shortHash,
        subject,
      };
    })
    .filter((entry) => entry.hash);
}

async function readGitHistory(projectRoot, options = {}) {
  const runner = options.runGit || runGit;
  try {
    const root = String(await runner(["-C", projectRoot, "rev-parse", "--show-toplevel"])).trim();
    const output = await runner([
      "-C", projectRoot, "log", "--max-count=100", "--date=iso-strict", "--numstat",
      "--pretty=format:%x00%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%B%x1f%D",
    ]);
    return { active: true, commits: parseGitHistory(output), root };
  } catch {
    return { active: false, commits: [], root: "" };
  }
}

function parseGitWorktrees(output = "") {
  const worktrees = [];
  let current = null;
  for (const line of String(output).split("\n")) {
    if (!line) {
      if (current?.path) worktrees.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current = { bare: false, branch: "", detached: false, head: "", locked: false, path: value, prunable: false };
    else if (!current) continue;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
    else if (key === "locked") current.locked = true;
    else if (key === "prunable") current.prunable = true;
  }
  if (current?.path) worktrees.push(current);
  return worktrees;
}

async function readGitWorktrees(projectRoot, options = {}) {
  const runner = options.runGit || runGit;
  try {
    const root = String(await runner(["-C", projectRoot, "rev-parse", "--show-toplevel"])).trim();
    const output = await runner(["-C", projectRoot, "worktree", "list", "--porcelain"]);
    return { active: true, root, worktrees: parseGitWorktrees(output) };
  } catch {
    return { active: false, root: "", worktrees: [] };
  }
}

async function addGitWorktree(projectRoot, targetPath, branch, options = {}) {
  const runner = options.runGit || runGit;
  const args = ["-C", projectRoot, "worktree", "add"];
  if (options.createBranch === true) args.push("-b", branch);
  args.push(targetPath);
  if (options.createBranch !== true && branch) args.push(branch);
  await runner(args);
  return readGitWorktrees(projectRoot, options);
}

async function removeGitWorktree(projectRoot, targetPath, options = {}) {
  const runner = options.runGit || runGit;
  await runner(["-C", projectRoot, "worktree", "remove", targetPath]);
  return readGitWorktrees(projectRoot, options);
}

function parseGitDiffHunks(output = "") {
  const hunks = [];
  for (const line of String(output).split("\n")) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const startLine = Number(match[1]);
    const lineCount = match[2] == null ? 1 : Number(match[2]);
    hunks.push({
      endLine: lineCount > 0 ? startLine + lineCount - 1 : Math.max(1, startLine),
      startLine: Math.max(1, startLine),
    });
  }
  return hunks;
}

async function readGitFileBaseline(targetPath, options = {}) {
  const runner = options.runGit || runGit;
  const directory = path.dirname(targetPath);
  try {
    const root = String(await runner(["-C", directory, "rev-parse", "--show-toplevel"]))
      .trim();
    const relativePath = path.relative(root, targetPath).replaceAll("\\", "/");
    if (!relativePath || relativePath.startsWith("../")) {
      return { changed: false, content: "", hunks: [], tracked: false };
    }
    try {
      await runner(["-C", root, "ls-files", "--error-unmatch", "--", relativePath]);
    } catch {
      return { changed: false, content: "", hunks: [], tracked: false };
    }
    let content = "";
    try {
      content = String(await runner(["-C", root, "show", `HEAD:${relativePath}`]));
    } catch {
      // A staged addition is tracked but has no version in HEAD yet.
    }
    const diff = String(await runner([
      "-C",
      root,
      "diff",
      "HEAD",
      "--no-color",
      "--no-ext-diff",
      "--unified=0",
      "--",
      relativePath,
    ]));
    return {
      changed: diff.length > 0,
      content,
      hunks: parseGitDiffHunks(diff),
      tracked: true,
    };
  } catch {
    return { changed: false, content: "", hunks: [], tracked: false };
  }
}

module.exports = {
  parseGitStatus,
  parseGitDiffHunks,
  parseGitHistory,
  readGitFileBaseline,
  parseGitWorktrees,
  readGitHistory,
  readGitStatus,
  readGitWorktrees,
  addGitWorktree,
  removeGitWorktree,
  runGit,
  sourceControlStatus,
};
