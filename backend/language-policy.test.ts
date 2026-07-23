import assert from 'node:assert/strict'
import {
  assessResponseLanguage,
  isResponseLanguageCompliant,
  resolveResponseLanguagePolicy
} from './language-policy'
import { diagnoseInferenceOutput, InferencePlan } from './inference-orchestrator'

const cantonese = resolveResponseLanguagePolicy('Cantonese only')

assert.equal(isResponseLanguageCompliant('我喺度呀，你想講咩？', cantonese), true)
assert.equal(isResponseLanguageCompliant('我想丢你', cantonese), true)
assert.equal(isResponseLanguageCompliant('我在这里，你想聊什么？', cantonese), false)
assert.equal(isResponseLanguageCompliant('我在这儿，你想和我聊天吗？', cantonese), false)
assert.equal(isResponseLanguageCompliant('I am here for you.', cantonese), false)
assert.equal(assessResponseLanguage('我想丢你', cantonese).reason, 'ambiguous_cjk')

const plan = {
  route: 'model',
  responseLanguage: cantonese,
  responseStyle: { turnPriority: 'conversation' },
  messages: [{ role: 'user', content: '我想丢你' }],
  mode: 'companion'
} as InferencePlan

const ambiguousOutput = diagnoseInferenceOutput(plan, '我想丢你')
assert.equal(ambiguousOutput.accepted, true)
assert.equal(ambiguousOutput.reply, '我想丢你')
assert.equal(ambiguousOutput.languageReason, 'ambiguous_cjk')

const roleplayOutput = diagnoseInferenceOutput(plan, '（眯起眼，露出好奇嘅表情）你想丢我？')
assert.equal(roleplayOutput.accepted, true)
assert.equal(roleplayOutput.sanitized, true)
assert.equal(roleplayOutput.reply, '你想丢我？')

const mandarinOutput = diagnoseInferenceOutput(plan, '我在这里，你想聊什么？')
assert.equal(mandarinOutput.accepted, true)
assert.equal(mandarinOutput.languageCompliant, false)
assert.equal(mandarinOutput.languageObservation.likelyCause, 'dialect_drift')
assert.equal(mandarinOutput.reply, '我在这里，你想聊什么？')

const emptyOutput = diagnoseInferenceOutput(plan, '')
assert.equal(emptyOutput.accepted, false)
assert.equal(emptyOutput.rejectionReason, 'empty_provider_output')
assert.equal(emptyOutput.reply, null)

const codeSwitchedOutput = diagnoseInferenceOutput(plan, '我而家 working，陣間覆你。')
assert.equal(codeSwitchedOutput.accepted, true)
assert.equal(codeSwitchedOutput.languageReason, 'cantonese_code_switch')
assert.equal(codeSwitchedOutput.reply, '我而家 working，陣間覆你。')

const actualRejectedOutput = diagnoseInferenceOutput(
  plan,
  '我仲玩紧我个学粤语嘅app啊，你又丢我，点知你咁认真嘅。'
)
assert.equal(actualRejectedOutput.accepted, true)
assert.equal(actualRejectedOutput.languageReason, 'cantonese_code_switch')

const englishDominantOutput = diagnoseInferenceOutput(
  plan,
  '我係 actually working on a very important application today'
)
assert.equal(englishDominantOutput.accepted, true)
assert.equal(englishDominantOutput.languageCompliant, false)
assert.equal(englishDominantOutput.languageReason, 'latin_contamination')
assert.equal(englishDominantOutput.languageObservation.detection, 'substantial_english_in_chinese_context')
assert.equal(englishDominantOutput.languageObservation.likelyCause, 'model_language_drift')
assert.equal(englishDominantOutput.reply, '我係 actually working on a very important application today')

const english = resolveResponseLanguagePolicy('English only')
const englishPlan = {
  route: 'model',
  responseLanguage: english,
  responseStyle: { turnPriority: 'language_help' },
  messages: [{
    role: 'user',
    content: 'And all the times I dont know which 介词 I should use'
  }],
  mode: 'practice'
} as InferencePlan

const sourceQuoteOutput = diagnoseInferenceOutput(
  englishPlan,
  'The English term for 介词 is "preposition." Which prepositions feel hardest to use?'
)
assert.equal(sourceQuoteOutput.accepted, true)
assert.equal(sourceQuoteOutput.languageReason, 'english_source_quote')

const unrelatedChineseOutput = diagnoseInferenceOutput(
  englishPlan,
  'The English term is "preposition." 我们可以继续用中文解释。'
)
assert.equal(unrelatedChineseOutput.accepted, true)
assert.equal(unrelatedChineseOutput.languageCompliant, false)
assert.equal(unrelatedChineseOutput.languageReason, 'cjk_contamination')
assert.equal(unrelatedChineseOutput.reply, 'The English term is "preposition." 我们可以继续用中文解释。')

const longSourceQuoteOutput = diagnoseInferenceOutput(
  {
    ...englishPlan,
    messages: [{
      role: 'user',
      content: '我总是不知道英语里面应该使用哪个介词'
    }]
  } as InferencePlan,
  'You wrote: 我总是不知道英语里面应该使用哪个介词. Let us work through it.'
)
assert.equal(longSourceQuoteOutput.accepted, true)
assert.equal(longSourceQuoteOutput.languageCompliant, false)
assert.equal(longSourceQuoteOutput.languageReason, 'cjk_contamination')

const actualEnglishTeacherOutput = diagnoseInferenceOutput(
  englishPlan,
  'Right, that is a very common challenge. The English term is "preposition," not 介词. Prepositions are tricky even for advanced learners. Do you have a specific example where you often feel unsure?'
)
assert.equal(actualEnglishTeacherOutput.accepted, true)
assert.equal(actualEnglishTeacherOutput.languageCompliant, true)
assert.equal(actualEnglishTeacherOutput.languageReason, 'english_source_quote')
assert.equal(actualEnglishTeacherOutput.languageObservation.likelyCause, 'source_term_reference')

const korean = resolveResponseLanguagePolicy('Korean only; understands English input')
assert.equal(korean.code, 'korean')
assert.equal(korean.locale, 'ko-KR')
assert.equal(korean.strict, true)
assert.equal(isResponseLanguageCompliant('오늘 선형대수 수업 진짜 어려웠어.', korean), true)
assert.equal(isResponseLanguageCompliant('I understood the homework.', korean), false)
assert.equal(
  assessResponseLanguage('I understood the homework and the lecture.', korean).reason,
  'not_korean'
)

const japanese = resolveResponseLanguagePolicy('Japanese only; understands English input')
assert.equal(japanese.code, 'japanese')
assert.equal(japanese.locale, 'ja-JP')
assert.equal(isResponseLanguageCompliant('今日の解析の授業、かなり難しかった。', japanese), true)
assert.equal(isResponseLanguageCompliant('오늘 수업 어려웠어.', japanese), false)

console.log('language policy checks passed')
