import * as core from '@actions/core'
import * as github from '@actions/github'
import { parseAnswerComment, evaluateQuiz, renderResultComment } from './quiz'
import {
  loadQuizArtifact,
  saveQuizArtifact,
  postComment,
  findExistingCheck,
  updateCheckSuccess,
  updateCheckFailure,
} from './github'

type Octokit = ReturnType<typeof github.getOctokit>

async function isAllowedResponder(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commenterLogin: string,
  authorLogin: string,
  policy: string,
): Promise<boolean> {
  if (commenterLogin === authorLogin) return true

  switch (policy) {
    case 'author':
      return false

    case 'reviewer': {
      const { data: requested } = await octokit.rest.pulls.listRequestedReviewers({
        owner, repo, pull_number: prNumber,
      })
      if (requested.users.some((u) => u.login === commenterLogin)) return true

      const { data: reviews } = await octokit.rest.pulls.listReviews({
        owner, repo, pull_number: prNumber,
      })
      return reviews.some((r) => r.user?.login === commenterLogin)
    }

    case 'collaborator': {
      try {
        const { data: perm } = await octokit.rest.repos.getCollaboratorPermissionLevel({
          owner, repo, username: commenterLogin,
        })
        return ['write', 'maintain', 'admin'].includes(perm.permission)
      } catch {
        return false
      }
    }

    case 'any':
      return true

    default:
      core.warning(`Unknown quiz-responder policy '${policy}', defaulting to 'author'`)
      return false
  }
}

const RETRY_REGEX = /^!balrog\s+retry\s*$/im
const RETRY_FORCE_REGEX = /^!balrog\s+retry\s+--force\s*$/im

const EXHAUSTED_MESSAGE_EN = (author: string, max: number) =>
  `## 🔥 You shall not pass — attempts exhausted

@${author} You have used all **${max}** attempt(s) without passing the quiz.

**To get a fresh quiz, you have two options:**
- **Push a new commit** to your branch (even a small fix or a \`git commit --allow-empty\`) — the quiz will regenerate automatically.
- **Type \`!balrog retry\`** in this PR to request a new quiz immediately without pushing code.`

const RETRY_TRIGGERED_EN = (author: string) =>
  `🔄 @${author} Regenerating your quiz… A new quiz will be posted shortly.`

const FORCE_RETRY_TRIGGERED_EN = (admin: string, author: string) =>
  `🔄 @${admin} triggered a forced quiz reset for @${author}. A new quiz will be posted shortly.`

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const language = core.getInput('language') || 'auto'
  const quizResponder = core.getInput('quiz-responder') || 'author'

  const octokit = github.getOctokit(token)
  const { payload, repo } = github.context

  const comment = payload.comment
  const issue = payload.issue

  if (!comment || !issue) {
    core.info('Not a comment event, skipping')
    return
  }

  if (!(issue as { pull_request?: unknown }).pull_request) {
    core.info('Comment is not on a pull request, skipping')
    return
  }

  const prNumber = issue.number as number
  const commenterLogin = (comment.user as { login: string }).login
  const commentBody = comment.body as string

  core.info(`Comment on PR #${prNumber} by @${commenterLogin}`)

  // Verify the commenter is the PR author before doing anything
  const prData = await octokit.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
  })

  const ctx = {
    owner: repo.owner,
    repo: repo.repo,
    prNumber,
    headSha: prData.data.head.sha,
    authorLogin: prData.data.user?.login ?? '',
  }

  // ---------------------------------------------------------------------------
  // !balrog retry --force — admin override, bypasses author check and attempt limit
  // ---------------------------------------------------------------------------
  if (RETRY_FORCE_REGEX.test(commentBody)) {
    const permResponse = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: repo.owner,
      repo: repo.repo,
      username: commenterLogin,
    })
    const permission = permResponse.data.permission
    if (permission !== 'admin') {
      core.info(`@${commenterLogin} tried --force but has permission '${permission}', not admin`)
      await postComment(octokit, ctx,
        `⛔ @${commenterLogin} \`!balrog retry --force\` is reserved for repository admins.`)
      return
    }

    core.info(`Admin @${commenterLogin} force-retrying quiz for PR #${prNumber}`)
    await postComment(octokit, ctx, FORCE_RETRY_TRIGGERED_EN(commenterLogin, ctx.authorLogin))

    await octokit.rest.actions.createWorkflowDispatch({
      owner: repo.owner,
      repo: repo.repo,
      workflow_id: 'quiz-generate.yml',
      ref: prData.data.head.ref,
      inputs: { pr_number: String(prNumber) },
    })

    core.info(`Force-dispatched quiz-generate.yml for PR #${prNumber}`)
    return
  }

  const allowed = await isAllowedResponder(
    octokit, repo.owner, repo.repo, prNumber,
    commenterLogin, ctx.authorLogin, quizResponder,
  )
  if (!allowed) {
    core.info(`@${commenterLogin} is not allowed to respond (policy: ${quizResponder}), skipping`)
    return
  }

  // ---------------------------------------------------------------------------
  // !balrog retry — regenerate quiz via workflow_dispatch
  // ---------------------------------------------------------------------------
  if (RETRY_REGEX.test(commentBody)) {
    // Load quiz to check if they still have attempts left
    const quizForRetry = await loadQuizArtifact(prNumber, octokit, repo.owner, repo.repo, token)
    if (quizForRetry && quizForRetry.maxAttempts > 0 && quizForRetry.attemptsUsed < quizForRetry.maxAttempts) {
      const left = quizForRetry.maxAttempts - quizForRetry.attemptsUsed
      await postComment(octokit, ctx,
        `⚠️ @${commenterLogin} You still have **${left}** attempt(s) remaining — use them before requesting a retry.`)
      return
    }

    core.info(`@${commenterLogin} requested a retry`)
    await postComment(octokit, ctx, RETRY_TRIGGERED_EN(commenterLogin))

    // Trigger the generate workflow via workflow_dispatch
    await octokit.rest.actions.createWorkflowDispatch({
      owner: repo.owner,
      repo: repo.repo,
      workflow_id: 'quiz-generate.yml',
      ref: prData.data.head.ref,
      inputs: { pr_number: String(prNumber) },
    })

    core.info(`Dispatched quiz-generate.yml for PR #${prNumber} on ref ${prData.data.head.ref}`)
    return
  }

  // ---------------------------------------------------------------------------
  // !balrog <answers> — evaluate answers
  // ---------------------------------------------------------------------------
  const answers = parseAnswerComment(commentBody)
  if (!answers) {
    core.info('Comment does not contain a !balrog command, skipping')
    return
  }

  core.info(`Parsed answers: ${JSON.stringify(answers)}`)

  const quiz = await loadQuizArtifact(prNumber, octokit, repo.owner, repo.repo, token)
  if (!quiz) {
    core.warning(`No quiz found for PR #${prNumber}. Was the generate workflow run?`)
    await postComment(octokit, ctx,
      '⚠️ No quiz found for this PR. Type `!balrog retry` or push a new commit to regenerate it.')
    return
  }

  // Check attempt limits — inform and stop, don't silently ignore
  if (quiz.maxAttempts > 0 && quiz.attemptsUsed >= quiz.maxAttempts) {
    await postComment(octokit, ctx, EXHAUSTED_MESSAGE_EN(commenterLogin, quiz.maxAttempts))
    return
  }

  // Evaluate
  const result = evaluateQuiz(quiz, answers)
  const updatedQuiz = { ...quiz, attemptsUsed: quiz.attemptsUsed + 1, passed: result.passed }
  await saveQuizArtifact(updatedQuiz)

  const lang = language === 'auto' ? detectLanguage(quiz) : language
  const resultBody = renderResultComment({ ...result, quiz: updatedQuiz }, lang)
  await postComment(octokit, ctx, resultBody)

  const checkId = await findExistingCheck(octokit, ctx)
  if (!checkId) {
    core.warning('No existing check found — was quiz-generate run? Cannot update merge gate.')
    return
  }

  const attemptsLeft = quiz.maxAttempts === 0
    ? Infinity
    : quiz.maxAttempts - updatedQuiz.attemptsUsed

  if (result.passed) {
    await updateCheckSuccess(octokit, ctx, checkId, result.score)
    core.info(`Quiz PASSED — ${result.score}% — merge unblocked`)
  } else {
    await updateCheckFailure(octokit, ctx, checkId, result.score, attemptsLeft === Infinity ? -1 : attemptsLeft)
    core.info(`Quiz FAILED — ${result.score}% — ${attemptsLeft} attempts left`)
  }

  core.setOutput('score', String(result.score))
  core.setOutput('passed', String(result.passed))
  core.setOutput('attempts-used', String(updatedQuiz.attemptsUsed))
}

function detectLanguage(quiz: { questions: { text: string }[] }): string {
  const sample = quiz.questions[0]?.text ?? ''
  const frenchWords = /\b(pourquoi|comment|quel|quelle|quels|quelles|est-ce|cette|dans|avec)\b/i
  return frenchWords.test(sample) ? 'fr' : 'en'
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
