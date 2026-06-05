/**
 * GitHub tools — answer questions about commits, diffs between refs (branches or
 * tags), pull requests, and deployments/environments for any repo.
 *
 * Native FunctionTools (not an MCP server) on purpose: the Pi runs a small local
 * model that handles a few focused tools far better than the dozens an MCP server
 * exposes. Each tool talks to the GitHub REST API via `fetch` with a Personal
 * Access Token (works for private repos, no `gh` install needed on the Pi).
 *
 * `repo` is "owner/repo" and is optional on every tool — it falls back to
 * GITHUB_DEFAULT_REPO so you don't have to name the repo by voice every time.
 */
import { FunctionTool } from '@google/adk';
// Import from the same zod build ADK uses for tool schemas (`zod/v4`).
import { z } from 'zod/v4';
import { config } from '../config/env.js';

const API = 'https://api.github.com';

/** Resolve the `repo` param (or the configured default) into owner + name. */
function resolveRepo(repo?: string): { owner: string; name: string } {
  const slug = (repo ?? config.tools.githubDefaultRepo).trim();
  const m = slug.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) {
    throw new Error(
      repo
        ? `repo must be "owner/repo" (got "${repo}")`
        : 'No repository specified — ask the user which repo they mean (as owner/repo).',
    );
  }
  return { owner: m[1]!, name: m[2]! };
}

/** One GitHub REST call. Throws on non-2xx so callers can return {error}. */
async function gh<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.tools.githubToken) headers.Authorization = `Bearer ${config.tools.githubToken}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const hint = res.status === 404 ? ' (repo/ref not found, or token lacks access)' : '';
    throw new Error(`GitHub ${res.status}${hint}`);
  }
  return (await res.json()) as T;
}

const shortMsg = (m: string) => (m.split('\n', 1)[0] ?? '').slice(0, 120);

// --- commit / ref types we read from the API ------------------------------
interface ApiCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author?: { name?: string; date?: string } };
  author?: { login?: string } | null;
}
const mapCommit = (c: ApiCommit) => ({
  sha: c.sha.slice(0, 7),
  message: shortMsg(c.commit.message),
  author: c.author?.login ?? c.commit.author?.name ?? 'unknown',
  date: c.commit.author?.date ?? '',
  url: c.html_url,
});

// ---------------------------------------------------------------------------
// 1) Recent commits
// ---------------------------------------------------------------------------
const commitsTool = new FunctionTool({
  name: 'github_commits',
  description:
    'List recent commits in a GitHub repo. Use for "what changed recently", ' +
    'commits by an author, or commits touching a file. Optionally scope to a ' +
    'branch/tag and filter by author or file path.',
  parameters: z.object({
    repo: z.string().optional().describe('Repository as "owner/repo", taken from what the user said (e.g. "in my home-assistant repo"). Ask the user if they did not name one.'),
    ref: z.string().optional().describe('Branch, tag, or SHA to list commits from (default: the default branch).'),
    author: z.string().optional().describe('Filter to commits by this GitHub username or email.'),
    path: z.string().optional().describe('Filter to commits that touched this file or directory.'),
    limit: z.number().optional().describe('Max commits to return (default 10, max 30).'),
  }),
  execute: async ({ repo, ref, author, path, limit }) => {
    try {
      const { owner, name } = resolveRepo(repo);
      const params: Record<string, string | number> = { per_page: Math.min(limit ?? 10, 30) };
      if (ref) params.sha = ref;
      if (author) params.author = author;
      if (path) params.path = path;
      const commits = await gh<ApiCommit[]>(`/repos/${owner}/${name}/commits`, params);
      return { repo: `${owner}/${name}`, ref: ref ?? 'default', count: commits.length, commits: commits.map(mapCommit) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});

// ---------------------------------------------------------------------------
// 2) Compare two refs (branches OR tags) — "what's in head not in base"
// ---------------------------------------------------------------------------
interface ApiCompare {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits: ApiCommit[];
  files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
}
const compareTool = new FunctionTool({
  name: 'github_compare',
  description:
    'Compare two refs in a repo and report what is in HEAD but not in BASE — ' +
    'the commits ahead/behind and files changed. Refs can be branches OR tags. ' +
    'Use for "what is in main but not yet in production", "what changed between ' +
    'v1.2.0 and v1.3.0", or "what is pending to deploy".',
  parameters: z.object({
    repo: z.string().optional().describe('Repository as "owner/repo", taken from what the user said (e.g. "in my home-assistant repo"). Ask the user if they did not name one.'),
    base: z.string().describe('The baseline ref (branch or tag), e.g. "production".'),
    head: z.string().describe('The ref to compare against the base (branch or tag), e.g. "main".'),
    limit: z.number().optional().describe('Max commits to list (default 15, max 40).'),
  }),
  execute: async ({ repo, base, head, limit }) => {
    try {
      const { owner, name } = resolveRepo(repo);
      const cmp = await gh<ApiCompare>(`/repos/${owner}/${name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      const files = cmp.files ?? [];
      return {
        repo: `${owner}/${name}`,
        base,
        head,
        status: cmp.status, // ahead | behind | identical | diverged
        aheadBy: cmp.ahead_by, // commits in head not in base
        behindBy: cmp.behind_by,
        commits: cmp.commits.slice(-(Math.min(limit ?? 15, 40))).reverse().map(mapCommit),
        filesChanged: files.length,
        files: files.slice(0, 20).map((f) => ({ file: f.filename, status: f.status, '+': f.additions, '-': f.deletions })),
      };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});

// ---------------------------------------------------------------------------
// 3) Pull requests — incl. merges between environment branches
// ---------------------------------------------------------------------------
interface ApiPull {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  created_at: string;
  html_url: string;
  user?: { login?: string };
  base: { ref: string };
  head: { ref: string };
}
const pullsTool = new FunctionTool({
  name: 'github_pulls',
  description:
    'List or search pull requests in a repo. Use for "open PRs", "what was ' +
    'merged recently", or merges between environment branches (e.g. PRs from ' +
    '"staging" into "production"). Filter by state and by base/head branch.',
  parameters: z.object({
    repo: z.string().optional().describe('Repository as "owner/repo", taken from what the user said (e.g. "in my home-assistant repo"). Ask the user if they did not name one.'),
    state: z.enum(['open', 'closed', 'merged', 'all']).optional().describe('PR state (default open). "merged" = closed PRs that were actually merged.'),
    base: z.string().optional().describe('Only PRs targeting this base branch (e.g. "production").'),
    head: z.string().optional().describe('Only PRs from this head branch (e.g. "staging").'),
    limit: z.number().optional().describe('Max PRs to return (default 10, max 30).'),
  }),
  execute: async ({ repo, state, base, head, limit }) => {
    try {
      const { owner, name } = resolveRepo(repo);
      const wantMerged = state === 'merged';
      const params: Record<string, string | number> = {
        state: wantMerged ? 'closed' : state ?? 'open',
        per_page: Math.min(limit ?? 10, 30),
        sort: 'updated',
        direction: 'desc',
      };
      if (base) params.base = base;
      // GitHub's head filter wants "owner:branch".
      if (head) params.head = head.includes(':') ? head : `${owner}:${head}`;
      let pulls = await gh<ApiPull[]>(`/repos/${owner}/${name}/pulls`, params);
      if (wantMerged) pulls = pulls.filter((p) => p.merged_at);
      return {
        repo: `${owner}/${name}`,
        count: pulls.length,
        pulls: pulls.map((p) => ({
          number: p.number,
          title: p.title.slice(0, 120),
          state: p.merged_at ? 'merged' : p.state,
          from: p.head.ref,
          into: p.base.ref,
          author: p.user?.login ?? 'unknown',
          mergedAt: p.merged_at ?? undefined,
          url: p.html_url,
        })),
      };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});

// ---------------------------------------------------------------------------
// 4) Deployments / environments — "what's live in production"
// ---------------------------------------------------------------------------
interface ApiDeployment { id: number; sha: string; ref: string; environment: string; created_at: string }
interface ApiDeployStatus { state: string; created_at: string; environment_url?: string }
const deploymentsTool = new FunctionTool({
  name: 'github_deployments',
  description:
    "List a repo's recent deployments and their current state per environment. " +
    'Use for "what is deployed in production right now", "what version is on ' +
    'staging", or the latest deploy status of an environment.',
  parameters: z.object({
    repo: z.string().optional().describe('Repository as "owner/repo", taken from what the user said (e.g. "in my home-assistant repo"). Ask the user if they did not name one.'),
    environment: z.string().optional().describe('Filter to one environment, e.g. "production" or "staging".'),
    limit: z.number().optional().describe('Max deployments to return (default 5, max 15).'),
  }),
  execute: async ({ repo, environment, limit }) => {
    try {
      const { owner, name } = resolveRepo(repo);
      const params: Record<string, string | number> = { per_page: Math.min(limit ?? 5, 15) };
      if (environment) params.environment = environment;
      const deps = await gh<ApiDeployment[]>(`/repos/${owner}/${name}/deployments`, params);
      // Latest status per deployment (state = success | failure | in_progress | …).
      const out = await Promise.all(
        deps.map(async (d) => {
          let state = 'unknown';
          try {
            const st = await gh<ApiDeployStatus[]>(`/repos/${owner}/${name}/deployments/${d.id}/statuses`, { per_page: 1 });
            if (st[0]) state = st[0].state;
          } catch {
            /* status fetch is best-effort */
          }
          return { environment: d.environment, ref: d.ref, sha: d.sha.slice(0, 7), state, deployedAt: d.created_at };
        }),
      );
      return { repo: `${owner}/${name}`, count: out.length, deployments: out };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});

/** All GitHub tools, registered together behind the `config.tools.github` flag. */
export const githubTools = [commitsTool, compareTool, pullsTool, deploymentsTool];
