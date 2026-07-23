import Ionicons from '@expo/vector-icons/Ionicons'
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
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Keyboard,
  KeyboardEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'

import { Avatar } from '@/components/avatar'
import { api } from '@/src/api'
import { useChat } from '@/src/chat-context'
import { starterMessageForCharacter } from '@/src/starter-message'
import { palette } from '@/src/theme'
import { ChatMessage, ChatResponse, ServerMessage } from '@/src/types'

const createLocalId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

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
    return segments.map((text, index) => ({
      id: segments.length === 1 ? message.id : `${message.id}:segment:${index}`,
      sender: message.senderRole === 'user' ? 'user' as const : 'assistant' as const,
      text,
      groupIndex: index,
      groupSize: segments.length,
      createdAt: message.createdAt,
    }))
  })

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
  const phase = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const animation = Animated.loop(Animated.timing(phase, {
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
          <Animated.View
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
}: {
  message: ChatMessage
  characterName: string
  characterAvatar?: string
  onEditCharacter: () => void
}) {
  const isUser = message.sender === 'user'
  const isContinuation = !isUser && (message.groupIndex || 0) > 0
  const hasFollowingSegment = (message.groupIndex || 0) < (message.groupSize || 1) - 1
  const entryProgress = useRef(new Animated.Value(message.animateEntry ? 0 : 1)).current

  useEffect(() => {
    if (!message.animateEntry) return
    Animated.timing(entryProgress, {
      toValue: 1,
      duration: 230,
      delay: message.animationDelayMs || 0,
      useNativeDriver: true,
    }).start()
  }, [entryProgress, message.animateEntry, message.animationDelayMs])

  return (
    <Animated.View
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
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
          {message.loading ? (
            <TypingIndicator />
          ) : (
            <Text style={[styles.messageText, isUser && styles.userMessageText]} selectable>
              {message.text}
            </Text>
          )}
        </View>
      </View>
      {isUser && <Avatar name="Me" avatar="Me" size={34} muted />}
    </Animated.View>
  )
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ characterId: string | string[] }>()
  const characterId = Array.isArray(params.characterId) ? params.characterId[0] : params.characterId
  const insets = useSafeAreaInsets()
  const {
    ready,
    userId,
    characters,
    conversationVersions,
    getDraft,
    setDraft,
    setActiveCharacter,
  } = useChat()
  const character = useMemo(
    () => characters.find(item => item.id === characterId),
    [characterId, characters]
  )
  const draft = characterId ? getDraft(characterId) : ''
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [activity, setActivity] = useState('Online')
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<FlatList<ChatMessage> | null>(null)
  const historyRequestRef = useRef(0)
  const sendingRef = useRef(false)
  const atBottomRef = useRef(true)
  const followLatestRef = useRef(true)
  const initialScrollRef = useRef(true)
  const initialScrollScheduledRef = useRef(false)
  const initialScrollFrameRef = useRef<number | null>(null)
  const pendingSendScrollRef = useRef<'auto' | 'animated' | null>(null)
  const keyboardVisibleRef = useRef(false)
  const keyboardOffset = useRef(new Animated.Value(0)).current
  const composerBottomPadding = useRef(new Animated.Value(Math.max(8, insets.bottom))).current
  const stagedDeliveryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  const settleInitialScroll = useCallback(() => {
    if (!initialScrollRef.current || initialScrollScheduledRef.current) return
    initialScrollScheduledRef.current = true
    listRef.current?.scrollToEnd({ animated: false })
    initialScrollFrameRef.current = requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: false })
      initialScrollFrameRef.current = requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: false })
        initialScrollRef.current = false
        initialScrollScheduledRef.current = false
        initialScrollFrameRef.current = null
      })
    })
  }, [])

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

    const followIncoming = () => {
      if (!atBottomRef.current && !followLatestRef.current) return
      followLatestRef.current = true
      pendingSendScrollRef.current = 'animated'
    }

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
  }, [scheduleDeliveryTask])

  useEffect(() => {
    const handleKeyboardTransition = (event: KeyboardEvent, forcedVisible?: boolean) => {
      const screenHeight = Dimensions.get('screen').height
      const visible = forcedVisible ?? event.endCoordinates.screenY < screenHeight - 1
      const shouldFollow = atBottomRef.current || followLatestRef.current
      keyboardVisibleRef.current = visible

      Animated.parallel([
        Animated.timing(keyboardOffset, {
          toValue: visible ? event.endCoordinates.height : 0,
          duration: Math.max(160, event.duration || 250),
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
          useNativeDriver: false,
        }),
        Animated.timing(composerBottomPadding, {
          toValue: visible ? 8 : Math.max(8, insets.bottom),
          duration: Math.max(160, event.duration || 250),
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
          useNativeDriver: false,
        }),
      ]).start(({ finished }) => {
        if (finished && shouldFollow) listRef.current?.scrollToEnd({ animated: false })
      })

      if (!shouldFollow) return
      followLatestRef.current = true
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }))
    }
    const subscriptions = Platform.OS === 'ios'
      ? [Keyboard.addListener('keyboardWillChangeFrame', handleKeyboardTransition)]
      : [
          Keyboard.addListener('keyboardDidShow', event => handleKeyboardTransition(event, true)),
          Keyboard.addListener('keyboardDidHide', event => handleKeyboardTransition(event, false)),
        ]

    return () => {
      subscriptions.forEach(subscription => subscription.remove())
    }
  }, [composerBottomPadding, insets.bottom, keyboardOffset])

  useEffect(() => {
    if (!keyboardVisibleRef.current) {
      composerBottomPadding.setValue(Math.max(8, insets.bottom))
    }
  }, [composerBottomPadding, insets.bottom])

  useEffect(() => () => {
    if (initialScrollFrameRef.current !== null) {
      cancelAnimationFrame(initialScrollFrameRef.current)
    }
    stagedDeliveryTimersRef.current.forEach(timer => clearTimeout(timer))
    stagedDeliveryTimersRef.current.clear()
  }, [])

  useEffect(() => {
    if (!characterId) return
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
      initialScrollRef.current = !quiet
      initialScrollScheduledRef.current = false
      followLatestRef.current = true
      atBottomRef.current = true

      if (!matching) {
        setConversationId(null)
        setMessages([{
          id: `starter-${character.id}`,
          sender: 'assistant',
          text: starterMessageForCharacter(character),
        }])
      } else {
        const serverMessages = await api.listMessages(matching.id)
        if (requestId !== historyRequestRef.current) return
        setConversationId(matching.id)
        setMessages(mapMessages(serverMessages))
      }
      setError(null)
    } catch (loadError) {
      if (requestId !== historyRequestRef.current) return
      setError(loadError instanceof Error ? loadError.message : 'Could not load this conversation.')
    } finally {
      if (requestId === historyRequestRef.current) setLoadingHistory(false)
    }
  }, [character, userId])

  useEffect(() => {
    if (!character || !userId) return
    void loadConversation()
    void refreshState()
  }, [character, loadConversation, refreshState, userId])

  useEffect(() => {
    if (!loadingHistory && messages.length > 0) settleInitialScroll()
  }, [loadingHistory, messages.length, settleInitialScroll])

  const syncMessages = useCallback(async () => {
    if (!conversationId || sendingRef.current) return
    try {
      const serverMessages = await api.listMessages(conversationId)
      const mapped = mapMessages(serverMessages)
      setMessages(current => {
        if (current.some(message => message.loading) || stagedDeliveryTimersRef.current.size > 0) {
          return current
        }
        const existingIds = new Set(current.map(message => message.id))
        let animationIndex = 0
        const next = mapped.map(message => {
          if (message.sender !== 'assistant' || existingIds.has(message.id)) return message
          const animatedMessage = {
            ...message,
            animateEntry: true,
            animationDelayMs: animationIndex * 90,
          }
          animationIndex += 1
          return animatedMessage
        })
        if (animationIndex > 0 && (atBottomRef.current || followLatestRef.current)) {
          followLatestRef.current = true
          pendingSendScrollRef.current = 'animated'
        }
        return next
      })
    } catch {
      // Keep the current local transcript while connectivity recovers.
    }
  }, [conversationId])

  useEffect(() => {
    if (!conversationId) return
    const interval = setInterval(() => void syncMessages(), 15_000)
    return () => clearInterval(interval)
  }, [conversationId, syncMessages])

  const proactiveVersion = characterId ? conversationVersions[characterId] || 0 : 0
  const previousProactiveVersionRef = useRef(proactiveVersion)
  useEffect(() => {
    if (previousProactiveVersionRef.current === proactiveVersion) return
    previousProactiveVersionRef.current = proactiveVersion
    if (conversationId) {
      void syncMessages()
    } else {
      void loadConversation(true)
    }
  }, [conversationId, loadConversation, proactiveVersion, syncMessages])

  const openEditor = () => {
    if (!characterId) return
    router.push({ pathname: '/character/[characterId]', params: { characterId } })
  }

  const clearHistory = async () => {
    if (!userId || !character) return
    try {
      await api.clearHistory(userId, character.id)
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
      setError(null)
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Could not clear the conversation.')
    }
  }

  const showConversationActions = () => {
    Alert.alert(character?.name || 'Conversation', undefined, [
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

    pendingSendScrollRef.current = atBottomRef.current ? 'auto' : 'animated'
    followLatestRef.current = true
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
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y
    atBottomRef.current = distanceFromBottom <= 36
  }

  const handleContentSizeChange = () => {
    if (initialScrollRef.current) {
      settleInitialScroll()
      return
    }
    if (pendingSendScrollRef.current) {
      const mode = pendingSendScrollRef.current
      pendingSendScrollRef.current = null
      listRef.current?.scrollToEnd({ animated: mode === 'animated' })
      return
    }
    if (followLatestRef.current) {
      listRef.current?.scrollToEnd({ animated: false })
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

      <Animated.View style={[styles.keyboardArea, { paddingBottom: keyboardOffset }]}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <MessageRow
              message={item}
              characterName={character.name}
              characterAvatar={character.avatar}
              onEditCharacter={openEditor}
            />
          )}
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          onLayout={settleInitialScroll}
          onScroll={handleScroll}
          onScrollBeginDrag={() => {
            followLatestRef.current = false
          }}
          onContentSizeChange={handleContentSizeChange}
          scrollEventThrottle={32}
        />

        {error && (
          <Pressable onPress={() => void loadConversation(true)} style={styles.errorBanner}>
            <Ionicons name="alert-circle-outline" size={18} color={palette.danger} />
            <Text style={styles.errorBannerText} numberOfLines={2}>{error}</Text>
            <Ionicons name="refresh" size={18} color={palette.danger} />
          </Pressable>
        )}

        <Animated.View style={[
          styles.composer,
          { paddingBottom: composerBottomPadding },
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
        </Animated.View>
      </Animated.View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.surface,
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    backgroundColor: palette.background,
  },
  chatHeader: {
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
  keyboardArea: {
    flex: 1,
    backgroundColor: palette.background,
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingHorizontal: 12,
    paddingTop: 18,
    paddingBottom: 8,
  },
  messageRow: {
    width: '100%',
    marginBottom: 14,
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
