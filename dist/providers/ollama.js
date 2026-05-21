"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaAdapter = void 0;
const anthropic_1 = require("./anthropic");
const prompt_1 = require("./prompt");
// Ollama exposes an OpenAI-compatible /v1/chat/completions endpoint
class OllamaAdapter {
    constructor(baseURL = 'http://localhost:11434', model = 'llama3') {
        this.baseURL = baseURL.replace(/\/$/, '');
        this.model = model;
    }
    async generateQuiz(opts) {
        const response = await fetch(`${this.baseURL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: (0, prompt_1.buildSystemPrompt)() },
                    { role: 'user', content: (0, prompt_1.buildUserPrompt)(opts.diff, opts.numQuestions, opts.language, opts.additionalPrompt) },
                ],
                format: 'json',
                stream: false,
            }),
        });
        if (!response.ok) {
            throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
        }
        const data = (await response.json());
        const text = data.choices[0]?.message?.content ?? '';
        return (0, anthropic_1.parseQuizResponse)(text, opts.numQuestions);
    }
}
exports.OllamaAdapter = OllamaAdapter;
//# sourceMappingURL=ollama.js.map