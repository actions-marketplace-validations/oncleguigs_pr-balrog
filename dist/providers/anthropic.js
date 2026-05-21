"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnthropicAdapter = void 0;
exports.parseQuizResponse = parseQuizResponse;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const zod_1 = require("zod");
const types_1 = require("../types");
const prompt_1 = require("./prompt");
const ResponseSchema = zod_1.z.object({
    questions: zod_1.z.array(types_1.QuestionSchema),
});
class AnthropicAdapter {
    constructor(apiKey, model = 'claude-sonnet-4-6') {
        this.client = new sdk_1.default({ apiKey });
        this.model = model;
    }
    async generateQuiz(opts) {
        const message = await this.client.messages.create({
            model: this.model,
            max_tokens: 4096,
            system: (0, prompt_1.buildSystemPrompt)(),
            messages: [
                {
                    role: 'user',
                    content: (0, prompt_1.buildUserPrompt)(opts.diff, opts.numQuestions, opts.language, opts.additionalPrompt),
                },
            ],
        });
        const text = message.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
        return parseQuizResponse(text, opts.numQuestions);
    }
}
exports.AnthropicAdapter = AnthropicAdapter;
function parseQuizResponse(raw, expected) {
    // strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    const result = ResponseSchema.safeParse(parsed);
    if (!result.success) {
        throw new Error(`AI returned invalid quiz schema: ${result.error.message}`);
    }
    const questions = result.data.questions.slice(0, expected);
    if (questions.length < expected) {
        throw new Error(`AI returned ${questions.length} questions, expected ${expected}`);
    }
    return questions;
}
//# sourceMappingURL=anthropic.js.map