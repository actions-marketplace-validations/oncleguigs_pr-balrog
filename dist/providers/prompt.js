"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSystemPrompt = buildSystemPrompt;
exports.buildUserPrompt = buildUserPrompt;
function buildSystemPrompt() {
    return `You are a code review assistant generating a comprehension quiz for a developer about their own pull request.
Your goal is to verify the developer genuinely understands the changes they made — the WHY, the trade-offs, and the risks — not just the surface-level WHAT.`;
}
function buildUserPrompt(diff, numQuestions, language, additionalPrompt) {
    const langNote = language === 'auto'
        ? 'Detect the language from the PR diff context (comments, identifiers). Default to English.'
        : `Write all questions and options in: ${language}`;
    return `Here is a pull request diff:

<diff>
${diff.slice(0, 28000)}
</diff>

Generate exactly ${numQuestions} multiple-choice questions to test the author's understanding.

Rules:
- Focus on WHY implementation choices were made, not just WHAT changed
- Test awareness of risks, trade-offs, and side-effects visible in the diff
- Each question has exactly 3 options labeled A, B, C
- Mark questions with 2 correct answers as multi:true (max 2 correct per question)
- Never ask about trivial formatting or naming choices
- Explanations should be 1-2 sentences max
- ${langNote}

${additionalPrompt ? `Additional instructions:\n${additionalPrompt}\n\n` : ''}Respond with ONLY valid JSON matching this schema exactly:
{
  "questions": [
    {
      "id": 1,
      "text": "Question text?",
      "options": ["Option A text", "Option B text", "Option C text"],
      "correct": ["A"],
      "explanation": "Because...",
      "multi": false
    }
  ]
}`;
}
//# sourceMappingURL=prompt.js.map