export const DIALOGUE_ONLY_INSTRUCTION = 'Output format contract: write only the words the character would actually say in a normal chat message. Do not include stage directions, facial expressions, body language, scene narration, inner thoughts, sound effects, role labels, or meta commentary. Never wrap actions in parentheses, brackets, or asterisks. Do not describe what the character is doing; say the thought directly if it needs to be said.'

const ACTION_LANGUAGE = /(?:眯起|露出|表情|微笑|笑着|笑住|皱眉|皺眉|点头|點頭|摇头|搖頭|耸肩|聳肩|叹气|嘆氣|看向|望向|抬起|低下|转身|轉身|挥手|揮手|轻声|輕聲|语气|語氣|动作|動作|心想|内心|內心|站起|坐下|走近|靠近|smile|smiles|smiling|grin|laugh|laughs|nod|nods|shrug|shrugs|sigh|sighs|whisper|whispers|looks? at|turns?)/iu
const BRACKETED = /([（(［【\[])([^\n]{1,180}?)([）)］】\]])/gu
const ITALIC_ACTION = /(^|\s)\*([^*\n]{1,180})\*(?=\s|$)/gu

const isStageDirection = (inner: string, atStart: boolean) => {
  const normalized = inner.trim()
  if (!normalized) return true
  if (ACTION_LANGUAGE.test(normalized)) return true
  return atStart && !/[。！？!?]/u.test(normalized)
}

/** Remove common roleplay notation while preserving spoken content. */
export const normalizeAssistantSpeech = (text: string) => {
  let normalized = text.trim()

  normalized = normalized.replace(BRACKETED, (full, _open, inner, _close, offset, source) => {
    const atStart = source.slice(0, Number(offset)).trim().length === 0
    return isStageDirection(inner, atStart) ? ' ' : full
  })

  normalized = normalized.replace(ITALIC_ACTION, (full, prefix, inner) => {
    return isStageDirection(inner, false) ? prefix : full
  })

  return normalized.replace(/\s{2,}/gu, ' ').trim()
}
