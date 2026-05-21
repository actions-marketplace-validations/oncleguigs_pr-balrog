"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const quiz_1 = require("./quiz");
const github_1 = require("./github");
async function isAllowedResponder(octokit, owner, repo, prNumber, commenterLogin, authorLogin, policy) {
    if (commenterLogin === authorLogin)
        return true;
    switch (policy) {
        case 'author':
            return false;
        case 'reviewer': {
            const { data: requested } = await octokit.rest.pulls.listRequestedReviewers({
                owner, repo, pull_number: prNumber,
            });
            if (requested.users.some((u) => u.login === commenterLogin))
                return true;
            const { data: reviews } = await octokit.rest.pulls.listReviews({
                owner, repo, pull_number: prNumber,
            });
            return reviews.some((r) => r.user?.login === commenterLogin);
        }
        case 'collaborator': {
            try {
                const { data: perm } = await octokit.rest.repos.getCollaboratorPermissionLevel({
                    owner, repo, username: commenterLogin,
                });
                return ['write', 'maintain', 'admin'].includes(perm.permission);
            }
            catch {
                return false;
            }
        }
        case 'any':
            return true;
        default:
            core.warning(`Unknown quiz-responder policy '${policy}', defaulting to 'author'`);
            return false;
    }
}
const RETRY_REGEX = /^!balrog\s+retry\s*$/im;
const RETRY_FORCE_REGEX = /^!balrog\s+retry\s+--force\s*$/im;
const EXHAUSTED_MESSAGE_EN = (author, max) => `## 🔥 You shall not pass — attempts exhausted

@${author} You have used all **${max}** attempt(s) without passing the quiz.

**To get a fresh quiz, you have two options:**
- **Push a new commit** to your branch (even a small fix or a \`git commit --allow-empty\`) — the quiz will regenerate automatically.
- **Type \`!balrog retry\`** in this PR to request a new quiz immediately without pushing code.`;
const RETRY_TRIGGERED_EN = (author) => `🔄 @${author} Regenerating your quiz… A new quiz will be posted shortly.`;
const FORCE_RETRY_TRIGGERED_EN = (admin, author) => `🔄 @${admin} triggered a forced quiz reset for @${author}. A new quiz will be posted shortly.`;
async function run() {
    const token = core.getInput('github-token', { required: true });
    const language = core.getInput('language') || 'auto';
    const quizResponder = core.getInput('quiz-responder') || 'author';
    const octokit = github.getOctokit(token);
    const { payload, repo } = github.context;
    const comment = payload.comment;
    const issue = payload.issue;
    const eventName = github.context.eventName;
    const eventAction = payload.action;
    if (!comment || !issue) {
        core.info('Not a comment event, skipping');
        return;
    }
    if (!issue.pull_request) {
        core.info('Comment is not on a pull request, skipping');
        return;
    }
    const prNumber = issue.number;
    // For 'edited' events the actor is payload.sender, not comment.user (which is the original poster)
    const commenterLogin = eventAction === 'edited'
        ? (payload.sender?.login ?? comment.user.login)
        : comment.user.login;
    const commentBody = comment.body;
    core.info(`Comment on PR #${prNumber} by @${commenterLogin} (action: ${eventAction})`);
    // Verify the commenter is the PR author before doing anything
    const prData = await octokit.rest.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
    });
    const ctx = {
        owner: repo.owner,
        repo: repo.repo,
        prNumber,
        headSha: prData.data.head.sha,
        authorLogin: prData.data.user?.login ?? '',
    };
    // ---------------------------------------------------------------------------
    // !balrog retry --force — admin override, bypasses author check and attempt limit
    // ---------------------------------------------------------------------------
    if (RETRY_FORCE_REGEX.test(commentBody)) {
        const permResponse = await octokit.rest.repos.getCollaboratorPermissionLevel({
            owner: repo.owner,
            repo: repo.repo,
            username: commenterLogin,
        });
        const permission = permResponse.data.permission;
        if (permission !== 'admin') {
            core.info(`@${commenterLogin} tried --force but has permission '${permission}', not admin`);
            await (0, github_1.postComment)(octokit, ctx, `⛔ @${commenterLogin} \`!balrog retry --force\` is reserved for repository admins.`);
            return;
        }
        core.info(`Admin @${commenterLogin} force-retrying quiz for PR #${prNumber}`);
        await (0, github_1.postComment)(octokit, ctx, FORCE_RETRY_TRIGGERED_EN(commenterLogin, ctx.authorLogin));
        await octokit.rest.actions.createWorkflowDispatch({
            owner: repo.owner,
            repo: repo.repo,
            workflow_id: 'quiz-generate.yml',
            ref: prData.data.head.ref,
            inputs: { pr_number: String(prNumber) },
        });
        core.info(`Force-dispatched quiz-generate.yml for PR #${prNumber}`);
        return;
    }
    const allowed = await isAllowedResponder(octokit, repo.owner, repo.repo, prNumber, commenterLogin, ctx.authorLogin, quizResponder);
    if (!allowed) {
        core.info(`@${commenterLogin} is not allowed to respond (policy: ${quizResponder}), skipping`);
        return;
    }
    // ---------------------------------------------------------------------------
    // !balrog retry — regenerate quiz via workflow_dispatch
    // ---------------------------------------------------------------------------
    if (RETRY_REGEX.test(commentBody)) {
        // Load quiz to check if they still have attempts left
        const quizForRetry = await (0, github_1.loadQuizArtifact)(prNumber, octokit, repo.owner, repo.repo, token);
        if (quizForRetry && quizForRetry.maxAttempts > 0 && quizForRetry.attemptsUsed < quizForRetry.maxAttempts) {
            const left = quizForRetry.maxAttempts - quizForRetry.attemptsUsed;
            await (0, github_1.postComment)(octokit, ctx, `⚠️ @${commenterLogin} You still have **${left}** attempt(s) remaining — use them before requesting a retry.`);
            return;
        }
        core.info(`@${commenterLogin} requested a retry`);
        await (0, github_1.postComment)(octokit, ctx, RETRY_TRIGGERED_EN(commenterLogin));
        // Trigger the generate workflow via workflow_dispatch
        await octokit.rest.actions.createWorkflowDispatch({
            owner: repo.owner,
            repo: repo.repo,
            workflow_id: 'quiz-generate.yml',
            ref: prData.data.head.ref,
            inputs: { pr_number: String(prNumber) },
        });
        core.info(`Dispatched quiz-generate.yml for PR #${prNumber} on ref ${prData.data.head.ref}`);
        return;
    }
    // ---------------------------------------------------------------------------
    // Checkbox mode — edited event from the quiz comment itself
    // ---------------------------------------------------------------------------
    if (eventAction === 'edited') {
        // Only handle edits to the quiz comment (identified by the hidden marker)
        if (!commentBody.includes('<!-- balrog-mode: checkbox -->')) {
            core.info('Edited comment is not an active checkbox quiz, skipping');
            return;
        }
        // Verify editor is the PR author
        if (commenterLogin !== ctx.authorLogin) {
            core.info(`Checkbox edit from @${commenterLogin}, not PR author @${ctx.authorLogin}, skipping`);
            return;
        }
        const checkboxAnswers = (0, quiz_1.parseCheckboxAnswers)(commentBody);
        if (!checkboxAnswers) {
            core.info('Submit checkbox not checked yet, skipping');
            return;
        }
        await handleEvaluation(checkboxAnswers, prNumber, comment.id, true);
        return;
    }
    // ---------------------------------------------------------------------------
    // !balrog <answers> — evaluate answers (command mode)
    // ---------------------------------------------------------------------------
    const answers = (0, quiz_1.parseAnswerComment)(commentBody);
    if (!answers) {
        core.info('Comment does not contain a !balrog command, skipping');
        return;
    }
    core.info(`Parsed answers: ${JSON.stringify(answers)}`);
    await handleEvaluation(answers, prNumber, null, false);
    // ---------------------------------------------------------------------------
    // Shared evaluation logic
    // ---------------------------------------------------------------------------
    async function handleEvaluation(submittedAnswers, prNum, quizCommentId, isCheckbox) {
        const quiz = await (0, github_1.loadQuizArtifact)(prNum, octokit, repo.owner, repo.repo, token);
        if (!quiz) {
            core.warning(`No quiz found for PR #${prNum}. Was the generate workflow run?`);
            await (0, github_1.postComment)(octokit, ctx, '⚠️ No quiz found for this PR. Type `!balrog retry` or push a new commit to regenerate it.');
            return;
        }
        if (quiz.maxAttempts > 0 && quiz.attemptsUsed >= quiz.maxAttempts) {
            await (0, github_1.postComment)(octokit, ctx, EXHAUSTED_MESSAGE_EN(commenterLogin, quiz.maxAttempts));
            return;
        }
        const lang = language === 'auto' ? detectLanguage(quiz) : language;
        // Show fighting banner on quiz comment while evaluation runs
        const fightingCommentId = isCheckbox
            ? (quizCommentId ?? await (0, github_1.findQuizComment)(octokit, ctx, quiz.id))
            : await (0, github_1.findQuizComment)(octokit, ctx, quiz.id);
        if (fightingCommentId) {
            try {
                const banner = (0, quiz_1.renderFightingBanner)(lang);
                let bannerBody;
                if (isCheckbox) {
                    // Change mode marker to prevent a re-trigger from this edit.
                    // GITHUB_TOKEN edits don't fire workflow events by default, but this
                    // guards against PAT-based setups where they would.
                    bannerBody = banner + (0, quiz_1.renderQuizCommentCheckbox)(quiz, lang, submittedAnswers)
                        .replace('<!-- balrog-mode: checkbox -->', '<!-- balrog-mode: checkbox-evaluating -->');
                }
                else {
                    bannerBody = banner + (0, quiz_1.renderQuizComment)(quiz, lang);
                }
                await (0, github_1.updateComment)(octokit, ctx, fightingCommentId, bannerBody);
            }
            catch (e) {
                core.info(`Could not update quiz comment with fighting banner: ${e}`);
            }
        }
        const result = (0, quiz_1.evaluateQuiz)(quiz, submittedAnswers);
        const updatedQuiz = {
            ...quiz,
            attemptsUsed: quiz.attemptsUsed + 1,
            passed: result.passed,
            attempts: [...(quiz.attempts ?? []), { n: quiz.attemptsUsed + 1, answers: submittedAnswers, score: result.score }],
        };
        await (0, github_1.saveQuizArtifact)(updatedQuiz);
        const resultBody = (0, quiz_1.renderResultComment)({ ...result, quiz: updatedQuiz }, lang);
        const existingResultId = await (0, github_1.findAnyBalrogComment)(octokit, ctx);
        if (existingResultId) {
            await (0, github_1.updateComment)(octokit, ctx, existingResultId, resultBody);
            core.info(`Updated result comment #${existingResultId}`);
        }
        else {
            await (0, github_1.postComment)(octokit, ctx, resultBody);
        }
        // Update the quiz comment: reset checkboxes for next attempt, or lock when done
        if (isCheckbox) {
            const targetCommentId = quizCommentId ?? await (0, github_1.findQuizComment)(octokit, ctx, quiz.id);
            if (targetCommentId) {
                const attemptsExhausted = updatedQuiz.maxAttempts > 0 && updatedQuiz.attemptsUsed >= updatedQuiz.maxAttempts;
                if (result.passed || attemptsExhausted) {
                    const locked = (0, quiz_1.renderLockedQuizComment)(updatedQuiz, lang);
                    await (0, github_1.updateComment)(octokit, ctx, targetCommentId, locked);
                    core.info(`Locked quiz comment #${targetCommentId}`);
                }
                else {
                    const reset = (0, quiz_1.renderQuizCommentCheckbox)(updatedQuiz, lang, submittedAnswers);
                    await (0, github_1.updateComment)(octokit, ctx, targetCommentId, reset);
                    core.info(`Reset quiz comment #${targetCommentId} for next attempt`);
                }
            }
        }
        const checkId = await (0, github_1.findExistingCheck)(octokit, ctx);
        if (!checkId) {
            core.warning('No existing check found — was quiz-generate run? Cannot update merge gate.');
            return;
        }
        const attemptsLeft = quiz.maxAttempts === 0
            ? Infinity
            : quiz.maxAttempts - updatedQuiz.attemptsUsed;
        if (result.passed) {
            await (0, github_1.updateCheckSuccess)(octokit, ctx, checkId, result.score);
            core.info(`Quiz PASSED — ${result.score}% — merge unblocked`);
        }
        else {
            await (0, github_1.updateCheckFailure)(octokit, ctx, checkId, result.score, attemptsLeft === Infinity ? -1 : attemptsLeft);
            core.info(`Quiz FAILED — ${result.score}% — ${attemptsLeft} attempts left`);
        }
        core.setOutput('score', String(result.score));
        core.setOutput('passed', String(result.passed));
        core.setOutput('attempts-used', String(updatedQuiz.attemptsUsed));
    }
}
function detectLanguage(quiz) {
    const sample = quiz.questions[0]?.text ?? '';
    const frenchWords = /\b(pourquoi|comment|quel|quelle|quels|quelles|est-ce|cette|dans|avec)\b/i;
    return frenchWords.test(sample) ? 'fr' : 'en';
}
run().catch((err) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
});
//# sourceMappingURL=evaluate.js.map