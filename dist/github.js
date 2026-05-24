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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ARTIFACT_PREFIX = exports.CHECK_NAME = void 0;
exports.fetchPRDiff = fetchPRDiff;
exports.fetchFilteredDiff = fetchFilteredDiff;
exports.createPendingCheck = createPendingCheck;
exports.updateCheckSuccess = updateCheckSuccess;
exports.updateCheckFailure = updateCheckFailure;
exports.findExistingCheck = findExistingCheck;
exports.postComment = postComment;
exports.updateComment = updateComment;
exports.findQuizComment = findQuizComment;
exports.findAnyBalrogComment = findAnyBalrogComment;
exports.findResultComment = findResultComment;
exports.saveQuizArtifact = saveQuizArtifact;
exports.loadQuizArtifact = loadQuizArtifact;
const core = __importStar(require("@actions/core"));
const artifact_1 = require("@actions/artifact");
const adm_zip_1 = __importDefault(require("adm-zip"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
exports.CHECK_NAME = 'PR Balrog';
exports.ARTIFACT_PREFIX = 'balrog-quiz-';
// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------
async function fetchPRDiff(octokit, ctx) {
    const { data } = await octokit.rest.pulls.get({
        owner: ctx.owner,
        repo: ctx.repo,
        pull_number: ctx.prNumber,
        mediaType: { format: 'diff' },
    });
    const diff = data;
    const additions = (diff.match(/^\+[^+]/gm) ?? []).length;
    const deletions = (diff.match(/^-[^-]/gm) ?? []).length;
    return { diff, changedLines: additions + deletions };
}
async function fetchFilteredDiff(octokit, ctx, excludePatterns) {
    const { diff, changedLines } = await fetchPRDiff(octokit, ctx);
    if (excludePatterns.length === 0)
        return { diff, changedLines };
    const regexes = excludePatterns.map((p) => new RegExp(p.replace(/\./g, '\\.').replace(/\*/g, '.*')));
    // split diff by file section and filter out excluded files
    const sections = diff.split(/(?=^diff --git )/m);
    const filtered = sections.filter((section) => {
        const fileMatch = section.match(/^diff --git a\/(.*?) b\//);
        if (!fileMatch)
            return true;
        return !regexes.some((r) => r.test(fileMatch[1]));
    });
    const filteredDiff = filtered.join('');
    const filtAdditions = (filteredDiff.match(/^\+[^+]/gm) ?? []).length;
    const filtDeletions = (filteredDiff.match(/^-[^-]/gm) ?? []).length;
    return { diff: filteredDiff, changedLines: filtAdditions + filtDeletions };
}
// ---------------------------------------------------------------------------
// Checks API
// ---------------------------------------------------------------------------
async function createPendingCheck(octokit, ctx) {
    core.info(`Creating pending check for ${ctx.headSha}`);
    const { data } = await octokit.rest.checks.create({
        owner: ctx.owner,
        repo: ctx.repo,
        name: exports.CHECK_NAME,
        head_sha: ctx.headSha,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        output: {
            title: 'Quiz required',
            summary: 'Answer the PR Balrog quiz in the pull request comment to unlock merge.',
        },
    });
    return data.id;
}
async function updateCheckSuccess(octokit, ctx, checkId, score) {
    core.info(`Marking check ${checkId} as success (score: ${score}%)`);
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
    });
}
async function updateCheckFailure(octokit, ctx, checkId, score, attemptsLeft) {
    const exhausted = attemptsLeft === 0;
    core.info(`Marking check ${checkId} as ${exhausted ? 'failure' : 'in_progress'} (score: ${score}%)`);
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
        });
    }
    else {
        await octokit.rest.checks.update({
            owner: ctx.owner,
            repo: ctx.repo,
            check_run_id: checkId,
            status: 'in_progress',
            output: {
                title: `Quiz failed — ${score}% — ${attemptsLeft} attempt(s) left`,
                summary: `Score below threshold. ${attemptsLeft} attempt(s) remaining.`,
            },
        });
    }
}
async function findExistingCheck(octokit, ctx) {
    const { data } = await octokit.rest.checks.listForRef({
        owner: ctx.owner,
        repo: ctx.repo,
        ref: ctx.headSha,
        check_name: exports.CHECK_NAME,
    });
    if (data.total_count === 0)
        return null;
    // return the most recent one
    const sorted = [...data.check_runs].sort((a, b) => new Date(b.started_at ?? 0).getTime() - new Date(a.started_at ?? 0).getTime());
    return sorted[0].id;
}
// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
async function postComment(octokit, ctx, body) {
    const { data } = await octokit.rest.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.prNumber,
        body,
    });
    return data.id;
}
async function updateComment(octokit, ctx, commentId, body) {
    await octokit.rest.issues.updateComment({
        owner: ctx.owner,
        repo: ctx.repo,
        comment_id: commentId,
        body,
    });
}
async function findQuizComment(octokit, ctx, quizId) {
    return findBalrogComment(octokit, ctx, `<!-- balrog-quiz-id: ${quizId} -->`);
}
async function findAnyBalrogComment(octokit, ctx) {
    return findBalrogComment(octokit, ctx, '<!-- balrog-quiz-id:');
}
async function findResultComment(octokit, ctx) {
    return findBalrogComment(octokit, ctx, '<!-- balrog-result -->');
}
async function findBalrogComment(octokit, ctx, marker) {
    for await (const page of octokit.paginate.iterator(octokit.rest.issues.listComments, {
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.prNumber,
        per_page: 100,
    })) {
        for (const comment of page.data) {
            if ((comment.body ?? '').includes(marker))
                return comment.id;
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Artifact storage (quiz + answers)
// ---------------------------------------------------------------------------
async function saveQuizArtifact(quiz) {
    const client = new artifact_1.DefaultArtifactClient();
    const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), 'balrog-'));
    const filePath = path_1.default.join(tmpDir, 'quiz.json');
    fs_1.default.writeFileSync(filePath, JSON.stringify(quiz, null, 2));
    await client.uploadArtifact(`${exports.ARTIFACT_PREFIX}${quiz.prNumber}`, [filePath], tmpDir, { retentionDays: 1 });
    fs_1.default.rmSync(tmpDir, { recursive: true });
    core.info(`Quiz artifact saved: ${exports.ARTIFACT_PREFIX}${quiz.prNumber}`);
}
// loadQuizArtifact finds artifacts across workflow runs via REST API and
// downloads them directly — @actions/artifact client can only access artifacts
// from the current run, so we bypass it entirely for cross-run access.
async function loadQuizArtifact(prNumber, octokit, owner, repo, token) {
    const artifactName = `${exports.ARTIFACT_PREFIX}${prNumber}`;
    core.info(`Searching for artifact "${artifactName}" in ${owner}/${repo}`);
    const { data } = await octokit.rest.actions.listArtifactsForRepo({
        owner,
        repo,
        name: artifactName,
        per_page: 5,
    });
    if (data.total_count === 0) {
        core.warning(`No quiz artifact found for PR #${prNumber}`);
        return null;
    }
    const target = data.artifacts
        .filter((a) => !a.expired)
        .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0];
    if (!target) {
        core.warning(`All quiz artifacts for PR #${prNumber} have expired`);
        return null;
    }
    core.info(`Found artifact id=${target.id} created=${target.created_at}, downloading...`);
    // GitHub redirects to a short-lived S3 URL. We fetch the redirect destination
    // directly with fetch() so we get a proper binary response — Octokit's
    // downloadArtifact mangles ArrayBuffer on redirects in the Actions runtime.
    // Get the redirect URL (archive_download_url requires auth to resolve)
    const redirectRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${target.id}/zip`, {
        method: 'GET',
        redirect: 'manual',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    const downloadUrl = redirectRes.headers.get('location') ?? target.archive_download_url;
    core.info(`Downloading zip from: ${downloadUrl.slice(0, 60)}...`);
    const zipRes = await fetch(downloadUrl);
    if (!zipRes.ok) {
        core.warning(`Failed to download zip: ${zipRes.status} ${zipRes.statusText}`);
        return null;
    }
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
    core.info(`Downloaded ${zipBuffer.length} bytes`);
    return extractQuizFromZip(zipBuffer);
}
function extractQuizFromZip(zipBuffer) {
    try {
        const zip = new adm_zip_1.default(zipBuffer);
        const entry = zip.getEntry('quiz.json');
        if (!entry) {
            core.warning('quiz.json not found in artifact zip');
            return null;
        }
        const raw = entry.getData().toString('utf-8');
        return JSON.parse(raw);
    }
    catch (err) {
        core.warning(`Failed to extract quiz from zip: ${String(err)}`);
        return null;
    }
}
//# sourceMappingURL=github.js.map