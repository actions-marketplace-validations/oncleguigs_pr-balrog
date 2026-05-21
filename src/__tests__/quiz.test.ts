import {
  pickQuizSize,
  buildQuiz,
  evaluateQuiz,
  parseAnswerComment,
  parseCheckboxAnswers,
  renderQuizComment,
  renderQuizCommentCheckbox,
  renderLockedQuizComment,
  renderResultComment,
} from '../quiz'
import type { Question } from '../types'

const SAMPLE_QUESTIONS: Question[] = [
  {
    id: 1,
    text: 'Why was the connection pool size increased?',
    options: ['To reduce memory', 'To handle concurrent load', 'It was a typo'],
    correct: ['B'],
    explanation: 'The new /stream endpoint requires concurrent connections.',
    multi: false,
  },
  {
    id: 2,
    text: 'Which risks does removing the mutex introduce?',
    options: ['Race condition', 'Deadlock', 'Memory leak'],
    correct: ['A', 'B'],
    explanation: 'Concurrent writes without mutex can cause races and deadlocks.',
    multi: true,
  },
  {
    id: 3,
    text: 'What does the new retry logic improve?',
    options: ['Throughput', 'Resilience on transient failures', 'Latency'],
    correct: ['B'],
    explanation: 'Retries handle transient network errors gracefully.',
    multi: false,
  },
]

describe('pickQuizSize', () => {
  it('returns 3 for small PRs', () => expect(pickQuizSize(50)).toBe(3))
  it('returns 3 at boundary 99', () => expect(pickQuizSize(99)).toBe(3))
  it('returns 5 at boundary 100', () => expect(pickQuizSize(100)).toBe(5))
  it('returns 5 at boundary 500', () => expect(pickQuizSize(500)).toBe(5))
  it('returns 10 for large PRs', () => expect(pickQuizSize(501)).toBe(10))
  it('respects override', () => {
    expect(pickQuizSize(1000, '3')).toBe(3)
    expect(pickQuizSize(10, '10')).toBe(10)
  })
})

describe('parseAnswerComment', () => {
  it('parses single answers', () => {
    const result = parseAnswerComment('!balrog 1:A 2:B 3:C')
    expect(result).toEqual({ '1': ['A'], '2': ['B'], '3': ['C'] })
  })

  it('parses multi answers', () => {
    const result = parseAnswerComment('Hey there!\n!balrog 1:A,B 2:C 3:A')
    expect(result).toEqual({ '1': ['A', 'B'], '2': ['C'], '3': ['A'] })
  })

  it('is case-insensitive', () => {
    const result = parseAnswerComment('!balrog 1:a 2:b,c')
    expect(result).toEqual({ '1': ['A'], '2': ['B', 'C'] })
  })

  it('returns null when no !balrog token', () => {
    expect(parseAnswerComment('1:A 2:B')).toBeNull()
  })

  it('returns null for invalid letters', () => {
    expect(parseAnswerComment('!balrog 1:D')).toBeNull()
  })
})

describe('evaluateQuiz', () => {
  const quiz = buildQuiz(SAMPLE_QUESTIONS, 42, 'abc123', 80, 3)

  it('passes with all correct answers', () => {
    const result = evaluateQuiz(quiz, { '1': ['B'], '2': ['A', 'B'], '3': ['B'] })
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
  })

  it('fails below threshold', () => {
    const result = evaluateQuiz(quiz, { '1': ['A'], '2': ['A'], '3': ['A'] })
    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
  })

  it('partial multi-answer is wrong', () => {
    // Q2 requires A AND B — submitting only A is wrong
    const result = evaluateQuiz(quiz, { '1': ['B'], '2': ['A'], '3': ['B'] })
    expect(result.perQuestion[1].isCorrect).toBe(false)
    expect(result.score).toBe(67)
  })

  it('missing answers count as wrong', () => {
    const result = evaluateQuiz(quiz, { '1': ['B'] })
    expect(result.score).toBe(33)
  })
})

describe('pass-threshold', () => {
  it('passes at exactly the threshold', () => {
    // 2/3 correct = 67% — passes with threshold 60, fails with threshold 70
    const quiz60 = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 60, 3)
    const quiz70 = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 70, 3)
    const answers: Record<string, ('A' | 'B' | 'C')[]> = { '1': ['B'], '2': ['A'], '3': ['A'] } // Q1 correct, Q2 wrong (partial), Q3 wrong → 33%
    expect(evaluateQuiz(quiz60, { '1': ['B'], '2': ['A', 'B'], '3': ['B'] }).passed).toBe(true)  // 100% ≥ 60
    expect(evaluateQuiz(quiz70, answers).passed).toBe(false) // 33% < 70
  })

  it('threshold 100 requires a perfect score', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 100, 3)
    expect(evaluateQuiz(quiz, { '1': ['B'], '2': ['A', 'B'], '3': ['B'] }).passed).toBe(true)
    expect(evaluateQuiz(quiz, { '1': ['B'], '2': ['A', 'B'], '3': ['A'] }).passed).toBe(false)
  })

  it('threshold 0 always passes', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 0, 3)
    expect(evaluateQuiz(quiz, { '1': ['A'], '2': ['C'], '3': ['C'] }).passed).toBe(true)
  })
})

describe('max-attempts', () => {
  it('shows unlimited label when max-attempts is 0', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 0)
    const result = evaluateQuiz(quiz, { '1': ['A'], '2': ['A'], '3': ['A'] })
    const comment = renderResultComment({ ...result, quiz: { ...quiz, attemptsUsed: 1 } })
    expect(comment).toContain('unlimited')
  })

  it('shows attempts remaining when max-attempts > 0', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 5)
    const updated = { ...quiz, attemptsUsed: 2 }
    const result = evaluateQuiz(quiz, { '1': ['A'], '2': ['A'], '3': ['A'] })
    const comment = renderResultComment({ ...result, quiz: updated })
    expect(comment).toContain('3') // 5 - 2 = 3 left
    expect(comment).not.toContain('unlimited')
  })

  it('shows no-attempts-left message when exhausted', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3)
    const exhausted = { ...quiz, attemptsUsed: 3 }
    const result = evaluateQuiz(quiz, { '1': ['A'], '2': ['A'], '3': ['A'] })
    const comment = renderResultComment({ ...result, quiz: exhausted })
    expect(comment).toContain('No attempts left')
  })
})

describe('language (fr)', () => {
  it('renders quiz comment in French', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3)
    const comment = renderQuizComment(quiz, 'fr')
    expect(comment).toContain('avant le merge')
    expect(comment).toContain('plusieurs réponses')
  })

  it('renders result comment in French on pass', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3)
    const result = evaluateQuiz(quiz, { '1': ['B'], '2': ['A', 'B'], '3': ['B'] })
    const comment = renderResultComment(result, 'fr')
    expect(comment).toContain('réussi')
    expect(comment).toContain('merger')
  })

  it('renders result comment in French on fail', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3)
    const updated = { ...quiz, attemptsUsed: 1 }
    const result = evaluateQuiz(quiz, { '1': ['A'], '2': ['A'], '3': ['A'] })
    const comment = renderResultComment({ ...result, quiz: updated }, 'fr')
    expect(comment).toContain('échoué')
    expect(comment).toContain('tentative')
  })

  it('renders unlimited label in French', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 0)
    const result = evaluateQuiz(quiz, { '1': ['A'], '2': ['A'], '3': ['A'] })
    const comment = renderResultComment({ ...result, quiz: { ...quiz, attemptsUsed: 1 } }, 'fr')
    expect(comment).toContain('illimitées')
  })
})

describe('renderQuizComment', () => {
  it('includes quiz ID in hidden comment', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3)
    const comment = renderQuizComment(quiz)
    expect(comment).toContain(`<!-- balrog-quiz-id: ${quiz.id} -->`)
  })

  it('does NOT include correct answers', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3)
    const comment = renderQuizComment(quiz)
    expect(comment).not.toContain('"correct"')
    expect(comment).not.toContain('"B"')
  })

  it('marks multi-answer questions', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3)
    const comment = renderQuizComment(quiz)
    expect(comment).toContain('multiple answers')
  })

  it('shows pass-threshold and max-attempts in header table', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 65, 7)
    const comment = renderQuizComment(quiz)
    expect(comment).toContain('65%')
    expect(comment).toContain('7')
  })

  it('shows ∞ in header table when max-attempts is 0', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 0)
    const comment = renderQuizComment(quiz)
    expect(comment).toContain('∞')
  })
})

describe('renderQuizCommentCheckbox', () => {
  it('contains task-list checkboxes for each option', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3, 'checkbox')
    const comment = renderQuizCommentCheckbox(quiz)
    expect(comment).toContain('- [ ] **Q1A)**')
    expect(comment).toContain('- [ ] **Q1B)**')
    expect(comment).toContain('- [ ] **Q1C)**')
  })

  it('contains the submit checkbox', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3, 'checkbox')
    const comment = renderQuizCommentCheckbox(quiz)
    expect(comment).toContain('- [ ] ✅ Submit my answers')
  })

  it('contains checkbox mode marker', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3, 'checkbox')
    const comment = renderQuizCommentCheckbox(quiz)
    expect(comment).toContain('<!-- balrog-mode: checkbox -->')
  })

  it('does NOT expose correct answers', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3, 'checkbox')
    const comment = renderQuizCommentCheckbox(quiz)
    expect(comment).not.toContain('"correct"')
    expect(comment).not.toContain('"B"')
  })

  it('renders in French', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3, 'checkbox')
    const comment = renderQuizCommentCheckbox(quiz, 'fr')
    expect(comment).toContain('Soumettre mes réponses')
    expect(comment).toContain('avant le merge')
  })
})

describe('parseCheckboxAnswers', () => {
  const makeBody = (checks: Record<string, string[]>, submitChecked = true) => {
    const lines: string[] = []
    for (let q = 1; q <= 3; q++) {
      for (const letter of ['A', 'B', 'C']) {
        const checked = (checks[q] ?? []).includes(letter) ? 'x' : ' '
        lines.push(`- [${checked}] **Q${q}${letter})** option text`)
      }
    }
    lines.push(submitChecked ? '- [x] ✅ Submit my answers' : '- [ ] ✅ Submit my answers')
    return lines.join('\n')
  }

  it('returns null when submit not checked', () => {
    const body = makeBody({ '1': ['B'], '2': ['A', 'B'], '3': ['B'] }, false)
    expect(parseCheckboxAnswers(body)).toBeNull()
  })

  it('parses single checked answers', () => {
    const body = makeBody({ '1': ['B'], '2': ['C'], '3': ['A'] })
    expect(parseCheckboxAnswers(body)).toEqual({ '1': ['B'], '2': ['C'], '3': ['A'] })
  })

  it('parses multi checked answers', () => {
    const body = makeBody({ '1': ['B'], '2': ['A', 'B'], '3': ['B'] })
    expect(parseCheckboxAnswers(body)).toEqual({ '1': ['B'], '2': ['A', 'B'], '3': ['B'] })
  })

  it('returns null when no answers checked but submit is checked', () => {
    const body = makeBody({})
    expect(parseCheckboxAnswers(body)).toBeNull()
  })

  it('parses French submit label', () => {
    const body = makeBody({ '1': ['A'] }, false).replace(
      '- [ ] ✅ Submit my answers',
      '- [x] ✅ Soumettre mes réponses',
    )
    expect(parseCheckboxAnswers(body)).toEqual({ '1': ['A'] })
  })
})

describe('renderLockedQuizComment', () => {
  it('contains the locked banner', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3, 'checkbox')
    const comment = renderLockedQuizComment(quiz)
    expect(comment).toContain('🔒')
    expect(comment).toContain('locked')
  })

  it('has no task-list checkboxes', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3, 'checkbox')
    const comment = renderLockedQuizComment(quiz)
    expect(comment).not.toContain('- [ ]')
    expect(comment).not.toContain('- [x]')
  })

  it('uses checkbox-locked marker', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3, 'checkbox')
    const comment = renderLockedQuizComment(quiz)
    expect(comment).toContain('<!-- balrog-mode: checkbox-locked -->')
  })
})

describe('renderResultComment', () => {
  it('shows pass message on success', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3)
    const result = evaluateQuiz(quiz, { '1': ['B'], '2': ['A', 'B'], '3': ['B'] })
    const comment = renderResultComment(result)
    expect(comment).toContain('passed')
    expect(comment).toContain('100%')
  })

  it('shows failure with attempts remaining', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3)
    const updatedQuiz = { ...quiz, attemptsUsed: 1 }
    const result = evaluateQuiz(updatedQuiz, { '1': ['A'], '2': ['A'], '3': ['A'] })
    const comment = renderResultComment({ ...result, quiz: updatedQuiz })
    expect(comment).toContain('failed')
    expect(comment).toContain('2')
  })

  it('shows explanation only for wrong answers, not correct ones', () => {
    const quiz = buildQuiz(SAMPLE_QUESTIONS, 1, 'sha', 80, 3)
    const result = evaluateQuiz(quiz, { '1': ['B'], '2': ['A'], '3': ['A'] })
    const comment = renderResultComment(result)
    // Q1 correct — explanation should not appear
    expect(comment).not.toContain(SAMPLE_QUESTIONS[0].explanation)
    // Q2 wrong — explanation should appear
    expect(comment).toContain(SAMPLE_QUESTIONS[1].explanation)
  })
})
