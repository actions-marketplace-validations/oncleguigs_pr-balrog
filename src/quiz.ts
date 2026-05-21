import crypto from 'crypto'
import type { Quiz, Question, QuizSize, QuizResult, QuestionResult, SubmittedAnswers, AnswerMode } from './types'

export function pickQuizSize(changedLines: number, override?: string): QuizSize {
  if (override === '3') return 3
  if (override === '5') return 5
  if (override === '10') return 10
  if (changedLines < 100) return 3
  if (changedLines <= 500) return 5
  return 10
}

export function generateQuizId(): string {
  return crypto.randomBytes(8).toString('hex')
}

export function buildQuiz(
  questions: Question[],
  prNumber: number,
  headSha: string,
  passThreshold: number,
  maxAttempts: number,
  answerMode: AnswerMode = 'command',
): Quiz {
  return {
    id: generateQuizId(),
    prNumber,
    prHeadSha: headSha,
    generatedAt: new Date().toISOString(),
    questions,
    passThreshold,
    maxAttempts,
    attemptsUsed: 0,
    passed: false,
    answerMode,
  }
}

export function evaluateQuiz(quiz: Quiz, answers: SubmittedAnswers): QuizResult {
  const perQuestion: QuestionResult[] = quiz.questions.map((q) => {
    const submitted = (answers[String(q.id)] ?? []).map((a) => a.toUpperCase()).sort()
    const correct = [...q.correct].sort()
    const isCorrect =
      submitted.length === correct.length && submitted.every((a, i) => a === correct[i])

    return {
      questionId: q.id,
      submitted,
      correct,
      isCorrect,
      explanation: q.explanation,
    }
  })

  const correctCount = perQuestion.filter((r) => r.isCorrect).length
  const score = Math.round((correctCount / quiz.questions.length) * 100)
  const passed = score >= quiz.passThreshold

  return { quiz, answers, score, passed, perQuestion }
}

// ---------------------------------------------------------------------------
// Comment rendering helpers
// ---------------------------------------------------------------------------

function scoreBar(score: number, width = 10): string {
  const filled = Math.round((score / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function attemptsLabel(used: number, max: number, isFr: boolean): string {
  if (max === 0) return isFr ? 'tentatives illimitées' : 'unlimited attempts'
  const left = max - used
  return isFr ? `${left} tentative${left > 1 ? 's' : ''} restante${left > 1 ? 's' : ''}` : `${left} attempt${left !== 1 ? 's' : ''} left`
}

// ---------------------------------------------------------------------------
// Quiz comment
// ---------------------------------------------------------------------------

export function renderQuizComment(quiz: Quiz, language = 'en'): string {
  const isFr = language.startsWith('fr')
  const n = quiz.questions.length
  const remaining = quiz.maxAttempts === 0 ? Infinity : quiz.maxAttempts - quiz.attemptsUsed
  const maxLabel = quiz.maxAttempts === 0 ? '∞' : String(remaining)

  const t = {
    title:       isFr ? `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} avant le merge` : `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} before merge`,
    subtitle:    isFr ? '> **You shall not pass** — prouve que tu comprends tes propres changements.' : '> **You shall not pass** — prove you understand your own changes.',
    threshold:   isFr ? 'Seuil' : 'Threshold',
    attempts:    isFr ? 'Tentatives restantes' : 'Attempts left',
    howto:       isFr ? '**Comment répondre :**' : '**How to answer:**',
    multi:       isFr ? '*(plusieurs réponses)*' : '*(multiple answers)*',
    retry:       isFr ? 'Plus de tentatives ? Tapez `!balrog retry`.' : 'Out of attempts? Type `!balrog retry`.',
  }

  const exampleAnswers = quiz.questions.map((_, i) => `${i + 1}:A`).join(' ')

  const lines: string[] = [
    `## ${t.title}`,
    '',
    t.subtitle,
    '',
    `| ${t.threshold} | ${t.attempts} | Questions |`,
    `|:---:|:---:|:---:|`,
    `| **${quiz.passThreshold}%** | **${maxLabel}** | **${n}** |`,
    '',
    `${t.howto} Reply with \`!balrog ${exampleAnswers}\` — separate multiple answers with a comma.`,
    `<sub>${t.retry}</sub>`,
    '',
    '---',
    '',
  ]

  for (const q of quiz.questions) {
    const multiTag = q.multi ? ` *(${isFr ? 'plusieurs réponses' : 'multiple answers'})* ` : ''
    lines.push(`**Q${q.id}.** ${multiTag}${q.text}`)
    lines.push('')
    lines.push(`- **A)** ${q.options[0]}`)
    lines.push(`- **B)** ${q.options[1]}`)
    lines.push(`- **C)** ${q.options[2]}`)
    lines.push('')
  }

  lines.push(`<!-- balrog-quiz-id: ${quiz.id} -->`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Result comment
// ---------------------------------------------------------------------------

export function renderResultComment(result: QuizResult, language = 'en'): string {
  const isFr = language.startsWith('fr')
  const { score, passed, perQuestion, quiz } = result
  const correctCount = perQuestion.filter((r) => r.isCorrect).length
  const total = quiz.questions.length
  const bar = scoreBar(score)
  const attLeft = attemptsLabel(quiz.attemptsUsed, quiz.maxAttempts, isFr)

  const lines: string[] = []

  if (passed) {
    lines.push(isFr
      ? `## ✅ Quiz réussi — vous pouvez merger !`
      : `## ✅ Quiz passed — you may merge!`)
    lines.push('')
    lines.push(`\`${bar}\` **${score}%** — ${correctCount}/${total} ${isFr ? 'correcte(s)' : 'correct'}`)
    lines.push('')
  } else {
    lines.push(isFr
      ? `## ❌ Quiz échoué`
      : `## ❌ Quiz failed`)
    lines.push('')
    lines.push(`\`${bar}\` **${score}%** — ${correctCount}/${total} ${isFr ? 'correcte(s)' : 'correct'} · ${attLeft}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')

  for (const r of perQuestion) {
    const q = quiz.questions.find((q) => q.id === r.questionId)!
    const submitted = r.submitted.length ? r.submitted.join(', ') : '—'

    const submittedKbd = r.submitted.map((l) => `<kbd>${l}</kbd>`).join(' ')

    if (r.isCorrect) {
      lines.push(`✅ **${r.questionId}.** ${q.text}`)
    } else {
      lines.push(`❌ **${r.questionId}.** ${q.text}`)
      lines.push(`> ↳ You answered ${submittedKbd || '—'}`)
      lines.push(`> 💡 ${r.explanation}`)
    }
    lines.push('')
  }

  if (!passed && quiz.maxAttempts > 0 && quiz.attemptsUsed >= quiz.maxAttempts) {
    lines.push('---')
    lines.push('')
    lines.push(isFr
      ? '> 🔒 Plus de tentatives — tapez `!balrog retry` ou poussez un commit pour obtenir un nouveau quiz.'
      : '> 🔒 No attempts left — type `!balrog retry` or push a commit to get a fresh quiz.')
  }

  lines.push('')
  lines.push('<!-- balrog-result -->')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Checkbox quiz comment
// ---------------------------------------------------------------------------

export function renderQuizCommentCheckbox(quiz: Quiz, language = 'en', previousAnswers?: SubmittedAnswers): string {
  const isFr = language.startsWith('fr')
  const n = quiz.questions.length
  const remaining = quiz.maxAttempts === 0 ? Infinity : quiz.maxAttempts - quiz.attemptsUsed
  const maxLabel = quiz.maxAttempts === 0 ? '∞' : String(remaining)

  const t = {
    title:    isFr ? `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} avant le merge` : `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} before merge`,
    subtitle: isFr ? '> **You shall not pass** — prouve que tu comprends tes propres changements.' : '> **You shall not pass** — prove you understand your own changes.',
    threshold: isFr ? 'Seuil' : 'Threshold',
    attempts:  isFr ? 'Tentatives restantes' : 'Attempts left',
    howto:    isFr ? '**Comment répondre :** Coche tes réponses puis coche **✅ Soumettre**.' : '**How to answer:** Check your answers then check **✅ Submit my answers**.',
    multi:    isFr ? '*(plusieurs réponses)*' : '*(multiple answers)*',
    submit:   isFr ? '✅ Soumettre mes réponses' : '✅ Submit my answers',
    retry:    isFr ? 'Plus de tentatives ? Tapez `!balrog retry`.' : 'Out of attempts? Type `!balrog retry`.',
  }

  const lines: string[] = [
    `## ${t.title}`,
    '',
    t.subtitle,
    '',
    `| ${t.threshold} | ${t.attempts} | Questions |`,
    `|:---:|:---:|:---:|`,
    `| **${quiz.passThreshold}%** | **${maxLabel}** | **${n}** |`,
    '',
    t.howto,
    `<sub>${t.retry}</sub>`,
    '',
    '---',
    '',
  ]

  for (const q of quiz.questions) {
    const qKey = String(q.id)
    const prev = previousAnswers?.[qKey] ?? []
    const multiTag = q.multi ? ` ${t.multi} ` : ''
    lines.push(`**Q${q.id}.** ${multiTag}${q.text}`)
    lines.push('')
    lines.push(`- [${prev.includes('A') ? 'x' : ' '}] **Q${q.id}A)** ${q.options[0]}`)
    lines.push(`- [${prev.includes('B') ? 'x' : ' '}] **Q${q.id}B)** ${q.options[1]}`)
    lines.push(`- [${prev.includes('C') ? 'x' : ' '}] **Q${q.id}C)** ${q.options[2]}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(`- [ ] ${t.submit}`)
  lines.push('')
  lines.push(`<!-- balrog-quiz-id: ${quiz.id} -->`)
  lines.push(`<!-- balrog-mode: checkbox -->`)

  return lines.join('\n')
}

// Parses checkbox state from a rendered quiz comment body.
// Returns null if the submit checkbox is not checked.
export function parseCheckboxAnswers(body: string): SubmittedAnswers | null {
  // Must have submit checkbox checked
  if (!/- \[x\] ✅ (Submit my answers|Soumettre mes réponses)/i.test(body)) return null

  const answers: SubmittedAnswers = {}
  // Match lines like: - [x] **Q1A)** text  or  - [ ] **Q2B)** text
  const lineRegex = /- \[(x| )\] \*\*Q(\d+)([ABC])\)\*\*/gi
  let match: RegExpExecArray | null

  while ((match = lineRegex.exec(body)) !== null) {
    const checked = match[1].toLowerCase() === 'x'
    const qNum = match[2]
    const letter = match[3].toUpperCase() as 'A' | 'B' | 'C'
    if (!answers[qNum]) answers[qNum] = []
    if (checked) answers[qNum].push(letter)
  }

  // Strip questions with no checked answers, then require at least one
  for (const k of Object.keys(answers)) {
    if (answers[k].length === 0) delete answers[k]
  }
  if (Object.keys(answers).length === 0) return null

  return answers
}

// Replaces the live quiz comment with a locked version after submission.
export function renderLockedQuizComment(quiz: Quiz, language = 'en'): string {
  const isFr = language.startsWith('fr')
  const n = quiz.questions.length
  const remaining = quiz.maxAttempts === 0 ? Infinity : quiz.maxAttempts - quiz.attemptsUsed
  const maxLabel = quiz.maxAttempts === 0 ? '∞' : String(remaining)

  const banner = isFr
    ? '> 🔒 **Réponses soumises** — ce quiz est verrouillé. Attendez le résultat ci-dessous.'
    : '> 🔒 **Answers submitted** — this quiz is locked. See the result comment below.'

  const t = {
    title:    isFr ? `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} avant le merge` : `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} before merge`,
    threshold: isFr ? 'Seuil' : 'Threshold',
    attempts:  isFr ? 'Tentatives restantes' : 'Attempts left',
    multi:    isFr ? '*(plusieurs réponses)*' : '*(multiple answers)*',
  }

  const lines: string[] = [
    `## ${t.title}`,
    '',
    banner,
    '',
    `| ${t.threshold} | ${t.attempts} | Questions |`,
    `|:---:|:---:|:---:|`,
    `| **${quiz.passThreshold}%** | **${maxLabel}** | **${n}** |`,
    '',
    '---',
    '',
  ]

  for (const q of quiz.questions) {
    const multiTag = q.multi ? ` ${t.multi} ` : ''
    lines.push(`**Q${q.id}.** ${multiTag}${q.text}`)
    lines.push('')
    lines.push(`- **A)** ${q.options[0]}`)
    lines.push(`- **B)** ${q.options[1]}`)
    lines.push(`- **C)** ${q.options[2]}`)
    lines.push('')
  }

  lines.push(`<!-- balrog-quiz-id: ${quiz.id} -->`)
  lines.push(`<!-- balrog-mode: checkbox-locked -->`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Answer parsing (!balrog command)
// ---------------------------------------------------------------------------

const ANSWER_REGEX = /!balrog\s+((?:\d+:[A-Ca-c](?:,[A-Ca-c])*\s*)+)/i

export function parseAnswerComment(body: string): SubmittedAnswers | null {
  const match = body.match(ANSWER_REGEX)
  if (!match) return null

  const answers: SubmittedAnswers = {}
  const pairs = match[1].trim().split(/\s+/)

  for (const pair of pairs) {
    const [qNum, rawAnswers] = pair.split(':')
    if (!qNum || !rawAnswers) return null
    const letters = rawAnswers.split(',').map((l) => l.toUpperCase()) as ('A' | 'B' | 'C')[]
    const valid = letters.every((l) => ['A', 'B', 'C'].includes(l))
    if (!valid) return null
    answers[qNum] = letters
  }

  return Object.keys(answers).length > 0 ? answers : null
}
