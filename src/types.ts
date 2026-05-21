import { z } from 'zod'

export const QuestionSchema = z.object({
  id: z.number().int().min(1),
  text: z.string().min(10),
  options: z.tuple([z.string(), z.string(), z.string()]), // exactly A, B, C
  correct: z.array(z.enum(['A', 'B', 'C'])).min(1).max(2),
  explanation: z.string(),
  multi: z.boolean(), // true when more than one correct answer
})

export const QuizSchema = z.object({
  id: z.string(),
  prNumber: z.number().int(),
  prHeadSha: z.string(),
  generatedAt: z.string().datetime(),
  questions: z.array(QuestionSchema).min(3).max(10),
  passThreshold: z.number().min(0).max(100),
  maxAttempts: z.number().int().min(0),
  attemptsUsed: z.number().int().min(0).default(0),
  passed: z.boolean().default(false),
  answerMode: z.enum(['command', 'checkbox']).default('command'),
})

export const SubmittedAnswersSchema = z.record(
  z.string(), // "1", "2", ...
  z.array(z.enum(['A', 'B', 'C'])),
)

export type Question = z.infer<typeof QuestionSchema>
export type Quiz = z.infer<typeof QuizSchema>
export type SubmittedAnswers = z.infer<typeof SubmittedAnswersSchema>

export type QuizSize = 3 | 5 | 10

export type AIProvider = 'anthropic' | 'openai' | 'github-models' | 'azure-openai' | 'ollama'
export type AnswerMode = 'command' | 'checkbox'

export interface GenerateQuizOptions {
  diff: string
  numQuestions: QuizSize
  language: string
  additionalPrompt?: string
}

export interface AIAdapter {
  generateQuiz(opts: GenerateQuizOptions): Promise<Question[]>
}

export interface QuizResult {
  quiz: Quiz
  answers: SubmittedAnswers
  score: number         // 0-100
  passed: boolean
  perQuestion: QuestionResult[]
}

export interface QuestionResult {
  questionId: number
  submitted: string[]
  correct: string[]
  isCorrect: boolean
  explanation: string
}

export interface RepoContext {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  authorLogin: string
}
