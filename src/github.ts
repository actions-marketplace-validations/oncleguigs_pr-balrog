import * as core from '@actions/core'
import * as github from '@actions/github'
import { DefaultArtifactClient } from '@actions/artifact'
import AdmZip from 'adm-zip'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Quiz, RepoContext } from './types'

export const CHECK_NAME = 'PR Balrog'
export const ARTIFACT_PREFIX = 'balrog-quiz-'

type Octokit = ReturnType<typeof github.getOctokit>

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export async function fetchPRDiff(
  octokit: Octokit,
  ctx: RepoContext,
): Promise<{ diff: string; changedLines: number }> {
  const { data } = await octokit.rest.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
    mediaType: { format: 'diff' },
  })

  const diff = data as unknown as string
  const additions = (diff.match(/^\+[^+]/gm) ?? []).length
  const deletions = (diff.match(/^-[^-]/gm) ?? []).length

  return { diff, changedLines: additions + deletions }
}

export async function fetchFilteredDiff(
  octokit: Octokit,
  ctx: RepoContext,
  excludePatterns: string[],
): Promise<{ diff: string; changedLines: number }> {
  const { diff, changedLines } = await fetchPRDiff(octokit, ctx)

  if (excludePatterns.length === 0) return { diff, changedLines }

  const regexes = excludePatterns.map(
    (p) => new RegExp(p.replace(/\./g, '\\.').replace(/\*/g, '.*')),
  )

  // split diff by file section and filter out excluded files
  const sections = diff.split(/(?=^diff --git )/m)
  const filtered = sections.filter((section) => {
    const fileMatch = section.match(/^diff --git a\/(.*?) b\//)
    if (!fileMatch) return true
    return !regexes.some((r) => r.test(fileMatch[1]))
  })

  const filteredDiff = filtered.join('')
  const filtAdditions = (filteredDiff.match(/^\+[^+]/gm) ?? []).length
  const filtDeletions = (filteredDiff.match(/^-[^-]/gm) ?? []).length

  return { diff: filteredDiff, changedLines: filtAdditions + filtDeletions }
}

// ---------------------------------------------------------------------------
// Checks API
// ---------------------------------------------------------------------------

export async function createPendingCheck(
  octokit: Octokit,
  ctx: RepoContext,
): Promise<number> {
  core.info(`Creating pending check for ${ctx.headSha}`)
  const { data } = await octokit.rest.checks.create({
    owner: ctx.owner,
    repo: ctx.repo,
    name: CHECK_NAME,
    head_sha: ctx.headSha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    output: {
      title: 'Quiz required',
      summary: 'Answer the PR Balrog quiz in the pull request comment to unlock merge.',
    },
  })
  return data.id
}

export async function updateCheckSuccess(
  octokit: Octokit,
  ctx: RepoContext,
  checkId: number,
  score: number,
): Promise<void> {
  core.info(`Marking check ${checkId} as success (score: ${score}%)`)
  await octokit.rest.checks.update({
    owner: ctx.owner,
    repo: ctx.repo,
    check_run_id: checkId,
    status: 'completed',
    conclusion: 'success',
    completed_at: new Date().toISOString(),
    output: {
      title: `Quiz passed — ${score}%`,
      summary: `The PR author passed the Balrog quiz with a score of ${score}%. You shall pass.`,
    },
  })
}

export async function updateCheckFailure(
  octokit: Octokit,
  ctx: RepoContext,
  checkId: number,
  score: number,
  attemptsLeft: number,
): Promise<void> {
  const exhausted = attemptsLeft === 0
  core.info(`Marking check ${checkId} as ${exhausted ? 'failure' : 'in_progress'} (score: ${score}%)`)

  if (exhausted) {
    await octokit.rest.checks.update({
      owner: ctx.owner,
      repo: ctx.repo,
      check_run_id: checkId,
      status: 'completed',
      conclusion: 'failure',
      completed_at: new Date().toISOString(),
      output: {
        title: `Quiz failed — ${score}% (no attempts left)`,
        summary: 'All attempts exhausted. You shall not pass.',
      },
    })
  } else {
    await octokit.rest.checks.update({
      owner: ctx.owner,
      repo: ctx.repo,
      check_run_id: checkId,
      status: 'in_progress',
      output: {
        title: `Quiz failed — ${score}% — ${attemptsLeft} attempt(s) left`,
        summary: `Score below threshold. ${attemptsLeft} attempt(s) remaining.`,
      },
    })
  }
}

export async function findExistingCheck(
  octokit: Octokit,
  ctx: RepoContext,
): Promise<number | null> {
  const { data } = await octokit.rest.checks.listForRef({
    owner: ctx.owner,
    repo: ctx.repo,
    ref: ctx.headSha,
    check_name: CHECK_NAME,
  })
  if (data.total_count === 0) return null
  // return the most recent one
  const sorted = [...data.check_runs].sort(
    (a, b) => new Date(b.started_at ?? 0).getTime() - new Date(a.started_at ?? 0).getTime(),
  )
  return sorted[0].id
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export async function postComment(
  octokit: Octokit,
  ctx: RepoContext,
  body: string,
): Promise<number> {
  const { data } = await octokit.rest.issues.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
    body,
  })
  return data.id
}

export async function updateComment(
  octokit: Octokit,
  ctx: RepoContext,
  commentId: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.updateComment({
    owner: ctx.owner,
    repo: ctx.repo,
    comment_id: commentId,
    body,
  })
}

export async function findQuizComment(
  octokit: Octokit,
  ctx: RepoContext,
  quizId: string,
): Promise<number | null> {
  return findBalrogComment(octokit, ctx, `<!-- balrog-quiz-id: ${quizId} -->`)
}

export async function findAnyBalrogComment(
  octokit: Octokit,
  ctx: RepoContext,
): Promise<number | null> {
  return findBalrogComment(octokit, ctx, '<!-- balrog-quiz-id:')
}

async function findBalrogComment(
  octokit: Octokit,
  ctx: RepoContext,
  marker: string,
): Promise<number | null> {
  for await (const page of octokit.paginate.iterator(octokit.rest.issues.listComments, {
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
    per_page: 100,
  })) {
    for (const comment of page.data) {
      if ((comment.body ?? '').includes(marker)) return comment.id
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Artifact storage (quiz + answers)
// ---------------------------------------------------------------------------

export async function saveQuizArtifact(quiz: Quiz): Promise<void> {
  const client = new DefaultArtifactClient()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balrog-'))
  const filePath = path.join(tmpDir, 'quiz.json')
  fs.writeFileSync(filePath, JSON.stringify(quiz, null, 2))

  await client.uploadArtifact(
    `${ARTIFACT_PREFIX}${quiz.prNumber}`,
    [filePath],
    tmpDir,
    { retentionDays: 1 },
  )

  fs.rmSync(tmpDir, { recursive: true })
  core.info(`Quiz artifact saved: ${ARTIFACT_PREFIX}${quiz.prNumber}`)
}

// loadQuizArtifact finds artifacts across workflow runs via REST API and
// downloads them directly — @actions/artifact client can only access artifacts
// from the current run, so we bypass it entirely for cross-run access.
export async function loadQuizArtifact(
  prNumber: number,
  octokit: Octokit,
  owner: string,
  repo: string,
  token: string,
): Promise<Quiz | null> {
  const artifactName = `${ARTIFACT_PREFIX}${prNumber}`
  core.info(`Searching for artifact "${artifactName}" in ${owner}/${repo}`)

  const { data } = await octokit.rest.actions.listArtifactsForRepo({
    owner,
    repo,
    name: artifactName,
    per_page: 5,
  })

  if (data.total_count === 0) {
    core.warning(`No quiz artifact found for PR #${prNumber}`)
    return null
  }

  const target = data.artifacts
    .filter((a) => !a.expired)
    .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0]

  if (!target) {
    core.warning(`All quiz artifacts for PR #${prNumber} have expired`)
    return null
  }

  core.info(`Found artifact id=${target.id} created=${target.created_at}, downloading...`)

  // GitHub redirects to a short-lived S3 URL. We fetch the redirect destination
  // directly with fetch() so we get a proper binary response — Octokit's
  // downloadArtifact mangles ArrayBuffer on redirects in the Actions runtime.
  // Get the redirect URL (archive_download_url requires auth to resolve)
  const redirectRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${target.id}/zip`,
    {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )

  const downloadUrl = redirectRes.headers.get('location') ?? target.archive_download_url
  core.info(`Downloading zip from: ${downloadUrl.slice(0, 60)}...`)

  const zipRes = await fetch(downloadUrl)
  if (!zipRes.ok) {
    core.warning(`Failed to download zip: ${zipRes.status} ${zipRes.statusText}`)
    return null
  }

  const zipBuffer = Buffer.from(await zipRes.arrayBuffer())
  core.info(`Downloaded ${zipBuffer.length} bytes`)

  return extractQuizFromZip(zipBuffer)
}

function extractQuizFromZip(zipBuffer: Buffer): Quiz | null {
  try {
    const zip = new AdmZip(zipBuffer)
    const entry = zip.getEntry('quiz.json')
    if (!entry) {
      core.warning('quiz.json not found in artifact zip')
      return null
    }
    const raw = entry.getData().toString('utf-8')
    return JSON.parse(raw) as Quiz
  } catch (err) {
    core.warning(`Failed to extract quiz from zip: ${String(err)}`)
    return null
  }
}
