import assert from 'node:assert/strict'
import { closeDatabase } from './database'
import { resolveCharacterMode, timeZoneForCharacter } from './behavior'
import { deriveProactivePolicy } from './proactive-policy'
import { Character } from './types'

const arjun: Character = {
  id: 'seed-arjun-client',
  name: 'Arjun Mehta',
  role: 'Demanding Indian procurement client for commercial drones',
  company: 'AeroVista Distribution, Bengaluru (fictional)',
  personality: 'Commercially sharp, skeptical, price-sensitive, and concise.',
  scenario: 'A realistic B2B sales negotiation practice with a Shenzhen drone seller.',
  goal: 'Evaluate a lawful, low-risk procurement agreement.',
  language: 'English only',
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z'
}

const minjun: Character = {
  ...arjun,
  id: 'seed-minjun-friend',
  name: '민준',
  role: 'Korean international student friend and first-year mathematics major',
  company: 'Beijing Normal University',
  scenario: 'Campus friendship at Beijing Normal University.',
  goal: 'Share student life without turning every chat into tutoring.',
  language: 'Korean only; understands English input',
  background: 'A Korean international student living and studying in Beijing.',
  systemPromptTemplate: 'Help with mathematics naturally, but do not act like a tutor by default.'
}

const ren: Character = {
  ...minjun,
  id: 'seed-ren-friend',
  name: '蓮',
  role: 'Japanese international student friend and third-year mathematics major',
  language: 'Japanese only; understands English input'
}

const teacher: Character = {
  ...arjun,
  id: 'teacher',
  name: 'English Teacher',
  role: 'English Teacher',
  scenario: 'English practice for developers'
}

assert.equal(resolveCharacterMode(arjun), 'companion')
assert.equal(timeZoneForCharacter(arjun), 'Asia/Kolkata')
assert.equal(deriveProactivePolicy(arjun).enabled, false)
assert.equal(resolveCharacterMode(minjun), 'companion')
assert.equal(resolveCharacterMode(ren), 'companion')
assert.equal(timeZoneForCharacter(minjun), 'Asia/Shanghai')
assert.equal(timeZoneForCharacter(ren), 'Asia/Shanghai')
assert.equal(resolveCharacterMode(teacher), 'practice')

console.log('character policy checks passed')
void closeDatabase()
