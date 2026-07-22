import assert from 'node:assert/strict'
import { closeDatabase, query } from './database'
import { prepareInteraction, recordAssistantResponse } from './behavior'
import { buildInferencePlan } from './inference-orchestrator'
import { processDueProactiveActions } from './proactive-service'
import {
  createConversationWithStarter,
  getCharacter,
  newId
} from './repository'
import { Conversation, Message } from './types'

const run = async () => {
  const userId = `proactive-integration-${Date.now()}`
  const previousMode = process.env.DEEPSEEK_API_MODE
  process.env.DEEPSEEK_API_MODE = 'mock'

  try {
    const character = await getCharacter('c3')
    assert.ok(character, 'Maya must be imported before running the integration test')
    const createdAt = new Date(Date.now() - 10_000)
    const conversation: Conversation = {
      id: newId(),
      userId,
      characterId: character.id,
      title: 'Maya integration test',
      status: 'active',
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString()
    }
    const starter: Message = {
      id: newId(),
      conversationId: conversation.id,
      senderRole: 'assistant',
      senderId: character.id,
      content: 'Hey, come keep me company for a minute?',
      createdAt: createdAt.toISOString()
    }
    await createConversationWithStarter(conversation, starter)

    const userMessageId = newId()
    const preparation = await prepareInteraction({
      userId,
      character,
      conversationId: conversation.id,
      messageId: userMessageId,
      message: 'How was your day at school?',
      mode: 'companion',
      now: new Date(createdAt.getTime() + 1000)
    })
    const inference = await buildInferencePlan({
      userId,
      character,
      conversationId: conversation.id,
      currentMessageId: userMessageId,
      message: 'How was your day at school?',
      mode: 'companion',
      snapshot: preparation.snapshot,
      memoryEnabled: preparation.memoryEnabled,
      decision: preparation.decision
    })
    await recordAssistantResponse({
      userId,
      character,
      conversationId: conversation.id,
      messageId: newId(),
      decisionId: preparation.decisionId,
      triggerEventId: preparation.triggerEventId,
      mode: 'companion',
      content: 'Long, but anatomy was actually interesting today.',
      inference,
      now: new Date(createdAt.getTime() + 2000)
    })

    const instanceBefore = await query(
      `SELECT id, next_action_at
       FROM character_instances
       WHERE user_id = $1 AND character_id = $2`,
      [userId, character.id]
    )
    assert.ok(instanceBefore.rows[0]?.next_action_at)
    const dueAt = new Date(createdAt.getTime() + 60 * 60_000)
    await query(
      'UPDATE character_instances SET next_action_at = $2 WHERE id = $1',
      [instanceBefore.rows[0].id, dueAt.toISOString()]
    )

    const deliveries = await processDueProactiveActions({
      userId,
      limit: 1,
      now: new Date(dueAt.getTime() + 1000)
    })
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].characterId, character.id)
    assert.equal(deliveries[0].conversationId, conversation.id)

    const proactiveMessages = await query(
      `SELECT content, content_json
       FROM messages
       WHERE conversation_id = $1
         AND content_json ->> 'origin' = 'proactive'`,
      [conversation.id]
    )
    assert.equal(proactiveMessages.rows.length, 1)
    assert.equal(proactiveMessages.rows[0].content_json?.proactive?.attempt, 1)

    const audit = await query(
      `SELECT action
       FROM decision_records
       WHERE conversation_id = $1 AND action = 'initiate_conversation'`,
      [conversation.id]
    )
    assert.equal(audit.rows.length, 1)

    const instanceAfter = await query(
      `SELECT ci.next_action_at, sc.local_timezone
       FROM character_instances ci
       JOIN simulation_cursors sc ON sc.instance_id = ci.id
       WHERE ci.id = $1`,
      [instanceBefore.rows[0].id]
    )
    assert.ok(instanceAfter.rows[0]?.next_action_at)
    assert.equal(instanceAfter.rows[0]?.local_timezone, 'America/New_York')

    console.log('proactive service integration checks passed')
  } finally {
    await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined)
    if (previousMode === undefined) delete process.env.DEEPSEEK_API_MODE
    else process.env.DEEPSEEK_API_MODE = previousMode
    await closeDatabase()
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
