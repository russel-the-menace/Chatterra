import Ionicons from '@expo/vector-icons/Ionicons'
import * as Clipboard from 'expo-clipboard'
import { router, useLocalSearchParams } from 'expo-router'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ActivityIndicator,
  Alert,
  Animated as RNAnimated,
  Easing,
  FlatList,
  LayoutChangeEvent,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native'
import Reanimated, {
  cancelAnimation,
  Easing as ReanimatedEasing,
  scrollTo,
  useAnimatedKeyboard,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'

import { Avatar } from '@/components/avatar'
import { api } from '@/src/api'
import { useChat } from '@/src/chat-context'
import { starterMessageForCharacter } from '@/src/starter-message'
import { palette } from '@/src/theme'
import { ChatMessage, ChatResponse, ServerMessage } from '@/src/types'

const createLocalId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

const LATEST_SCROLL_DURATION_MS = 280
const MESSAGE_ROW_GAP = 14
const LATEST_MESSAGE_COMPOSER_GAP = 15
// The final row margin and list padding together form the visible composer gap.
const MESSAGE_LIST_BOTTOM_PADDING = LATEST_MESSAGE_COMPOSER_GAP - MESSAGE_ROW_GAP

const deliverySegments = (message: ServerMessage): string[] => {
  const stored = message.contentJson?.deliverySegments
  if (message.senderRole === 'assistant' && Array.isArray(stored)) {
    const segments = stored.filter((segment): segment is string => (
      typeof segment === 'string' && Boolean(segment.trim())
    ))
    if (segments.length > 0) return segments
  }
  return [message.content]
}

const mapMessages = (messages: ServerMessage[]): ChatMessage[] => messages
  .filter(message => message.senderRole !== 'system')
  .flatMap(message => {
    const segments = deliverySegments(message)
    const translations = message.contentJson?.translations
    const englishTranslations = translations && typeof translations === 'object'
      ? (translations as Record<string, unknown>).en
      : undefined
    return segments.map((text, index) => ({
      id: segments.length === 1 ? message.id : `${message.id}:segment:${index}`,
      sourceMessageId: message.id,
      segmentIndex: index,
      sender: message.senderRole === 'user' ? 'user' as const : 'assistant' as const,
      text,
      translation: englishTranslations && typeof englishTranslations === 'object'
        && typeof (englishTranslations as Record<string, unknown>)[String(index)] === 'string'
        ? String((englishTranslations as Record<string, unknown>)[String(index)])
        : undefined,
      translationVisible: Boolean(
        englishTranslations && typeof englishTranslations === 'object'
          && typeof (englishTranslations as Record<string, unknown>)[String(index)] === 'string'
      ),
      groupIndex: index,
      groupSize: segments.length,
      createdAt: message.createdAt,
    }))
  })

const mergeMessageUiState = (current: ChatMessage[], incoming: ChatMessage[]) => {
  const currentById = new Map(current.map(message => [message.id, message]))
  return incoming.map(message => {
    const existing = currentById.get(message.id)
    if (!existing) return message
    return {
      ...message,
      translation: existing.translation || message.translation,
      translationVisible: existing.translation !== undefined
        || existing.translationLoading
        || existing.translationError
        ? existing.translationVisible
        : message.translationVisible,
      translationLoading: existing.translationLoading,
      translationError: existing.translationError,
    }
  })
}

const responseMessages = (response: ChatResponse): ChatMessage[] => {
  const stored = Array.isArray(response.replySegments)
    ? response.replySegments.filter((segment): segment is string => (
        typeof segment === 'string' && Boolean(segment.trim())
      ))
    : []
  const segments = stored.length > 0
    ? stored
    : typeof response.reply === 'string' ? [response.reply] : []
  const baseId = response.messageId || createLocalId()
  return segments.map((text, index) => ({
    id: segments.length === 1 ? baseId : `${baseId}:segment:${index}`,
    sourceMessageId: baseId,
    segmentIndex: index,
    sender: 'assistant',
    text,
    groupIndex: index,
    groupSize: segments.length,
    animateEntry: true,
    animationDelayMs: 0,
  }))
}

const simulatedTypingDuration = (text: string) => {
  const characters = Array.from(text.trim()).length
  const words = text.trim().split(/\s+/u).filter(Boolean).length
  return Math.round(Math.min(3600, Math.max(850, 620 + words * 70 + characters * 12)))
}

const formatActivity = (activity?: string) => {
  if (!activity) return 'Online'
  const normalized = activity.replace(/_/g, ' ')
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function TypingIndicator() {
  const phase = useRef(new RNAnimated.Value(0)).current

  useEffect(() => {
    const animation = RNAnimated.loop(RNAnimated.timing(phase, {
      toValue: 1,
      duration: 900,
      easing: Easing.linear,
      useNativeDriver: true,
    }))
    animation.start()
    return () => animation.stop()
  }, [phase])

  return (
    <View style={styles.typingIndicator} accessibilityLabel="Typing">
      {[0, 1, 2].map(index => {
        const start = 0.02 + index * 0.16
        return (
          <RNAnimated.View
            key={index}
            style={[
              styles.typingDot,
              {
                opacity: phase.interpolate({
                  inputRange: [0, start, start + 0.14, start + 0.28, 1],
                  outputRange: [0.35, 0.35, 1, 0.35, 0.35],
                }),
                transform: [{
                  translateY: phase.interpolate({
                    inputRange: [0, start, start + 0.14, start + 0.28, 1],
                    outputRange: [0, 0, -3, 0, 0],
                  }),
                }],
              },
            ]}
          />
        )
      })}
    </View>
  )
}

function MessageRow({
  message,
  characterName,
  characterAvatar,
  onEditCharacter,
  onLongPress,
}: {
  message: ChatMessage
  characterName: string
  characterAvatar?: string
  onEditCharacter: () => void
  onLongPress: (message: ChatMessage, pageX: number, pageY: number) => void
}) {
  const isUser = message.sender === 'user'
  const isContinuation = !isUser && (message.groupIndex || 0) > 0
  const hasFollowingSegment = (message.groupIndex || 0) < (message.groupSize || 1) - 1
  const entryProgress = useRef(new RNAnimated.Value(message.animateEntry ? 0 : 1)).current

  useEffect(() => {
    if (!message.animateEntry) return
    RNAnimated.timing(entryProgress, {
      toValue: 1,
      duration: 230,
      delay: message.animationDelayMs || 0,
      useNativeDriver: true,
    }).start()
  }, [entryProgress, message.animateEntry, message.animationDelayMs])

  return (
    <RNAnimated.View
      style={[
        styles.messageRow,
        isUser ? styles.messageRowUser : styles.messageRowAssistant,
        hasFollowingSegment && styles.messageRowGrouped,
        {
          opacity: entryProgress,
          transform: [{
            translateY: entryProgress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }),
          }],
        },
      ]}
    >
      {!isUser && !isContinuation && (
        <Pressable onPress={onEditCharacter} accessibilityLabel={`Edit ${characterName}`}>
          <Avatar avatar={characterAvatar} name={characterName} size={34} />
        </Pressable>
      )}
      {isContinuation && <View style={styles.avatarSpacer} />}
      <View style={[styles.messageContent, isUser && styles.messageContentUser]}>
        {!isUser && !isContinuation && (
          <Pressable onPress={onEditCharacter} hitSlop={5}>
            <Text style={styles.messageAuthor}>{characterName}</Text>
          </Pressable>
        )}
        <Pressable
          delayLongPress={280}
          disabled={message.loading}
          onLongPress={event => onLongPress(
            message,
            event.nativeEvent.pageX,
            event.nativeEvent.pageY
          )}
          style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}
        >
          {message.loading ? (
            <TypingIndicator />
          ) : (
            <Text style={[styles.messageText, isUser && styles.userMessageText]}>
              {message.text}
            </Text>
          )}
        </Pressable>
        {message.translationVisible && (message.translationLoading || message.translation || message.translationError) && (
          <View style={styles.translationBox}>
            {message.translationLoading ? (
              <View style={styles.translationLoadingRow}>
                <ActivityIndicator size="small" color={palette.textMuted} />
                <Text style={styles.translationMeta}>Translating...</Text>
              </View>
            ) : (
              <Text style={[
                styles.translationText,
                message.translationError && styles.translationErrorText,
              ]}>
                {message.translationError || message.translation}
              </Text>
            )}
          </View>
        )}
      </View>
      {isUser && <Avatar name="Me" avatar="Me" size={34} muted />}
    </RNAnimated.View>
  )
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ characterId: string | string[] }>()
  const characterId = Array.isArray(params.characterId) ? params.characterId[0] : params.characterId
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const {
    ready,
    userId,
    characters,
    conversationVersions,
    conversationIdsByCharacter,
    getDraft,
    setDraft,
    setActiveCharacter,
    pinnedCharacterIds,
    setCharacterPinned,
    getConversationCache,
    setConversationCache,
    clearConversationCache,
  } = useChat()
  const character = useMemo(
    () => characters.find(item => item.id === characterId),
    [characterId, characters]
  )
  const draft = characterId ? getDraft(characterId) : ''
  const initialCacheRef = useRef(characterId ? getConversationCache(characterId) : undefined)
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialCacheRef.current?.messages || [])
  const [conversationId, setConversationId] = useState<string | null>(
    initialCacheRef.current?.conversationId || null
  )
  const [activity, setActivity] = useState('Online')
  const [loadingHistory, setLoadingHistory] = useState(!initialCacheRef.current)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showScrollToLatest, setShowScrollToLatest] = useState(false)
  const [messageActionMenu, setMessageActionMenu] = useState<{
    message: ChatMessage
    pageX: number
    pageY: number
  } | null>(null)
  const listRef = useAnimatedRef<FlatList<ChatMessage>>()
  const messagesRef = useRef(messages)
  const historyRequestRef = useRef(0)
  const sendingRef = useRef(false)
  const withinImmersiveRangeRef = useRef(true)
  const followLatestRef = useRef(true)
  const unseenLatestRef = useRef(false)
  const manualScrollRef = useRef(false)
  const initialScrollRef = useRef(true)
  const initialScrollScheduledRef = useRef(false)
  const initialScrollFrameRef = useRef<number | null>(null)
  const scrollMetricsRef = useRef({
    contentHeight: 0,
    offsetY: 0,
    viewportHeight: 0,
  })
  const keyboard = useAnimatedKeyboard()
  const scrollContentHeight = useSharedValue(0)
  const scrollViewportHeight = useSharedValue(0)
  const latestScrollStartOffset = useSharedValue(0)
  const latestScrollProgress = useSharedValue(1)
  const latestScrollActive = useSharedValue(false)
  const latestScrollPinned = useSharedValue(false)
  const keyboardLift = useDerivedValue(
    () => Math.max(0, keyboard.height.value - insets.bottom + 8),
    [insets.bottom]
  )
  const composerKeyboardAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{
      translateY: -keyboardLift.value,
    }],
  }))
  const messageListKeyboardAnimatedStyle = useAnimatedStyle(() => {
    // Keep short transcripts at the top; consume their empty space before lifting the list.
    const unusedListSpace = Math.max(
      0,
      scrollViewportHeight.value - scrollContentHeight.value
    )
    return {
      transform: [{
        translateY: -Math.max(0, keyboardLift.value - unusedListSpace),
      }],
    }
  })
  const stagedDeliveryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  useAnimatedReaction(
    () => ({
      active: latestScrollActive.value,
      contentHeight: scrollContentHeight.value,
      pinned: latestScrollPinned.value,
      progress: latestScrollProgress.value,
      startOffset: latestScrollStartOffset.value,
      viewportHeight: scrollViewportHeight.value,
    }),
    state => {
      if (!state.active || state.viewportHeight <= 0) return
      const latestOffset = Math.max(0, state.contentHeight - state.viewportHeight)
      const animatedOffset = state.startOffset
        + (latestOffset - state.startOffset) * state.progress
      const targetOffset = state.pinned
        ? latestOffset
        : Math.max(0, Math.min(latestOffset, animatedOffset))
      scrollTo(listRef, 0, targetOffset, false)
    }
  )

  const hideScrollToLatest = useCallback(() => {
    if (!unseenLatestRef.current) return
    unseenLatestRef.current = false
    setShowScrollToLatest(false)
  }, [])

  const showLatestMessageButton = useCallback(() => {
    if (unseenLatestRef.current) return
    unseenLatestRef.current = true
    setShowScrollToLatest(true)
  }, [])

  const startLatestScroll = useCallback((pinToLatest = false) => {
    manualScrollRef.current = false
    followLatestRef.current = true
    hideScrollToLatest()
    latestScrollStartOffset.value = Math.max(0, scrollMetricsRef.current.offsetY)
    latestScrollPinned.value = pinToLatest
    latestScrollActive.value = true
    cancelAnimation(latestScrollProgress)
    latestScrollProgress.value = 0
    latestScrollProgress.value = withTiming(1, {
      duration: LATEST_SCROLL_DURATION_MS,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    })
  }, [
    hideScrollToLatest,
    latestScrollActive,
    latestScrollPinned,
    latestScrollProgress,
    latestScrollStartOffset,
  ])

  const prepareForIncomingMessage = useCallback(() => {
    if (withinImmersiveRangeRef.current || followLatestRef.current) {
      startLatestScroll(withinImmersiveRangeRef.current)
      return
    }
    showLatestMessageButton()
  }, [showLatestMessageButton, startLatestScroll])

  const handleComposerFocus = useCallback(() => {
    if (initialScrollFrameRef.current !== null) {
      cancelAnimationFrame(initialScrollFrameRef.current)
      initialScrollFrameRef.current = null
    }
    initialScrollRef.current = false
    initialScrollScheduledRef.current = false
    startLatestScroll(withinImmersiveRangeRef.current)
  }, [startLatestScroll])

  const scrollToExactLatest = useCallback(() => {
    const { contentHeight, viewportHeight } = scrollMetricsRef.current
    if (contentHeight <= 0 || viewportHeight <= 0) return false
    // VirtualizedList.scrollToEnd approximates dynamic cell frames and can overscroll on mount.
    const offset = Math.max(0, contentHeight - viewportHeight)
    listRef.current?.scrollToOffset({ offset, animated: false })
    scrollMetricsRef.current.offsetY = offset
    return true
  }, [listRef])

  const settleInitialScroll = useCallback(() => {
    if (!initialScrollRef.current || initialScrollScheduledRef.current) return
    if (!scrollToExactLatest()) return
    initialScrollScheduledRef.current = true
    initialScrollFrameRef.current = requestAnimationFrame(() => {
      scrollToExactLatest()
      initialScrollFrameRef.current = requestAnimationFrame(() => {
        scrollToExactLatest()
        initialScrollRef.current = false
        initialScrollScheduledRef.current = false
        initialScrollFrameRef.current = null
      })
    })
  }, [scrollToExactLatest])

  const scheduleDeliveryTask = useCallback((task: () => void, delay: number) => {
    const timer = setTimeout(() => {
      stagedDeliveryTimersRef.current.delete(timer)
      task()
    }, delay)
    stagedDeliveryTimersRef.current.add(timer)
  }, [])

  const stageAssistantMessages = useCallback((
    loadingId: string,
    incomingMessages: ChatMessage[]
  ) => {
    const firstMessage = incomingMessages[0]
    if (!firstMessage) return

    const followIncoming = () => prepareForIncomingMessage()

    followIncoming()
    setMessages(current => current.flatMap(message => (
      message.id === loadingId ? [firstMessage] : [message]
    )))

    const queueMessage = (index: number) => {
      const nextMessage = incomingMessages[index]
      const previousMessage = incomingMessages[index - 1]
      if (!nextMessage || !previousMessage) return

      scheduleDeliveryTask(() => {
        const typingId = `${nextMessage.id}:typing`
        const typingMessage: ChatMessage = {
          id: typingId,
          sender: 'assistant',
          text: '',
          loading: true,
          groupIndex: nextMessage.groupIndex,
          groupSize: nextMessage.groupSize,
          animateEntry: true,
        }
        followIncoming()
        setMessages(current => {
          if (current.some(message => message.id === typingId || message.id === nextMessage.id)) {
            return current
          }
          const previousIndex = current.findIndex(message => message.id === previousMessage.id)
          if (previousIndex < 0) return current
          return [
            ...current.slice(0, previousIndex + 1),
            typingMessage,
            ...current.slice(previousIndex + 1),
          ]
        })

        scheduleDeliveryTask(() => {
          followIncoming()
          setMessages(current => current.map(message => (
            message.id === typingId ? nextMessage : message
          )))
          queueMessage(index + 1)
        }, simulatedTypingDuration(nextMessage.text))
      }, 220)
    }

    queueMessage(1)
  }, [prepareForIncomingMessage, scheduleDeliveryTask])

  useEffect(() => () => {
    if (initialScrollFrameRef.current !== null) {
      cancelAnimationFrame(initialScrollFrameRef.current)
    }
    latestScrollActive.value = false
    cancelAnimation(latestScrollProgress)
    stagedDeliveryTimersRef.current.forEach(timer => clearTimeout(timer))
    stagedDeliveryTimersRef.current.clear()
  }, [latestScrollActive, latestScrollProgress])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    if (!characterId) return
    unseenLatestRef.current = false
    setShowScrollToLatest(false)
    setActiveCharacter(characterId)
    return () => setActiveCharacter(null)
  }, [characterId, setActiveCharacter])

  const refreshState = useCallback(async () => {
    if (!userId || !characterId) return
    try {
      const state = await api.getCharacterState(userId, characterId)
      setActivity(formatActivity(state.currentActivity))
    } catch {
      // Activity is supplementary; chat remains available when this request fails.
    }
  }, [characterId, userId])

  const loadConversation = useCallback(async (quiet = false) => {
    if (!userId || !character) return
    const requestId = historyRequestRef.current + 1
    historyRequestRef.current = requestId
    if (!quiet) setLoadingHistory(true)

    try {
      const conversations = await api.listConversations(userId)
      const matching = conversations
        .filter(conversation => conversation.characterId === character.id)
        .sort((left, right) => (
          (right.lastMessageAt || right.updatedAt || right.createdAt)
            .localeCompare(left.lastMessageAt || left.updatedAt || left.createdAt)
        ))[0]

      if (requestId !== historyRequestRef.current) return
      if (initialScrollFrameRef.current !== null) {
        cancelAnimationFrame(initialScrollFrameRef.current)
        initialScrollFrameRef.current = null
      }
      if (!quiet) {
        latestScrollActive.value = false
        cancelAnimation(latestScrollProgress)
        initialScrollRef.current = true
        initialScrollScheduledRef.current = false
        followLatestRef.current = true
        withinImmersiveRangeRef.current = true
        hideScrollToLatest()
      }

      if (!matching) {
        setConversationId(null)
        const starterMessages: ChatMessage[] = [{
          id: `starter-${character.id}`,
          sender: 'assistant',
          text: starterMessageForCharacter(character),
        }]
        setMessages(starterMessages)
        setConversationCache(character.id, {
          conversationId: null,
          messages: starterMessages,
          cachedAt: Date.now(),
        })
      } else {
        const serverMessages = await api.listMessages(matching.id)
        if (requestId !== historyRequestRef.current) return
        const cachedMessages = getConversationCache(character.id)?.messages || []
        const mappedMessages = mergeMessageUiState(cachedMessages, mapMessages(serverMessages))
        if (quiet) {
          const existingIds = new Set(messagesRef.current.map(message => message.id))
          const hasNewAssistantMessage = mappedMessages.some(message => (
            message.sender === 'assistant' && !existingIds.has(message.id)
          ))
          if (hasNewAssistantMessage) prepareForIncomingMessage()
        }
        setConversationId(matching.id)
        setMessages(mappedMessages)
        setConversationCache(character.id, {
          conversationId: matching.id,
          messages: mappedMessages,
          cachedAt: Date.now(),
        })
      }
      setError(null)
    } catch (loadError) {
      if (requestId !== historyRequestRef.current) return
      setError(loadError instanceof Error ? loadError.message : 'Could not load this conversation.')
    } finally {
      if (requestId === historyRequestRef.current) setLoadingHistory(false)
    }
  }, [
    character,
    getConversationCache,
    hideScrollToLatest,
    latestScrollActive,
    latestScrollProgress,
    prepareForIncomingMessage,
    setConversationCache,
    userId,
  ])

  useEffect(() => {
    if (!character || !userId) return
    void loadConversation(Boolean(getConversationCache(character.id)))
    void refreshState()
  }, [character, getConversationCache, loadConversation, refreshState, userId])

  useEffect(() => {
    if (!characterId || loadingHistory || messages.some(message => message.loading)) return
    setConversationCache(characterId, {
      conversationId,
      messages,
      cachedAt: Date.now(),
    })
  }, [characterId, conversationId, loadingHistory, messages, setConversationCache])

  useEffect(() => {
    if (!loadingHistory && messages.length > 0) settleInitialScroll()
  }, [loadingHistory, messages.length, settleInitialScroll])

  const syncMessages = useCallback(async () => {
    if (!conversationId || sendingRef.current) return
    try {
      const serverMessages = await api.listMessages(conversationId)
      const mapped = mapMessages(serverMessages)
      const currentMessages = messagesRef.current
      if (currentMessages.some(message => message.loading)
        || stagedDeliveryTimersRef.current.size > 0) {
        return
      }
      const knownIds = new Set(currentMessages.map(message => message.id))
      if (mapped.some(message => message.sender === 'assistant' && !knownIds.has(message.id))) {
        prepareForIncomingMessage()
      }
      setMessages(current => {
        if (current.some(message => message.loading) || stagedDeliveryTimersRef.current.size > 0) {
          return current
        }
        const existingIds = new Set(current.map(message => message.id))
        let animationIndex = 0
        const next = mergeMessageUiState(current, mapped).map(message => {
          if (message.sender !== 'assistant' || existingIds.has(message.id)) return message
          const animatedMessage = {
            ...message,
            animateEntry: true,
            animationDelayMs: animationIndex * 90,
          }
          animationIndex += 1
          return animatedMessage
        })
        return next
      })
    } catch {
      // Keep the current local transcript while connectivity recovers.
    }
  }, [conversationId, prepareForIncomingMessage])

  useEffect(() => {
    if (!conversationId) return
    const interval = setInterval(() => void syncMessages(), 15_000)
    return () => clearInterval(interval)
  }, [conversationId, syncMessages])

  const proactiveVersion = characterId ? conversationVersions[characterId] || 0 : 0
  const syncedConversationId = characterId ? conversationIdsByCharacter[characterId] || null : null
  const previousProactiveVersionRef = useRef(proactiveVersion)
  useEffect(() => {
    if (previousProactiveVersionRef.current === proactiveVersion) return
    if (sendingRef.current || stagedDeliveryTimersRef.current.size > 0) return
    previousProactiveVersionRef.current = proactiveVersion
    if (conversationId && syncedConversationId === conversationId) {
      void syncMessages()
    } else {
      void loadConversation(true)
    }
  }, [conversationId, loadConversation, proactiveVersion, sending, syncedConversationId, syncMessages])

  const openEditor = () => {
    if (!characterId) return
    router.push({ pathname: '/character/[characterId]', params: { characterId } })
  }

  const clearHistory = async () => {
    if (!userId || !character) return
    try {
      await api.clearHistory(userId, character.id)
      clearConversationCache(character.id)
      setConversationId(null)
      setMessages([{
        id: `starter-${character.id}-${Date.now()}`,
        sender: 'assistant',
        text: starterMessageForCharacter(character),
      }])
      if (initialScrollFrameRef.current !== null) {
        cancelAnimationFrame(initialScrollFrameRef.current)
        initialScrollFrameRef.current = null
      }
      initialScrollRef.current = true
      initialScrollScheduledRef.current = false
      latestScrollActive.value = false
      cancelAnimation(latestScrollProgress)
      hideScrollToLatest()
      setError(null)
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Could not clear the conversation.')
    }
  }

  const showConversationActions = () => {
    if (!character) return
    const pinned = pinnedCharacterIds.has(character.id)
    Alert.alert(character?.name || 'Conversation', undefined, [
      {
        text: pinned ? 'Unpin' : 'Pin to top',
        onPress: () => void setCharacterPinned(character.id, !pinned).catch(pinError => {
          Alert.alert('Could not update pin', pinError instanceof Error ? pinError.message : undefined)
        }),
      },
      { text: 'Edit character', onPress: openEditor },
      {
        text: 'Clear history',
        style: 'destructive',
        onPress: () => Alert.alert(
          'Clear conversation?',
          'This removes the message history for this character.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Clear', style: 'destructive', onPress: () => void clearHistory() },
          ]
        ),
      },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const translateMessage = async (message: ChatMessage) => {
    setMessageActionMenu(null)
    if (message.translationVisible) {
      setMessages(current => current.map(item => (
        item.id === message.id
          ? { ...item, translationVisible: false, translationError: undefined }
          : item
      )))
      return
    }
    if (message.translationLoading || message.translation) {
      setMessages(current => current.map(item => (
        item.id === message.id
          ? { ...item, translationVisible: true, translationError: undefined }
          : item
      )))
      return
    }
    if (message.sourceMessageId && !userId) return
    setMessages(current => current.map(item => (
      item.id === message.id
        ? {
            ...item,
            translationVisible: true,
            translationLoading: true,
            translationError: undefined,
          }
        : item
    )))
    try {
      let translation: Awaited<ReturnType<typeof api.translateText>>
      if (message.sourceMessageId) {
        if (!userId) throw new Error('Could not translate this message.')
        translation = await api.translateMessage(userId, message.sourceMessageId, message.segmentIndex || 0)
      } else {
        translation = await api.translateText(message.text)
      }
      setMessages(current => current.map(item => (
        item.id === message.id
          ? {
              ...item,
              translation: translation.text,
              translationLoading: false,
              translationError: undefined,
            }
          : item
      )))
    } catch (translationError) {
      setMessages(current => current.map(item => (
        item.id === message.id
          ? {
              ...item,
              translationLoading: false,
              translationError: translationError instanceof Error
                ? translationError.message
                : 'Could not translate this message.',
            }
          : item
      )))
    }
  }

  const copyMessage = async (message: ChatMessage) => {
    setMessageActionMenu(null)
    await Clipboard.setStringAsync(message.text)
  }

  const sendMessage = async () => {
    const text = draft.trim()
    if (!text || !character || !userId || sendingRef.current) return

    const userMessage: ChatMessage = { id: createLocalId(), sender: 'user', text }
    const loadingId = createLocalId()
    const loadingMessage: ChatMessage = {
      id: loadingId,
      sender: 'assistant',
      text: '',
      loading: true,
    }

    startLatestScroll(withinImmersiveRangeRef.current)
    setDraft(character.id, '')
    setMessages(current => [...current, userMessage, loadingMessage])
    setSending(true)
    sendingRef.current = true
    setError(null)

    try {
      const response = await api.sendMessage({
        message: text,
        conversationId: conversationId || undefined,
        userId,
        character,
      })
      if (response.userMessageId) {
        setMessages(current => current.map(message => (
          message.id === userMessage.id
            ? {
                ...message,
                id: response.userMessageId!,
                sourceMessageId: response.userMessageId,
                segmentIndex: 0,
              }
            : message
        )))
      }
      setConversationId(response.conversationId)
      if (response.behavior?.activity) setActivity(formatActivity(response.behavior.activity))

      if (response.reply === null || response.behavior?.decision === 'no_reply') {
        setMessages(current => current.filter(message => message.id !== loadingId))
      } else if (typeof response.reply === 'string') {
        const incomingMessages = responseMessages(response)
        if (incomingMessages.length === 0) throw new Error('The server returned no usable response.')
        stageAssistantMessages(loadingId, incomingMessages)
      } else {
        throw new Error('The server returned no usable response.')
      }
    } catch (sendError) {
      setMessages(current => current.filter(message => message.id !== loadingId))
      setError(sendError instanceof Error ? sendError.message : 'The message could not be completed.')
    } finally {
      sendingRef.current = false
      setSending(false)
      void refreshState()
    }
  }

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    scrollMetricsRef.current = {
      contentHeight: contentSize.height,
      offsetY: contentOffset.y,
      viewportHeight: layoutMeasurement.height,
    }
    const distanceFromBottom = Math.max(
      0,
      contentSize.height - layoutMeasurement.height - contentOffset.y
    )
    const withinImmersiveRange = distanceFromBottom <= layoutMeasurement.height / 2
    withinImmersiveRangeRef.current = withinImmersiveRange
    if (manualScrollRef.current) followLatestRef.current = withinImmersiveRange
    if (withinImmersiveRange) hideScrollToLatest()
  }

  const handleListLayout = (event: LayoutChangeEvent) => {
    const viewportHeight = event.nativeEvent.layout.height
    scrollMetricsRef.current.viewportHeight = viewportHeight
    scrollViewportHeight.value = viewportHeight
    settleInitialScroll()
  }

  const handleContentSizeChange = (_width: number, height: number) => {
    scrollMetricsRef.current.contentHeight = height
    scrollContentHeight.value = height
    if (initialScrollRef.current) {
      settleInitialScroll()
      return
    }
    if (followLatestRef.current && !latestScrollActive.value) {
      scrollToExactLatest()
    }
  }

  if (!ready || (loadingHistory && messages.length === 0)) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator color={palette.accent} />
      </SafeAreaView>
    )
  }

  if (!character) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <Text style={styles.errorTitle}>Character not found</Text>
        <Pressable onPress={() => router.back()} style={styles.textCommand}>
          <Text style={styles.textCommandLabel}>Back</Text>
        </Pressable>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <View style={styles.chatHeader}>
        <Pressable onPress={openEditor} style={styles.headerIdentity}>
          <Avatar avatar={character.avatar} name={character.name} size={42} />
          <View style={styles.headerText}>
            <Text style={styles.headerName} numberOfLines={1}>{character.name}</Text>
            <Text style={styles.headerStatus} numberOfLines={1}>
              {character.role || 'Conversation partner'} · {activity}
            </Text>
          </View>
        </Pressable>
        <Pressable onPress={showConversationActions} hitSlop={10} style={styles.headerIcon} accessibilityLabel="Conversation options">
          <Ionicons name="ellipsis-horizontal" size={23} color={palette.text} />
        </Pressable>
      </View>

      <View style={styles.keyboardViewport}>
        <View style={styles.keyboardArea}>
          <Reanimated.View style={[styles.messageListArea, messageListKeyboardAnimatedStyle]}>
            <Reanimated.FlatList
              ref={listRef}
              data={messages}
              keyExtractor={item => item.id}
              renderItem={({ item }) => (
                <MessageRow
                  message={item}
                  characterName={character.name}
                  characterAvatar={character.avatar}
                  onEditCharacter={openEditor}
                  onLongPress={(message, pageX, pageY) => setMessageActionMenu({ message, pageX, pageY })}
                />
              )}
              style={styles.messageList}
              contentContainerStyle={styles.messageListContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              onLayout={handleListLayout}
              onScroll={handleScroll}
              onScrollBeginDrag={() => {
                manualScrollRef.current = true
                followLatestRef.current = false
                latestScrollActive.value = false
                cancelAnimation(latestScrollProgress)
              }}
              onMomentumScrollEnd={() => {
                manualScrollRef.current = false
                followLatestRef.current = withinImmersiveRangeRef.current
              }}
              onContentSizeChange={handleContentSizeChange}
              scrollEventThrottle={16}
            />
          </Reanimated.View>

          <Reanimated.View style={composerKeyboardAnimatedStyle}>
            {error && (
              <Pressable onPress={() => void loadConversation(true)} style={styles.errorBanner}>
                <Ionicons name="alert-circle-outline" size={18} color={palette.danger} />
                <Text style={styles.errorBannerText} numberOfLines={2}>{error}</Text>
                <Ionicons name="refresh" size={18} color={palette.danger} />
              </Pressable>
            )}

            <View style={styles.composerRegion}>
              {showScrollToLatest && (
                <Pressable
                  onPress={() => startLatestScroll(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Scroll to latest message"
                  style={({ pressed }) => [
                    styles.scrollToLatestButton,
                    pressed && styles.scrollToLatestButtonPressed,
                  ]}
                >
                  <Ionicons name="arrow-down" size={21} color={palette.text} />
                </Pressable>
              )}

              <View style={[
                styles.composer,
                { paddingBottom: Math.max(8, insets.bottom) },
              ]}>
                <TextInput
                  value={draft}
                  onChangeText={text => setDraft(character.id, text)}
                  placeholder="Type your message..."
                  placeholderTextColor="#8A94A3"
                  multiline
                  maxLength={20_000}
                  style={styles.composerInput}
                  textAlignVertical="center"
                  onFocus={handleComposerFocus}
                />
                <Pressable
                  onPress={() => void sendMessage()}
                  disabled={!draft.trim() || sending}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  style={({ pressed }) => [
                    styles.sendButton,
                    (!draft.trim() || sending) && styles.sendButtonDisabled,
                    pressed && draft.trim() && !sending && styles.sendButtonPressed,
                  ]}
                >
                  {sending
                    ? <ActivityIndicator size="small" color="#FFFFFF" />
                    : <Ionicons name="arrow-up" size={22} color="#FFFFFF" />}
                </Pressable>
              </View>
            </View>
          </Reanimated.View>
        </View>
      </View>

      <Modal
        visible={Boolean(messageActionMenu)}
        transparent
        animationType="fade"
        onRequestClose={() => setMessageActionMenu(null)}
      >
        <Pressable style={styles.messageActionBackdrop} onPress={() => setMessageActionMenu(null)}>
          {messageActionMenu && (
            <View
              onStartShouldSetResponder={() => true}
              style={[
                styles.messageActionMenu,
                {
                  left: Math.max(8, Math.min(window.width - 192, messageActionMenu.pageX - 88)),
                  top: Math.max(
                    insets.top + 8,
                    Math.min(
                      window.height - insets.bottom - 64,
                      messageActionMenu.pageY > 84
                        ? messageActionMenu.pageY - 66
                        : messageActionMenu.pageY + 12
                    )
                  ),
                },
              ]}
            >
              <Pressable
                onPress={() => void copyMessage(messageActionMenu.message)}
                style={({ pressed }) => [styles.messageAction, pressed && styles.messageActionPressed]}
              >
                <Ionicons name="copy-outline" size={18} color="#FFFFFF" />
                <Text style={styles.messageActionLabel}>Copy</Text>
              </Pressable>
              <View style={styles.messageActionDivider} />
              <Pressable
                onPress={() => void translateMessage(messageActionMenu.message)}
                style={({ pressed }) => [
                  styles.messageAction,
                  pressed && styles.messageActionPressed,
                ]}
              >
                <Ionicons name="language-outline" size={18} color="#FFFFFF" />
                <Text style={styles.messageActionLabel}>
                  {messageActionMenu.message.translationVisible
                    ? 'Stop Translate'
                    : 'Translate'}
                </Text>
              </Pressable>
            </View>
          )}
        </Pressable>
      </Modal>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.surface,
    overflow: 'hidden',
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    backgroundColor: palette.background,
  },
  chatHeader: {
    zIndex: 2,
    height: 66,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
    backgroundColor: palette.surface,
  },
  headerIcon: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIdentity: {
    flex: 1,
    minWidth: 0,
    paddingLeft: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  headerName: {
    color: palette.text,
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '700',
  },
  headerStatus: {
    color: palette.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 1,
  },
  keyboardViewport: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: palette.background,
  },
  keyboardArea: {
    flex: 1,
  },
  messageListArea: {
    flex: 1,
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingHorizontal: 12,
    paddingTop: 18,
    paddingBottom: MESSAGE_LIST_BOTTOM_PADDING,
  },
  messageRow: {
    width: '100%',
    marginBottom: MESSAGE_ROW_GAP,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  messageRowGrouped: {
    marginBottom: 6,
  },
  messageRowAssistant: {
    justifyContent: 'flex-start',
  },
  messageRowUser: {
    justifyContent: 'flex-end',
  },
  messageContent: {
    maxWidth: '76%',
    alignItems: 'flex-start',
  },
  messageContentUser: {
    alignItems: 'flex-end',
  },
  avatarSpacer: {
    width: 34,
    height: 1,
  },
  messageAuthor: {
    marginLeft: 2,
    marginBottom: 4,
    color: palette.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  bubble: {
    minHeight: 38,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 8,
    justifyContent: 'center',
  },
  assistantBubble: {
    backgroundColor: palette.assistantBubble,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E3E8EF',
  },
  userBubble: {
    backgroundColor: palette.userBubble,
  },
  messageText: {
    color: palette.text,
    fontSize: 16,
    lineHeight: 22,
  },
  userMessageText: {
    color: '#FFFFFF',
  },
  translationBox: {
    width: '100%',
    marginTop: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#D5DAE1',
    backgroundColor: '#E9ECEF',
  },
  translationLoadingRow: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  translationMeta: {
    color: palette.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  translationText: {
    color: '#3F4752',
    fontSize: 14,
    lineHeight: 20,
  },
  translationErrorText: {
    color: palette.danger,
  },
  typingIndicator: {
    height: 20,
    minWidth: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.textMuted,
  },
  errorBanner: {
    minHeight: 42,
    marginHorizontal: 12,
    marginBottom: 7,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF3F2',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#FDA29B',
  },
  errorBannerText: {
    flex: 1,
    color: '#B42318',
    fontSize: 12,
    lineHeight: 17,
  },
  composerRegion: {
    position: 'relative',
    zIndex: 2,
  },
  scrollToLatestButton: {
    position: 'absolute',
    right: 16,
    top: -50,
    zIndex: 3,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#D5DBE4',
    backgroundColor: '#FFFFFF',
    shadowColor: '#101828',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.14,
    shadowRadius: 5,
    elevation: 4,
  },
  scrollToLatestButtonPressed: {
    backgroundColor: '#F2F4F7',
    transform: [{ scale: 0.96 }],
  },
  composer: {
    minHeight: 60,
    paddingTop: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
    backgroundColor: palette.surface,
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 108,
    paddingHorizontal: 13,
    paddingTop: Platform.OS === 'ios' ? 11 : 8,
    paddingBottom: Platform.OS === 'ios' ? 10 : 8,
    borderWidth: 1,
    borderColor: '#C9D1DC',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    color: palette.text,
    fontSize: 16,
    lineHeight: 21,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.accent,
  },
  sendButtonDisabled: {
    backgroundColor: '#9BD49D',
  },
  sendButtonPressed: {
    backgroundColor: palette.accentPressed,
  },
  messageActionBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  messageActionMenu: {
    position: 'absolute',
    width: 184,
    height: 54,
    paddingHorizontal: 5,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2B2D30',
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 8,
  },
  messageAction: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  messageActionPressed: {
    opacity: 0.65,
  },
  messageActionDisabled: {
    opacity: 0.35,
  },
  messageActionLabel: {
    color: '#FFFFFF',
    fontSize: 11,
    lineHeight: 14,
  },
  messageActionDivider: {
    width: StyleSheet.hairlineWidth,
    height: 30,
    backgroundColor: '#5A5D62',
  },
  errorTitle: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '700',
  },
  textCommand: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  textCommandLabel: {
    color: palette.accentPressed,
    fontSize: 15,
    fontWeight: '700',
  },
})
