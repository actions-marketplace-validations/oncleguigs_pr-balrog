import * as core from '@actions/core'
import * as github from '@actions/github'
import { parseAnswerComment, parseCheckboxAnswers, parseRetryCheckbox, evaluateQuiz, renderResultComment, renderLockedQuizComment, renderQuizCommentCheckbox, renderQuizComment, renderFightingBanner, renderUpdatedAt, renderRegeneratingComment } from './quiz'
import {
  loadQuizArtifact,
  saveQuizArtifact,
  postComment,
  updateComment,
  findExistingCheck,
  findQuizComment,
  findAnyBalrogComment,
  findResultComment,
  updateCheckSuccess,
  updateCheckFailure,
} from './github'
import type { SubmittedAnswers } from './types'

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
  const eventName = github.context.eventName
  const eventAction = payload.action as string | undefined

  if (!comment || !issue) {
    core.info('Not a comment event, skipping')
    return
  }

  if (!(issue as { pull_request?: unknown }).pull_request) {
    core.info('Comment is not on a pull request, skipping')
    return
  }

  const prNumber = issue.number as number
  // For 'edited' events the actor is payload.sender, not comment.user (which is the original poster)
  const commenterLogin = eventAction === 'edited'
    ? ((payload.sender as { login: string } | undefined)?.login ?? (comment.user as { login: string }).login)
    : (comment.user as { login: string }).login
  const commentBody = comment.body as string

  core.info(`Comment on PR #${prNumber} by @${commenterLogin} (action: ${eventAction})`)

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
    await handleRetryDispatch()
    return
  }

  // ---------------------------------------------------------------------------
  // Checkbox mode — edited event from the quiz comment itself
  // ---------------------------------------------------------------------------
  if (eventAction === 'edited') {
    const isActiveCheckbox = commentBody.includes('<!-- balrog-mode: checkbox -->')
    const isLockedCheckbox = commentBody.includes('<!-- balrog-mode: checkbox-locked -->')
    if (!isActiveCheckbox && !isLockedCheckbox) {
      core.info('Edited comment is not a checkbox quiz, skipping')
      return
    }

    // Verify editor is the PR author
    if (commenterLogin !== ctx.authorLogin) {
      core.info(`Checkbox edit from @${commenterLogin}, not PR author @${ctx.authorLogin}, skipping`)
      return
    }

    // Retry wins over submit when both are checked
    if (parseRetryCheckbox(commentBody)) {
      await handleRetryDispatch()
      return
    }

    if (isActiveCheckbox) {
      const checkboxAnswers = parseCheckboxAnswers(commentBody)
      if (!checkboxAnswers) {
        core.info('Submit checkbox not checked yet, skipping')
        return
      }
      await handleEvaluation(checkboxAnswers, prNumber, comment.id as number, true)
    }
    return
  }

  // ---------------------------------------------------------------------------
  // !balrog <answers> — evaluate answers (command mode)
  // ---------------------------------------------------------------------------
  const answers = parseAnswerComment(commentBody)
  if (!answers) {
    core.info('Comment does not contain a !balrog command, skipping')
    return
  }

  core.info(`Parsed answers: ${JSON.stringify(answers)}`)
  await handleEvaluation(answers, prNumber, null, false)

  // ---------------------------------------------------------------------------
  // Shared retry dispatch logic
  // ---------------------------------------------------------------------------
  async function handleRetryDispatch(): Promise<void> {
    const quizForRetry = await loadQuizArtifact(prNumber, octokit, repo.owner, repo.repo, token)
    if (quizForRetry && quizForRetry.maxAttempts > 0 && quizForRetry.attemptsUsed < quizForRetry.maxAttempts) {
      const left = quizForRetry.maxAttempts - quizForRetry.attemptsUsed
      await postComment(octokit, ctx,
        `⚠️ @${commenterLogin} You still have **${left}** attempt(s) remaining — use them before requesting a retry.`)

      // Checkbox mode: re-render quiz comment clearing the retry checkbox but preserving answer selections
      if (eventAction === 'edited' && quizForRetry) {
        const lang = language === 'auto' ? detectLanguage(quizForRetry) : language
        const currentSelections: SubmittedAnswers = {}
        const lineRegex = /- \[(x| )\] \*\*Q(\d+)([ABC])\)\*\*/gi
        let m: RegExpExecArray | null
        while ((m = lineRegex.exec(commentBody)) !== null) {
          const checked = m[1].toLowerCase() === 'x'
          const qNum = m[2]
          const letter = m[3].toUpperCase() as 'A' | 'B' | 'C'
          if (!currentSelections[qNum]) currentSelections[qNum] = []
          if (checked) currentSelections[qNum].push(letter)
        }
        for (const k of Object.keys(currentSelections)) {
          if (currentSelections[k].length === 0) delete currentSelections[k]
        }
        const reset = renderQuizCommentCheckbox(quizForRetry, lang, currentSelections)
        await updateComment(octokit, ctx, comment!.id as number, reset + '\n\n' + renderUpdatedAt(new Date(), lang))
      }
      return
    }

    core.info(`@${commenterLogin} requested a retry`)

    // Checkbox mode: update the quiz comment with a regenerating banner (generate.ts will replace it)
    if (eventAction === 'edited' && quizForRetry) {
      const lang = language === 'auto' ? detectLanguage(quizForRetry) : language
      const banner = renderRegeneratingComment(quizForRetry, lang)
      await updateComment(octokit, ctx, comment!.id as number, banner + '\n\n' + renderUpdatedAt(new Date(), lang))
    } else {
      await postComment(octokit, ctx, RETRY_TRIGGERED_EN(commenterLogin))
    }

    await octokit.rest.actions.createWorkflowDispatch({
      owner: repo.owner,
      repo: repo.repo,
      workflow_id: 'quiz-generate.yml',
      ref: prData.data.head.ref,
      inputs: { pr_number: String(prNumber) },
    })

    core.info(`Dispatched quiz-generate.yml for PR #${prNumber} on ref ${prData.data.head.ref}`)
  }

  // ---------------------------------------------------------------------------
  // Shared evaluation logic
  // ---------------------------------------------------------------------------
  async function handleEvaluation(
    submittedAnswers: SubmittedAnswers,
    prNum: number,
    quizCommentId: number | null,
    isCheckbox: boolean,
  ): Promise<void> {
    const quiz = await loadQuizArtifact(prNum, octokit, repo.owner, repo.repo, token)
    if (!quiz) {
      core.warning(`No quiz found for PR #${prNum}. Was the generate workflow run?`)
      await postComment(octokit, ctx,
        '⚠️ No quiz found for this PR. Type `!balrog retry` or push a new commit to regenerate it.')
      return
    }

    if (quiz.maxAttempts > 0 && quiz.attemptsUsed >= quiz.maxAttempts) {
      await postComment(octokit, ctx, EXHAUSTED_MESSAGE_EN(commenterLogin, quiz.maxAttempts))
      return
    }

    const lang = language === 'auto' ? detectLanguage(quiz) : language
    const withFooter = (body: string) => body + '\n\n' + renderUpdatedAt(new Date(), lang)

    // Show fighting banner on quiz comment while evaluation runs
    const fightingCommentId = isCheckbox
      ? (quizCommentId ?? await findQuizComment(octokit, ctx, quiz.id))
      : await findQuizComment(octokit, ctx, quiz.id)
    if (fightingCommentId) {
      try {
        const banner = renderFightingBanner(lang)
        let bannerBody: string
        if (isCheckbox) {
          // Change mode marker to prevent a re-trigger from this edit.
          // GITHUB_TOKEN edits don't fire workflow events by default, but this
          // guards against PAT-based setups where they would.
          bannerBody = banner + renderQuizCommentCheckbox(quiz, lang, submittedAnswers)
            .replace('<!-- balrog-mode: checkbox -->', '<!-- balrog-mode: checkbox-evaluating -->')
        } else {
          bannerBody = banner + renderQuizComment(quiz, lang)
        }
        await updateComment(octokit, ctx, fightingCommentId, withFooter(bannerBody))
      } catch (e) {
        core.info(`Could not update quiz comment with fighting banner: ${e}`)
      }
    }

    const result = evaluateQuiz(quiz, submittedAnswers)
    const updatedQuiz = {
      ...quiz,
      attemptsUsed: quiz.attemptsUsed + 1,
      passed: result.passed,
      attempts: [...(quiz.attempts ?? []), { n: quiz.attemptsUsed + 1, answers: submittedAnswers, score: result.score }],
    }
    await saveQuizArtifact(updatedQuiz)

    const resultBody = renderResultComment({ ...result, quiz: updatedQuiz }, lang)
    const existingResultId = await findResultComment(octokit, ctx)
    if (existingResultId) {
      await updateComment(octokit, ctx, existingResultId, withFooter(resultBody))
      core.info(`Updated result comment #${existingResultId}`)
    } else {
      await postComment(octokit, ctx, resultBody)
    }

    // Update the quiz comment: reset checkboxes for next attempt, or lock when done
    if (isCheckbox) {
      const targetCommentId = quizCommentId ?? await findQuizComment(octokit, ctx, quiz.id)
      if (targetCommentId) {
        const attemptsExhausted = updatedQuiz.maxAttempts > 0 && updatedQuiz.attemptsUsed >= updatedQuiz.maxAttempts
        if (result.passed || attemptsExhausted) {
          const locked = renderLockedQuizComment(updatedQuiz, lang)
          await updateComment(octokit, ctx, targetCommentId, withFooter(locked))
          core.info(`Locked quiz comment #${targetCommentId}`)
        } else {
          const reset = renderQuizCommentCheckbox(updatedQuiz, lang, submittedAnswers)
          await updateComment(octokit, ctx, targetCommentId, withFooter(reset))
          core.info(`Reset quiz comment #${targetCommentId} for next attempt`)
        }
      }
    }

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
}

function detectLanguage(quiz: { questions: { text: string }[] }): string {
  const sample = quiz.questions[0]?.text ?? ''
  const frenchWords = /\b(pourquoi|comment|quel|quelle|quels|quelles|est-ce|cette|dans|avec)\b/i
  return frenchWords.test(sample) ? 'fr' : 'en'
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
