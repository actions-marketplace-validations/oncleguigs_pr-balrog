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
const providers_1 = require("./providers");
async function run() {
    const token = core.getInput('github-token', { required: true });
    const provider = core.getInput('ai-provider');
    const apiKey = core.getInput('api-key') || token; // github-models falls back to GITHUB_TOKEN
    const model = core.getInput('model') || undefined;
    const passThreshold = parseInt(core.getInput('pass-threshold') || '80', 10);
    const maxAttempts = parseInt(core.getInput('max-attempts') || '3', 10);
    const quizSizeOverride = core.getInput('quiz-size') || 'auto';
    const minLines = parseInt(core.getInput('min-lines-threshold') || '10', 10);
    const excludeRaw = core.getInput('exclude-patterns') || '*.lock,*.min.js,*-lock.json,*.snap';
    const language = core.getInput('language') || 'auto';
    const additionalPrompt = core.getInput('additional-prompt') || undefined;
    const answerMode = (core.getInput('answer-mode') || 'command');
    const excludePatterns = excludeRaw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    const prNumberOverride = core.getInput('pr-number-override') || '';
    const octokit = github.getOctokit(token);
    const { payload, repo } = github.context;
    const eventName = github.context.eventName;
    // Support workflow_dispatch (!balrog retry) — look up the PR via the API
    let ctx;
    if (eventName === 'workflow_dispatch' || prNumberOverride) {
        const prNumber = parseInt(prNumberOverride || String(payload.inputs?.pr_number), 10);
        if (!prNumber) {
            core.setFailed('pr-number-override is required for workflow_dispatch events');
            return;
        }
        core.info(`Triggered via workflow_dispatch for PR #${prNumber}`);
        const { data: prData } = await octokit.rest.pulls.get({
            owner: repo.owner,
            repo: repo.repo,
            pull_number: prNumber,
        });
        ctx = {
            owner: repo.owner,
            repo: repo.repo,
            prNumber,
            headSha: prData.head.sha,
            authorLogin: prData.user?.login ?? '',
        };
    }
    else {
        const pr = payload.pull_request;
        if (!pr) {
            core.setFailed('This action must be triggered by a pull_request or workflow_dispatch event');
            return;
        }
        ctx = {
            owner: repo.owner,
            repo: repo.repo,
            prNumber: pr.number,
            headSha: pr.head.sha,
            authorLogin: pr.user.login,
        };
    }
    core.info(`PR #${ctx.prNumber} by @${ctx.authorLogin} — head: ${ctx.headSha}`);
    // Skip PRs from external forks (they don't have write access to create checks)
    const prPayload = payload.pull_request;
    const headRepoFullName = prPayload
        ? prPayload.head.repo?.full_name
        : null;
    if (headRepoFullName && headRepoFullName !== `${repo.owner}/${repo.repo}`) {
        core.info('Skipping: external fork PR — quiz not required for external contributors');
        return;
    }
    // Fetch and filter diff
    const { diff, changedLines } = await (0, github_1.fetchFilteredDiff)(octokit, ctx, excludePatterns);
    core.info(`Changed lines after filtering: ${changedLines}`);
    if (changedLines < minLines) {
        core.info(`Skipping: only ${changedLines} lines changed (min: ${minLines})`);
        return;
    }
    // Determine quiz size
    const numQuestions = (0, quiz_1.pickQuizSize)(changedLines, quizSizeOverride);
    core.info(`Generating ${numQuestions}-question quiz via ${provider}`);
    // Generate quiz
    const adapter = (0, providers_1.createProvider)(provider, apiKey, model);
    const questions = await adapter.generateQuiz({ diff, numQuestions, language, additionalPrompt });
    // Persist quiz + correct answers as artifact (author can't see this)
    const quiz = (0, quiz_1.buildQuiz)(questions, ctx.prNumber, ctx.headSha, passThreshold, maxAttempts, answerMode);
    await (0, github_1.saveQuizArtifact)(quiz);
    // Post or update quiz comment (without correct answers)
    const lang = language === 'auto' ? 'en' : language;
    const commentBody = answerMode === 'checkbox'
        ? (0, quiz_1.renderQuizCommentCheckbox)(quiz, lang)
        : (0, quiz_1.renderQuizComment)(quiz, lang);
    const existingCommentId = await (0, github_1.findAnyBalrogComment)(octokit, ctx);
    let commentId;
    if (existingCommentId) {
        await (0, github_1.updateComment)(octokit, ctx, existingCommentId, commentBody);
        commentId = existingCommentId;
        core.info(`Updated existing quiz comment #${commentId} (mode: ${answerMode})`);
    }
    else {
        commentId = await (0, github_1.postComment)(octokit, ctx, commentBody);
        core.info(`Posted new quiz comment #${commentId} (mode: ${answerMode})`);
    }
    // Create pending check — this is what blocks the merge
    const checkId = await (0, github_1.createPendingCheck)(octokit, ctx);
    core.info(`Created pending check #${checkId}`);
    core.setOutput('quiz-id', quiz.id);
    core.setOutput('check-id', String(checkId));
    core.setOutput('comment-id', String(commentId));
    core.setOutput('num-questions', String(numQuestions));
}
run().catch((err) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
});
//# sourceMappingURL=generate.js.map