"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureOpenAIAdapter = exports.GitHubModelsAdapter = exports.OpenAIAdapter = void 0;
const openai_1 = __importDefault(require("openai"));
const anthropic_1 = require("./anthropic");
const prompt_1 = require("./prompt");
class OpenAIAdapter {
    constructor(apiKey, model = 'gpt-4o', baseURL) {
        this.client = new openai_1.default({ apiKey, ...(baseURL ? { baseURL } : {}) });
        this.model = model;
    }
    async generateQuiz(opts) {
        const response = await this.client.chat.completions.create({
            model: this.model,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: (0, prompt_1.buildSystemPrompt)() },
                { role: 'user', content: (0, prompt_1.buildUserPrompt)(opts.diff, opts.numQuestions, opts.language, opts.additionalPrompt) },
            ],
        });
        const text = response.choices[0]?.message?.content ?? '';
        return (0, anthropic_1.parseQuizResponse)(text, opts.numQuestions);
    }
}
exports.OpenAIAdapter = OpenAIAdapter;
// GitHub Models uses the OpenAI-compatible endpoint with the GITHUB_TOKEN
class GitHubModelsAdapter extends OpenAIAdapter {
    constructor(token, model = 'gpt-4o') {
        super(token, model, 'https://models.inference.ai.azure.com');
    }
}
exports.GitHubModelsAdapter = GitHubModelsAdapter;
// Azure OpenAI uses the same SDK with a different base URL + API version
class AzureOpenAIAdapter {
    constructor(apiKey, endpoint, deployment, apiVersion = '2024-02-01') {
        this.client = new openai_1.default({
            apiKey,
            baseURL: `${endpoint}/openai/deployments/${deployment}`,
            defaultQuery: { 'api-version': apiVersion },
            defaultHeaders: { 'api-key': apiKey },
        });
        this.model = deployment;
    }
    async generateQuiz(opts) {
        const response = await this.client.chat.completions.create({
            model: this.model,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: (0, prompt_1.buildSystemPrompt)() },
                { role: 'user', content: (0, prompt_1.buildUserPrompt)(opts.diff, opts.numQuestions, opts.language, opts.additionalPrompt) },
            ],
        });
        const text = response.choices[0]?.message?.content ?? '';
        return (0, anthropic_1.parseQuizResponse)(text, opts.numQuestions);
    }
}
exports.AzureOpenAIAdapter = AzureOpenAIAdapter;
//# sourceMappingURL=openai.js.map