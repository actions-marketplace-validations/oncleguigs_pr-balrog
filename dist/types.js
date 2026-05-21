"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuizSchema = exports.AttemptRecordSchema = exports.SubmittedAnswersSchema = exports.QuestionSchema = void 0;
const zod_1 = require("zod");
exports.QuestionSchema = zod_1.z.object({
    id: zod_1.z.number().int().min(1),
    text: zod_1.z.string().min(10),
    options: zod_1.z.tuple([zod_1.z.string(), zod_1.z.string(), zod_1.z.string()]), // exactly A, B, C
    correct: zod_1.z.array(zod_1.z.enum(['A', 'B', 'C'])).min(1).max(2),
    explanation: zod_1.z.string(),
    multi: zod_1.z.boolean(), // true when more than one correct answer
});
exports.SubmittedAnswersSchema = zod_1.z.record(zod_1.z.string(), // "1", "2", ...
zod_1.z.array(zod_1.z.enum(['A', 'B', 'C'])));
exports.AttemptRecordSchema = zod_1.z.object({
    n: zod_1.z.number().int().min(1),
    answers: exports.SubmittedAnswersSchema,
    score: zod_1.z.number().min(0).max(100),
});
exports.QuizSchema = zod_1.z.object({
    id: zod_1.z.string(),
    prNumber: zod_1.z.number().int(),
    prHeadSha: zod_1.z.string(),
    generatedAt: zod_1.z.string().datetime(),
    questions: zod_1.z.array(exports.QuestionSchema).min(3).max(10),
    passThreshold: zod_1.z.number().min(0).max(100),
    maxAttempts: zod_1.z.number().int().min(0),
    attemptsUsed: zod_1.z.number().int().min(0).default(0),
    passed: zod_1.z.boolean().default(false),
    answerMode: zod_1.z.enum(['command', 'checkbox']).default('command'),
    attempts: zod_1.z.array(exports.AttemptRecordSchema).optional(),
});
//# sourceMappingURL=types.js.map