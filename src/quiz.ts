import crypto from 'crypto'
import type { Quiz, Question, QuizSize, QuizResult, QuestionResult, SubmittedAnswers, AnswerMode, QuizHistoryEntry } from './types'

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
  previousQuizzes?: QuizHistoryEntry[],
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
    ...(previousQuizzes && previousQuizzes.length > 0 ? { previousQuizzes } : {}),
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

// Strips leading "A) ", "B. ", "C: " etc. that the AI sometimes includes in option text.
function cleanOption(text: string): string {
  return text.replace(/^\s*[A-Ca-c][.):–-]\s+/, '')
}

function attemptsLabel(used: number, max: number, isFr: boolean): string {
  if (max === 0) return isFr ? 'tentatives illimitées' : 'unlimited attempts'
  const left = max - used
  return isFr ? `${left} tentative${left > 1 ? 's' : ''} restante${left > 1 ? 's' : ''}` : `${left} attempt${left !== 1 ? 's' : ''} left`
}

// ---------------------------------------------------------------------------
// Attempt history + fighting banner
// ---------------------------------------------------------------------------

export function renderAttemptsHistory(quiz: Quiz, language = 'en'): string {
  const isFr = language.startsWith('fr')
  const prevQuizzes = quiz.previousQuizzes ?? []
  const currentAttempts = quiz.attempts ?? []

  if (prevQuizzes.length === 0 && currentAttempts.length === 0) return ''

  const totalAttempts = prevQuizzes.reduce((sum, q) => sum + q.attempts.length, 0) + currentAttempts.length

  const outerSummary = prevQuizzes.length > 0
    ? (isFr
        ? `📜 Historique — ${totalAttempts} tentative${totalAttempts > 1 ? 's' : ''} sur ${prevQuizzes.length + 1} quiz`
        : `📜 History — ${totalAttempts} attempt${totalAttempts !== 1 ? 's' : ''} across ${prevQuizzes.length + 1} quizzes`)
    : (isFr
        ? `📜 Tentatives passées (${currentAttempts.length})`
        : `📜 Past attempts (${currentAttempts.length})`)

  const lines: string[] = []
  lines.push('<details>')
  lines.push(`<summary>${outerSummary}</summary>`)
  lines.push('')

  // Current quiz attempts (questions are visible below in the quiz section)
  if (currentAttempts.length > 0) {
    const currentHeader = isFr
      ? `**Quiz actuel — ${currentAttempts.length} tentative${currentAttempts.length > 1 ? 's' : ''}**`
      : `**Current quiz — ${currentAttempts.length} attempt${currentAttempts.length !== 1 ? 's' : ''}**`
    lines.push(currentHeader)
    lines.push('')
    for (const a of currentAttempts) {
      const ansStr = Object.entries(a.answers)
        .sort(([x], [y]) => Number(x) - Number(y))
        .map(([q, ans]) => `Q${q}: ${(ans as string[]).join(',')}`)
        .join(' · ')
      const icon = a.score >= quiz.passThreshold ? ' ✅' : ''
      lines.push(`- Attempt ${a.n}: ${ansStr} — **${a.score}%**${icon}`)
    }
    lines.push('')
    if (prevQuizzes.length > 0) {
      lines.push('---')
      lines.push('')
    }
  }

  // Previous quizzes — each as a nested <details> with questions + attempts
  const optionLetters: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C']
  for (let i = 0; i < prevQuizzes.length; i++) {
    const pq = prevQuizzes[i]
    const quizNum = i + 1
    const date = pq.generatedAt.slice(0, 10)
    const passIcon = pq.passed ? '✅' : '❌'
    const attCount = pq.attempts.length
    const innerSummary = isFr
      ? `Quiz ${quizNum} — ${date} — ${passIcon} — ${attCount} tentative${attCount !== 1 ? 's' : ''}`
      : `Quiz ${quizNum} — ${date} — ${passIcon} — ${attCount} attempt${attCount !== 1 ? 's' : ''}`

    lines.push('<details>')
    lines.push(`<summary>${innerSummary}</summary>`)
    lines.push('')

    for (const q of pq.questions) {
      const multiTag = q.multi ? ` *(${isFr ? 'plusieurs réponses' : 'multiple answers'})* ` : ''
      lines.push(`**Q${q.id}.** ${multiTag}${q.text}`)
      lines.push('')
      for (let j = 0; j < q.options.length; j++) {
        const letter = optionLetters[j]
        const mark = (q.correct as string[]).includes(letter) ? '✅' : '⬜'
        lines.push(`- ${mark} **${letter})** ${cleanOption(q.options[j])}`)
      }
      lines.push(`> 💡 ${q.explanation}`)
      lines.push('')
    }

    if (pq.attempts.length > 0) {
      lines.push(isFr ? '**Tentatives :**' : '**Attempts:**')
      lines.push('')
      for (const a of pq.attempts) {
        const ansStr = Object.entries(a.answers)
          .sort(([x], [y]) => Number(x) - Number(y))
          .map(([q, ans]) => `Q${q}: ${(ans as string[]).join(',')}`)
          .join(' · ')
        const icon = a.score >= pq.passThreshold ? ' ✅' : ''
        lines.push(`- Attempt ${a.n}: ${ansStr} — **${a.score}%**${icon}`)
      }
      lines.push('')
    }

    lines.push('</details>')
    if (i < prevQuizzes.length - 1) lines.push('')
  }

  lines.push('')
  lines.push('</details>')
  lines.push('')

  return lines.join('\n')
}

export function renderFightingBanner(language = 'en'): string {
  const isFr = language.startsWith('fr')
  return isFr
    ? '> ⚔️ **Balrog se bat contre toi...** tes réponses sont en cours d\'évaluation, tiens bon.\n\n'
    : '> ⚔️ **Balrog is fighting you...** evaluating your answers, hold the line.\n\n'
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
    title:    isFr ? `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} avant le merge` : `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} before merge`,
    subtitle: isFr ? '> **You shall not pass** — prouve que tu comprends tes propres changements.' : '> **You shall not pass** — prove you understand your own changes.',
    threshold: isFr ? 'Seuil' : 'Threshold',
    attempts:  isFr ? 'Tentatives restantes' : 'Attempts left',
    howto:    isFr ? '**Comment répondre :**' : '**How to answer:**',
    retry:    isFr ? 'Plus de tentatives ? Tapez `!balrog retry`.' : 'Out of attempts? Type `!balrog retry`.',
  }

  const exampleAnswers = quiz.questions.map((_, i) => `${i + 1}:A`).join(' ')
  const history = renderAttemptsHistory(quiz, language)

  const lines: string[] = []
  if (history) {
    lines.push(history.trimEnd())
    lines.push('')
  }
  lines.push(`<!-- balrog-quiz-id: ${quiz.id} -->`)
  lines.push('')
  lines.push('<details open>')
  lines.push(`<summary>${t.title}</summary>`)
  lines.push('')
  lines.push(t.subtitle)
  lines.push('')
  lines.push(`| ${t.threshold} | ${t.attempts} | Questions |`)
  lines.push(`|:---:|:---:|:---:|`)
  lines.push(`| **${quiz.passThreshold}%** | **${maxLabel}** | **${n}** |`)
  lines.push('')
  lines.push(`${t.howto} Reply with \`!balrog ${exampleAnswers}\` — separate multiple answers with a comma.`)
  if (remaining === 0) lines.push(`<sub>${t.retry}</sub>`)
  lines.push('')
  lines.push('---')
  lines.push('')
  for (const q of quiz.questions) {
    const multiTag = q.multi ? ` *(${isFr ? 'plusieurs réponses' : 'multiple answers'})* ` : ''
    lines.push(`**Q${q.id}.** ${multiTag}${q.text}`)
    lines.push('')
    lines.push(`- **A)** ${cleanOption(q.options[0])}`)
    lines.push(`- **B)** ${cleanOption(q.options[1])}`)
    lines.push(`- **C)** ${cleanOption(q.options[2])}`)
    lines.push('')
  }
  lines.push('</details>')

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

  const summaryLabel = passed
    ? (isFr ? `✅ Quiz réussi — ${score}% — vous pouvez merger !` : `✅ Quiz passed — ${score}% — you may merge!`)
    : (isFr ? `❌ Quiz échoué — ${score}% — ${attLeft}` : `❌ Quiz failed — ${score}% — ${attLeft}`)

  const lines: string[] = []
  lines.push('<details open>')
  lines.push(`<summary>${summaryLabel}</summary>`)
  lines.push('')

  if (passed) {
    lines.push(`\`${bar}\` **${score}%** — ${correctCount}/${total} ${isFr ? 'correcte(s)' : 'correct'}`)
  } else {
    lines.push(`\`${bar}\` **${score}%** — ${correctCount}/${total} ${isFr ? 'correcte(s)' : 'correct'} · ${attLeft}`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const r of perQuestion) {
    const q = quiz.questions.find((q) => q.id === r.questionId)!
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
    lines.push('')
  }

  lines.push('<!-- balrog-result -->')
  lines.push('')
  lines.push('</details>')

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
    howto:  isFr ? '**Comment répondre :** Coche tes réponses puis coche **✅ Soumettre**.' : '**How to answer:** Check your answers then check **✅ Submit my answers**.',
    multi:  isFr ? '*(plusieurs réponses)*' : '*(multiple answers)*',
    submit: isFr ? '✅ Soumettre mes réponses' : '✅ Submit my answers',
  }

  const history = renderAttemptsHistory(quiz, language)

  const lines: string[] = []
  if (history) {
    lines.push(history.trimEnd())
    lines.push('')
  }
  lines.push(`<!-- balrog-quiz-id: ${quiz.id} -->`)
  lines.push(`<!-- balrog-mode: checkbox -->`)
  lines.push('')
  lines.push('<details open>')
  lines.push(`<summary>${t.title}</summary>`)
  lines.push('')
  lines.push(t.subtitle)
  lines.push('')
  lines.push(`| ${t.threshold} | ${t.attempts} | Questions |`)
  lines.push(`|:---:|:---:|:---:|`)
  lines.push(`| **${quiz.passThreshold}%** | **${maxLabel}** | **${n}** |`)
  lines.push('')
  lines.push(t.howto)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const q of quiz.questions) {
    const qKey = String(q.id)
    const prev = previousAnswers?.[qKey] ?? []
    const multiTag = q.multi ? ` ${t.multi} ` : ''
    lines.push(`**Q${q.id}.** ${multiTag}${q.text}`)
    lines.push('')
    lines.push(`- [${prev.includes('A') ? 'x' : ' '}] **A)** ${cleanOption(q.options[0])}`)
    lines.push(`- [${prev.includes('B') ? 'x' : ' '}] **B)** ${cleanOption(q.options[1])}`)
    lines.push(`- [${prev.includes('C') ? 'x' : ' '}] **C)** ${cleanOption(q.options[2])}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(`- [ ] ${t.submit}`)
  lines.push('')
  lines.push('</details>')

  return lines.join('\n')
}

// Parses currently-checked answer options from a checkbox comment body,
// associating each A/B/C option with the nearest preceding **Qn.** heading.
export function parseCurrentSelections(body: string): SubmittedAnswers {
  const answers: SubmittedAnswers = {}
  let currentQ: string | null = null

  for (const line of body.split('\n')) {
    const qMatch = line.match(/^\*\*Q(\d+)\./)
    if (qMatch) {
      currentQ = qMatch[1]
      continue
    }
    if (currentQ) {
      const optMatch = line.match(/^- \[(x| )\] \*\*([ABC])\)/)
      if (optMatch) {
        const checked = optMatch[1].toLowerCase() === 'x'
        const letter = optMatch[2].toUpperCase() as 'A' | 'B' | 'C'
        if (!answers[currentQ]) answers[currentQ] = []
        if (checked) answers[currentQ].push(letter)
      }
    }
  }

  for (const k of Object.keys(answers)) {
    if (answers[k].length === 0) delete answers[k]
  }
  return answers
}

// Parses checkbox state from a rendered quiz comment body.
// Returns null if the submit checkbox is not checked.
export function parseCheckboxAnswers(body: string): SubmittedAnswers | null {
  if (!/- \[x\] ✅ (Submit my answers|Soumettre mes réponses)/i.test(body)) return null
  const answers = parseCurrentSelections(body)
  return Object.keys(answers).length === 0 ? null : answers
}

export function parseRetryCheckbox(body: string): boolean {
  return /- \[x\] 🔄 (Request a new quiz|Demander un nouveau quiz)/i.test(body)
}

export function renderUpdatedAt(date: Date, language = 'en'): string {
  const isFr = language.startsWith('fr')
  const ts = date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  return isFr ? `<sub>Mis à jour ${ts}</sub>` : `<sub>Updated ${ts}</sub>`
}

// Replaces the live quiz comment with a locked version after submission.
export function renderLockedQuizComment(quiz: Quiz, language = 'en'): string {
  const isFr = language.startsWith('fr')
  const n = quiz.questions.length
  const remaining = quiz.maxAttempts === 0 ? Infinity : quiz.maxAttempts - quiz.attemptsUsed
  const maxLabel = quiz.maxAttempts === 0 ? '∞' : String(remaining)

  const banner = isFr
    ? '> 🔒 **Réponses soumises** — ce quiz est verrouillé.'
    : '> 🔒 **Answers submitted** — this quiz is locked.'

  const t = {
    title:    isFr ? `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} avant le merge` : `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} before merge`,
    threshold: isFr ? 'Seuil' : 'Threshold',
    attempts:  isFr ? 'Tentatives restantes' : 'Attempts left',
    multi:    isFr ? '*(plusieurs réponses)*' : '*(multiple answers)*',
    retry_ck: isFr ? '🔄 Demander un nouveau quiz' : '🔄 Request a new quiz',
  }

  const history = renderAttemptsHistory(quiz, language)

  const lines: string[] = []
  if (history) {
    lines.push(history.trimEnd())
    lines.push('')
  }
  lines.push(`<!-- balrog-quiz-id: ${quiz.id} -->`)
  lines.push(`<!-- balrog-mode: checkbox-locked -->`)
  lines.push('')
  lines.push('<details>')
  lines.push(`<summary>${t.title} 🔒</summary>`)
  lines.push('')
  lines.push(banner)
  lines.push('')
  lines.push(`| ${t.threshold} | ${t.attempts} | Questions |`)
  lines.push(`|:---:|:---:|:---:|`)
  lines.push(`| **${quiz.passThreshold}%** | **${maxLabel}** | **${n}** |`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const q of quiz.questions) {
    const multiTag = q.multi ? ` ${t.multi} ` : ''
    lines.push(`**Q${q.id}.** ${multiTag}${q.text}`)
    lines.push('')
    lines.push(`- **A)** ${cleanOption(q.options[0])}`)
    lines.push(`- **B)** ${cleanOption(q.options[1])}`)
    lines.push(`- **C)** ${cleanOption(q.options[2])}`)
    lines.push('')
  }

  lines.push('</details>')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Regenerating + previous quiz summary
// ---------------------------------------------------------------------------

export function renderRegeneratingComment(quiz: Quiz, language = 'en'): string {
  const isFr = language.startsWith('fr')
  const n = quiz.questions.length
  const maxLabel = quiz.maxAttempts === 0 ? '∞' : String(quiz.maxAttempts)

  const banner = isFr
    ? '> 🔄 **Nouveau quiz en cours de génération...** Revenez dans quelques secondes.'
    : '> 🔄 **Generating your new quiz...** Check back in a few seconds.'

  const t = {
    title:    isFr ? `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} avant le merge` : `🔥 PR Balrog — ${n} question${n > 1 ? 's' : ''} before merge`,
    threshold: isFr ? 'Seuil' : 'Threshold',
    attempts:  isFr ? 'Tentatives' : 'Attempts',
    multi:    isFr ? '*(plusieurs réponses)*' : '*(multiple answers)*',
    prev:     isFr ? 'Questions précédentes' : 'Previous questions',
  }

  const lines: string[] = []
  lines.push(banner)
  lines.push('')
  lines.push(`<!-- balrog-quiz-id: ${quiz.id} -->`)
  lines.push(`<!-- balrog-mode: checkbox-regenerating -->`)
  lines.push('')
  lines.push('<details>')
  lines.push(`<summary>${t.title} — ${t.prev}</summary>`)
  lines.push('')
  lines.push(`| ${t.threshold} | ${t.attempts} | Questions |`)
  lines.push(`|:---:|:---:|:---:|`)
  lines.push(`| **${quiz.passThreshold}%** | **${maxLabel}** | **${n}** |`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const q of quiz.questions) {
    const multiTag = q.multi ? ` ${t.multi} ` : ''
    lines.push(`**Q${q.id}.** ${multiTag}${q.text}`)
    lines.push('')
    lines.push(`- **A)** ${cleanOption(q.options[0])}`)
    lines.push(`- **B)** ${cleanOption(q.options[1])}`)
    lines.push(`- **C)** ${cleanOption(q.options[2])}`)
    lines.push('')
  }

  lines.push('</details>')

  return lines.join('\n')
}

export function renderPreviousQuizSummary(quiz: Quiz, language = 'en'): string {
  const isFr = language.startsWith('fr')
  const n = quiz.questions.length
  const cnt = quiz.attemptsUsed
  const summaryTitle = isFr
    ? `📜 Quiz précédent — ${n} question${n > 1 ? 's' : ''} (${cnt} tentative${cnt !== 1 ? 's' : ''})`
    : `📜 Previous quiz — ${n} question${n > 1 ? 's' : ''} (${cnt} attempt${cnt !== 1 ? 's' : ''})`

  const lines: string[] = []
  lines.push('<details>')
  lines.push(`<summary>${summaryTitle}</summary>`)
  lines.push('')

  const attempts = quiz.attempts ?? []
  if (attempts.length > 0) {
    lines.push(isFr ? '**Tentatives :**' : '**Attempts:**')
    lines.push('')
    for (const a of attempts) {
      const ansStr = Object.entries(a.answers)
        .sort(([x], [y]) => Number(x) - Number(y))
        .map(([q, ans]) => `Q${q}: ${(ans as string[]).join(',')}`)
        .join(' · ')
      lines.push(`- Attempt ${a.n}: ${ansStr} — **${a.score}%**`)
    }
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  lines.push(isFr ? '**Questions et réponses correctes :**' : '**Questions and correct answers:**')
  lines.push('')

  const optionLetters: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C']
  for (const q of quiz.questions) {
    const multiTag = q.multi ? ` *(${isFr ? 'plusieurs réponses' : 'multiple answers'})* ` : ''
    lines.push(`**Q${q.id}.** ${multiTag}${q.text}`)
    lines.push('')
    for (let i = 0; i < q.options.length; i++) {
      const letter = optionLetters[i]
      const mark = q.correct.includes(letter) ? '✅' : '⬜'
      lines.push(`- ${mark} **${letter})** ${cleanOption(q.options[i])}`)
    }
    lines.push(`> 💡 ${q.explanation}`)
    lines.push('')
  }

  lines.push('</details>')
  lines.push('')

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
