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
assert.equal(mandarinOutput.accepted, false)
assert.equal(mandarinOutput.rejectionReason, 'language_violation')
assert.equal(mandarinOutput.reply, null)

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
assert.equal(englishDominantOutput.accepted, false)
assert.equal(englishDominantOutput.languageReason, 'latin_contamination')

console.log('language policy checks passed')
