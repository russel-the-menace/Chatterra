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
  BackHandler,
  Easing,
  FlatList,
  Keyboard,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextLayoutEvent,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native'
import Reanimated, {
  cancelAnimation,
  Easing as ReanimatedEasing,
  LinearTransition,
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
import { VoiceMessageBubble } from '@/components/voice-message-bubble'
import { api, ApiError } from '@/src/api'
import { useChat } from '@/src/chat-context'
import { starterMessageForCharacter } from '@/src/starter-message'
import { palette } from '@/src/theme'
import { useVoiceInput } from '@/src/voice-input'
import {
  ChatMessage,
  ChatResponse,
  AssistantVoiceMessage,
  MessageHistoryCursor,
  MessageQuote,
  ServerMessage,
  VoiceTranscriptMetadata,
} from '@/src/types'

const createLocalId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

const LATEST_SCROLL_DURATION_MS = 280
const MESSAGE_REVEAL_DURATION_MS = 220
const OUTGOING_DELIVERY_INDICATOR_DELAY_MS = 1_000
const OUTGOING_DELIVERY_TIMEOUT_MS = 60_000
const MESSAGE_ROW_GAP = 14
const LATEST_MESSAGE_COMPOSER_GAP = 15
const MESSAGE_ACTION_MENU_MAX_WIDTH = 308
const MESSAGE_ACTION_MENU_HEIGHT = 66
const MESSAGE_ACTION_ARROW_SIZE = 8
const MESSAGE_ACTION_GAP = 4
const MESSAGE_ACTION_EDGE_GAP = 8
const MESSAGE_SELECTION_HIT_PADDING = 28
const MESSAGE_SELECTION_HANDLE_HIT_PADDING = 22
const MESSAGE_ACTION_FADE_OUT_MS = 65
const MESSAGE_ACTION_FADE_IN_MS = 90
const MESSAGE_ACTION_REAPPEAR_DELAY_MS = 120
const MESSAGE_SELECTION_INITIALIZE_MS = 180
const HISTORY_PAGE_SIZE = 50
const OLDER_HISTORY_TRIGGER_OFFSET = 80
const LOCAL_HISTORY_REFRESH_MS = 2 * 60_000
// The final row margin and list padding together form the visible composer gap.
const MESSAGE_LIST_BOTTOM_PADDING = LATEST_MESSAGE_COMPOSER_GAP - MESSAGE_ROW_GAP
const MESSAGE_BUBBLE_LAYOUT = LinearTransition
  .duration(MESSAGE_REVEAL_DURATION_MS)
  .easing(ReanimatedEasing.out(ReanimatedEasing.cubic))
const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable)

type MessageAnchor = {
  x: number
  y: number
  width: number
  height: number
}

type MessageSelectionRange = {
  start: number
  end: number
}

type MessageTextLine = {
  end: number
  height: number
  left: number
  start: number
  top: number
  width: number
}

type MessageSelectionDismissTarget = {
  height: number
  left: number
  top: number
  width: number
}

type MessageActionSession = {
  anchor: MessageAnchor
  generation: number
  messageKey: string
  openedAt: number
  preserveComposerFocus: boolean
  selection: MessageSelectionRange
  selectionAdjusting: boolean
  selectionControlled: boolean
  usableBottom: number
}

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.max(minimum, Math.min(maximum, value))
)

const getSelectionDismissTargets = (
  lines: MessageTextLine[],
  selection: MessageSelectionRange | undefined
): MessageSelectionDismissTarget[] => {
  if (!selection) return []
  const selectionStart = Math.min(selection.start, selection.end)
  const selectionEnd = Math.max(selection.start, selection.end)
  if (selectionStart === selectionEnd) return []

  return lines.flatMap(line => {
    const textLength = Math.max(1, line.end - line.start)
    const toX = (offset: number) => line.left + line.width * ((offset - line.start) / textLength)
    const targets: MessageSelectionDismissTarget[] = []
    const lineSelectionStart = clamp(selectionStart, line.start, line.end)
    const lineSelectionEnd = clamp(selectionEnd, line.start, line.end)

    if (lineSelectionStart > line.start) {
      const right = toX(lineSelectionStart) - MESSAGE_SELECTION_HANDLE_HIT_PADDING
      if (right > line.left) {
        targets.push({
          height: line.height,
          left: line.left,
          top: line.top,
          width: right - line.left,
        })
      }
    }

    if (lineSelectionEnd < line.end) {
      const left = toX(lineSelectionEnd) + MESSAGE_SELECTION_HANDLE_HIT_PADDING
      const right = line.left + line.width
      if (right > left) {
        targets.push({
          height: line.height,
          left,
          top: line.top,
          width: right - left,
        })
      }
    }

    return targets
  })
}

const parseMessageQuote = (value: unknown): MessageQuote | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const quote = value as Record<string, unknown>
  if (quote.senderRole !== 'user' && quote.senderRole !== 'assistant') return undefined
  if (typeof quote.text !== 'string' || !quote.text.trim()) return undefined
  const segmentIndex = Number(quote.segmentIndex ?? 0)
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) return undefined
  const sourceMessageId = typeof quote.sourceMessageId === 'string' && quote.sourceMessageId
    ? quote.sourceMessageId
    : undefined
  const fallbackName = quote.senderRole === 'user' ? 'You' : 'Character'

  return {
    sourceMessageId,
    segmentIndex,
    senderRole: quote.senderRole,
    senderName: typeof quote.senderName === 'string' && quote.senderName.trim()
      ? quote.senderName.trim()
      : fallbackName,
    text: quote.text,
  }
}

const getMessageActionLayout = ({
  anchor,
  viewportWidth,
  viewportHeight,
  safeLeft,
  safeRight,
  safeTop,
  safeBottom,
  usableBottom,
}: {
  anchor: MessageAnchor
  viewportWidth: number
  viewportHeight: number
  safeLeft: number
  safeRight: number
  safeTop: number
  safeBottom: number
  usableBottom?: number
}) => {
  const availableWidth = Math.max(
    1,
    viewportWidth - safeLeft - safeRight - MESSAGE_ACTION_EDGE_GAP * 2
  )
  const width = Math.min(MESSAGE_ACTION_MENU_MAX_WIDTH, availableWidth)
  const anchorCenterX = anchor.x + anchor.width / 2
  const minimumLeft = safeLeft + MESSAGE_ACTION_EDGE_GAP
  const maximumLeft = viewportWidth - safeRight - width - MESSAGE_ACTION_EDGE_GAP
  const left = clamp(
    anchorCenterX - width / 2,
    minimumLeft,
    maximumLeft
  )
  const minimumTop = safeTop + MESSAGE_ACTION_EDGE_GAP
  const bottomBoundary = Math.min(
    viewportHeight - safeBottom,
    usableBottom ?? viewportHeight - safeBottom
  )
  const maximumTop = bottomBoundary
    - MESSAGE_ACTION_EDGE_GAP
    - MESSAGE_ACTION_MENU_HEIGHT
  const belowTop = anchor.y + anchor.height + MESSAGE_ACTION_GAP + MESSAGE_ACTION_ARROW_SIZE
  const aboveTop = anchor.y
    - MESSAGE_ACTION_GAP
    - MESSAGE_ACTION_ARROW_SIZE
    - MESSAGE_ACTION_MENU_HEIGHT
  const belowFits = belowTop <= maximumTop
  const aboveFits = aboveTop >= minimumTop
  const belowSpace = bottomBoundary - anchor.y - anchor.height
  const aboveSpace = anchor.y - safeTop
  const placement: 'below' | 'above' = belowFits
    ? 'below'
    : aboveFits || aboveSpace > belowSpace ? 'above' : 'below'
  const top = clamp(
    placement === 'below' ? belowTop : aboveTop,
    minimumTop,
    maximumTop
  )
  const arrowCenter = clamp(
    anchorCenterX - left,
    MESSAGE_ACTION_ARROW_SIZE * 2,
    width - MESSAGE_ACTION_ARROW_SIZE * 2
  )

  return {
    arrowLeft: arrowCenter - MESSAGE_ACTION_ARROW_SIZE,
    left,
    placement,
    top,
    width,
  }
}

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

const parseAssistantVoiceMessage = (value: unknown): AssistantVoiceMessage | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const voice = value as Record<string, unknown>
  if (voice.provider !== 'qwen3-tts' || voice.voiceId !== 'maya') return undefined
  if (voice.status !== 'pending' && voice.status !== 'ready' && voice.status !== 'failed') return undefined
  if (!Number.isInteger(voice.segmentIndex) || Number(voice.segmentIndex) < 0) return undefined
  if (typeof voice.style !== 'string' || !voice.style.trim()) return undefined
  if (voice.audioUrl != null && typeof voice.audioUrl !== 'string') return undefined
  if (voice.durationSeconds != null && (
    typeof voice.durationSeconds !== 'number' || !Number.isFinite(voice.durationSeconds)
  )) return undefined
  return {
    provider: 'qwen3-tts',
    status: voice.status,
    segmentIndex: Number(voice.segmentIndex),
    voiceId: 'maya',
    style: voice.style,
    audioUrl: typeof voice.audioUrl === 'string' ? voice.audioUrl : undefined,
    durationSeconds: typeof voice.durationSeconds === 'number' ? voice.durationSeconds : undefined,
    mimeType: voice.mimeType === 'audio/wav' ? 'audio/wav' : undefined,
    generatedAt: typeof voice.generatedAt === 'string' ? voice.generatedAt : undefined,
  }
}

const mapMessages = (messages: ServerMessage[]): ChatMessage[] => messages
  .filter(message => message.senderRole !== 'system')
  .flatMap(message => {
    const segments = deliverySegments(message)
    const quote = parseMessageQuote(message.contentJson?.quote)
    const translations = message.contentJson?.translations
    const englishTranslations = translations && typeof translations === 'object'
      ? (translations as Record<string, unknown>).en
      : undefined
    const voice = parseAssistantVoiceMessage(message.contentJson?.voice)
    return segments.map((text, index) => ({
      id: segments.length === 1 ? message.id : `${message.id}:segment:${index}`,
      sourceMessageId: message.id,
      segmentIndex: index,
      sender: message.senderRole === 'user' ? 'user' as const : 'assistant' as const,
      text,
      quote,
      translation: englishTranslations && typeof englishTranslations === 'object'
        && typeof (englishTranslations as Record<string, unknown>)[String(index)] === 'string'
        ? String((englishTranslations as Record<string, unknown>)[String(index)])
        : undefined,
      translationVisible: Boolean(
        englishTranslations && typeof englishTranslations === 'object'
          && typeof (englishTranslations as Record<string, unknown>)[String(index)] === 'string'
      ),
      voice: voice?.segmentIndex === index ? voice : undefined,
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
      renderKey: existing.renderKey || message.renderKey,
      translation: existing.translation || message.translation,
      translationVisible: existing.translation !== undefined
        || existing.translationLoading
        || existing.translationError
        ? existing.translationVisible
        : message.translationVisible,
      translationLoading: existing.translationLoading,
      translationError: existing.translationError,
      voiceTranscriptVisible: existing.voiceTranscriptVisible && Boolean(message.voice),
    }
  })
}

const reconcileLocalStarter = (current: ChatMessage[], incoming: ChatMessage[]) => {
  const serverStarter = incoming[0]
  if (
    !serverStarter
    || serverStarter.sender !== 'assistant'
    || !serverStarter.sourceMessageId
  ) return current

  const localStarter = current.find(message => (
    message.sender === 'assistant'
    && !message.sourceMessageId
    && !message.loading
    && message.id.startsWith('starter-')
    && message.text === serverStarter.text
  ))
  if (!localStarter) return current

  // The starter is shown locally before a conversation exists. Once its persisted
  // counterpart arrives, retain the local position but adopt the server identity.
  return current
    .filter(message => message.id !== serverStarter.id)
    .map(message => (
      message.id === localStarter.id
        ? { ...message, ...serverStarter, renderKey: message.renderKey || serverStarter.renderKey }
        : message
    ))
}

const mergeMessagePage = (
  current: ChatMessage[],
  incoming: ChatMessage[],
  position: 'prepend' | 'append'
) => {
  const reconciledCurrent = reconcileLocalStarter(current, incoming)
  const currentById = new Map(reconciledCurrent.map(message => [message.id, message]))
  const hydratedIncoming = mergeMessageUiState(reconciledCurrent, incoming)
  const incomingById = new Map(hydratedIncoming.map(message => [message.id, message]))
  const preservedCurrent = reconciledCurrent.map(message => incomingById.get(message.id) || message)
  const unseenIncoming = hydratedIncoming.filter(message => !currentById.has(message.id))

  return position === 'prepend'
    ? [...unseenIncoming, ...preservedCurrent]
    : [...preservedCurrent, ...unseenIncoming]
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
    voice: response.voice?.segmentIndex === index ? response.voice : undefined,
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

function MessageDeliveryIndicator({
  state,
  onRetry,
}: {
  state?: ChatMessage['deliveryState']
  onRetry: () => void
}) {
  const [showSending, setShowSending] = useState(false)

  useEffect(() => {
    if (state !== 'sending') {
      setShowSending(false)
      return
    }
    const timer = setTimeout(() => setShowSending(true), OUTGOING_DELIVERY_INDICATOR_DELAY_MS)
    return () => clearTimeout(timer)
  }, [state])

  if (state === 'failed') {
    return (
      <Pressable
        onPress={onRetry}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Retry sending message"
        style={({ pressed }) => [
          styles.messageDeliveryIndicator,
          styles.messageDeliveryFailed,
          pressed && styles.messageDeliveryFailedPressed,
        ]}
      >
        <Ionicons name="alert" size={14} color="#FFFFFF" />
      </Pressable>
    )
  }

  if (!showSending) return null

  return (
    <View
      accessibilityLabel="Sending message"
      style={styles.messageDeliveryIndicator}
    >
      <ActivityIndicator size="small" color="#98A2B3" />
    </View>
  )
}

function MessageBubbleContent({
  message,
  isUser,
  onVoiceLongPress,
  selecting,
  selection,
  selectionAdjusting,
  selectionControlled,
  preserveKeyboard,
  onSelectionBlur,
  onSelectionChange,
  onSelectionOutsideTap,
  onSelectionTouchEnd,
}: {
  message: ChatMessage
  isUser: boolean
  onVoiceLongPress: () => void
  selecting: boolean
  selection?: MessageSelectionRange
  selectionAdjusting: boolean
  selectionControlled: boolean
  preserveKeyboard: boolean
  onSelectionBlur: () => void
  onSelectionChange: (selection: MessageSelectionRange) => void
  onSelectionOutsideTap: () => void
  onSelectionTouchEnd: () => void
}) {
  const isLoading = Boolean(message.loading)
  const readyVoice = !isUser
    && message.voice?.status === 'ready'
    && Boolean(message.voice.audioUrl)
  const revealProgress = useRef(new RNAnimated.Value(isLoading ? 0 : 1)).current
  const wasLoadingRef = useRef(isLoading)
  const [showTypingIndicator, setShowTypingIndicator] = useState(isLoading)
  const [selectionLines, setSelectionLines] = useState<MessageTextLine[]>([])

  const handleSelectionTextLayout = useCallback((event: TextLayoutEvent) => {
    let cursor = 0
    const nextLines = event.nativeEvent.lines.map(line => {
      const lineStart = message.text.indexOf(line.text, cursor)
      const start = lineStart >= 0 ? lineStart : cursor
      const end = start + line.text.length
      cursor = end
      while (message.text[cursor] === '\n') cursor += 1
      return {
        end,
        height: line.height,
        left: line.x,
        start,
        top: line.y,
        width: line.width,
      }
    })
    setSelectionLines(current => (
      current.length === nextLines.length
      && current.every((line, index) => (
        line.end === nextLines[index].end
        && line.height === nextLines[index].height
        && line.left === nextLines[index].left
        && line.start === nextLines[index].start
        && line.top === nextLines[index].top
        && line.width === nextLines[index].width
      ))
        ? current
        : nextLines
    ))
  }, [message.text])

  const selectionDismissTargets = useMemo(
    () => getSelectionDismissTargets(selectionLines, selection),
    [selection, selectionLines]
  )
  const dismissSelectionFromUnselectedText = useCallback((x: number, y: number) => {
    const target = selectionDismissTargets.find(candidate => (
      x >= candidate.left
      && x <= candidate.left + candidate.width
      && y >= candidate.top
      && y <= candidate.top + candidate.height
    ))
    if (!target) return false
    onSelectionOutsideTap()
    return true
  }, [onSelectionOutsideTap, selectionDismissTargets])
  useEffect(() => {
    if (isLoading) {
      revealProgress.stopAnimation()
      revealProgress.setValue(0)
      wasLoadingRef.current = true
      setShowTypingIndicator(true)
      return
    }

    if (!wasLoadingRef.current) {
      revealProgress.setValue(1)
      setShowTypingIndicator(false)
      return
    }

    wasLoadingRef.current = false
    revealProgress.stopAnimation()
    revealProgress.setValue(0)
    const animation = RNAnimated.timing(revealProgress, {
      toValue: 1,
      duration: MESSAGE_REVEAL_DURATION_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    })
    animation.start(({ finished }) => {
      if (finished) setShowTypingIndicator(false)
    })
    return () => animation.stop()
  }, [isLoading, revealProgress])

  return (
    <View
      style={styles.bubbleContent}
      onStartShouldSetResponderCapture={event => (
        selecting
        && !readyVoice
        && dismissSelectionFromUnselectedText(
          event.nativeEvent.locationX,
          event.nativeEvent.locationY
        )
      )}
    >
      {readyVoice && !selecting && message.voice && (
        <VoiceMessageBubble voice={message.voice} onLongPress={onVoiceLongPress} />
      )}
      {!isLoading && !selecting && !readyVoice && (
        <RNAnimated.Text
          style={[
            styles.messageText,
            isUser && styles.userMessageText,
            {
              opacity: revealProgress.interpolate({
                inputRange: [0, 0.18, 1],
                outputRange: [0, 0.2, 1],
              }),
              transform: [{
                translateY: revealProgress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [3, 0],
                }),
              }],
            },
          ]}
        >
          {message.text}
        </RNAnimated.Text>
      )}
      {!isLoading && selecting && !readyVoice && (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onTextLayout={handleSelectionTextLayout}
          style={[
            styles.messageText,
            isUser && styles.userMessageText,
            styles.messageSelectionMeasurement,
          ]}
        >
          {message.text}
        </Text>
      )}
      {selecting && !readyVoice && (
        <TextInput
          autoFocus
          multiline
          // Read-only UITextView keeps UIKit in its text-selection interaction path.
          // The default `selectable` value remains true, so handles and the loupe still work.
          editable={Platform.OS !== 'ios'}
          showSoftInputOnFocus={preserveKeyboard}
          selectTextOnFocus
          scrollEnabled={false}
          contextMenuHidden={Platform.OS === 'ios'}
          selectionColor={isUser ? '#14532D' : palette.accent}
          // UIKit owns the range while a handle is held, which keeps its native loupe alive.
          selection={selectionControlled && !selectionAdjusting ? selection : undefined}
          value={message.text}
          onSelectionChange={event => onSelectionChange(event.nativeEvent.selection)}
          onChangeText={() => undefined}
          onBlur={onSelectionBlur}
          onTouchEnd={onSelectionTouchEnd}
          style={[
            styles.messageSelectionInput,
            styles.messageText,
            isUser && styles.userMessageText,
          ]}
          accessibilityLabel="Select message text"
        />
      )}
      {showTypingIndicator && (
        <RNAnimated.View
          accessibilityElementsHidden={!isLoading}
          importantForAccessibility={isLoading ? 'auto' : 'no-hide-descendants'}
          pointerEvents="none"
          style={[
            !isLoading && styles.typingIndicatorOverlay,
            !isLoading && {
              opacity: revealProgress.interpolate({
                inputRange: [0, 0.5, 1],
                outputRange: [1, 0.55, 0],
              }),
            },
          ]}
        >
          <TypingIndicator />
        </RNAnimated.View>
      )}
    </View>
  )
}

function MessageRow({
  message,
  characterName,
  characterAvatar,
  onEditCharacter,
  onLongPress,
  selecting,
  selection,
  selectionAdjusting,
  selectionControlled,
  preserveKeyboard,
  onSelectionBlur,
  onSelectionChange,
  onSelectionOutsideTap,
  onSelectionTouchEnd,
  onRetryMessage,
}: {
  message: ChatMessage
  characterName: string
  characterAvatar?: string
  onEditCharacter: () => void
  onLongPress: (message: ChatMessage, anchor: MessageAnchor) => void
  selecting: boolean
  selection?: MessageSelectionRange
  selectionAdjusting: boolean
  selectionControlled: boolean
  preserveKeyboard: boolean
  onSelectionBlur: () => void
  onSelectionChange: (selection: MessageSelectionRange) => void
  onSelectionOutsideTap: () => void
  onSelectionTouchEnd: () => void
  onRetryMessage: (message: ChatMessage) => void
}) {
  const isUser = message.sender === 'user'
  const isContinuation = !isUser && (message.groupIndex || 0) > 0
  const hasFollowingSegment = (message.groupIndex || 0) < (message.groupSize || 1) - 1
  const entryProgress = useRef(new RNAnimated.Value(message.animateEntry ? 0 : 1)).current
  const bubbleRef = useRef<View>(null)

  const handleLongPress = () => {
    bubbleRef.current?.measureInWindow((x, y, width, height) => {
      if (width <= 0 || height <= 0) return
      onLongPress(message, { x, y, width, height })
    })
  }

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
        hasFollowingSegment && styles.messageRowGrouped,
        {
          opacity: entryProgress,
          transform: [{
            translateY: entryProgress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }),
          }],
        },
      ]}
    >
      <View style={[
        styles.messagePrimaryRow,
        isUser ? styles.messagePrimaryRowUser : styles.messagePrimaryRowAssistant,
      ]}>
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
          {isUser && (
            <MessageDeliveryIndicator
              state={message.deliveryState}
              onRetry={() => onRetryMessage(message)}
            />
          )}
          <View
            ref={bubbleRef}
            collapsable={false}
            style={[styles.bubbleAnchor, selecting && styles.bubbleAnchorSelecting]}
          >
            <AnimatedPressable
              layout={isUser ? undefined : MESSAGE_BUBBLE_LAYOUT}
              delayLongPress={280}
              disabled={message.loading || selecting}
              onLongPress={handleLongPress}
              style={[
                styles.bubble,
                isUser ? styles.userBubble : styles.assistantBubble,
                selecting && styles.bubbleSelecting,
              ]}
            >
              <MessageBubbleContent
                message={message}
                isUser={isUser}
                onVoiceLongPress={handleLongPress}
                selecting={selecting}
                selection={selection}
                selectionAdjusting={selectionAdjusting}
                selectionControlled={selectionControlled}
                preserveKeyboard={preserveKeyboard}
                onSelectionBlur={onSelectionBlur}
                onSelectionChange={onSelectionChange}
                onSelectionOutsideTap={onSelectionOutsideTap}
                onSelectionTouchEnd={onSelectionTouchEnd}
              />
            </AnimatedPressable>
          </View>
        </View>
        {isUser && <Avatar name="Me" avatar="Me" size={34} muted />}
      </View>
      {(message.quote || message.voiceTranscriptVisible || (
        message.translationVisible
        && (message.translationLoading || message.translation || message.translationError)
      )) && (
        <View style={[
          styles.messageSupplement,
          isUser ? styles.messageSupplementUser : styles.messageSupplementAssistant,
        ]}>
          {message.quote && (
            <View style={[styles.sentQuote, isUser && styles.sentQuoteUser]}>
              <Text style={styles.sentQuoteText} numberOfLines={2}>
                <Text style={styles.sentQuoteAuthor}>{message.quote.senderName}: </Text>
                {message.quote.text}
              </Text>
            </View>
          )}
          {message.voiceTranscriptVisible && message.voice?.status === 'ready' && (
            <View style={styles.voiceTranscriptBox}>
              <Text style={styles.voiceTranscriptLabel}>Voice message</Text>
              <Text style={styles.voiceTranscriptText}>{message.text}</Text>
            </View>
          )}
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
      )}
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
    getQuoteDraft,
    setQuoteDraft,
    setActiveCharacter,
    pinnedCharacterIds,
    setCharacterPinned,
    markConversationActive,
    getConversationCache,
    getConversationViewCache,
    hydrateConversationCache,
    setConversationCache,
    setConversationViewCache,
    clearConversationCache,
  } = useChat()
  const character = useMemo(
    () => characters.find(item => item.id === characterId),
    [characterId, characters]
  )
  const draft = characterId ? getDraft(characterId) : ''
  const quotedMessage = characterId ? getQuoteDraft(characterId) : null
  const initialCacheRef = useRef(characterId ? getConversationCache(characterId) : undefined)
  const initialViewCacheRef = useRef(
    characterId ? getConversationViewCache(characterId) : undefined
  )
  const initialViewCache = initialViewCacheRef.current
  const initialLatestMessage = initialCacheRef.current?.messages.at(-1)
  const hasInitialViewCache = Boolean(
    initialViewCache
    && initialViewCache.messageCount === initialCacheRef.current?.messages.length
    && initialViewCache.latestMessageKey === (
      initialLatestMessage?.renderKey || initialLatestMessage?.id
    )
  )
  const initialContentOffsetRef = useRef<{ x: number; y: number } | undefined>(
    hasInitialViewCache && initialViewCache
      ? { x: 0, y: initialViewCache.bottomOffset }
      : undefined
  )
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialCacheRef.current?.messages || [])
  const [conversationId, setConversationId] = useState<string | null>(
    initialCacheRef.current?.conversationId || null
  )
  const [hasMoreHistory, setHasMoreHistory] = useState(
    () => initialCacheRef.current?.hasMoreHistory || false
  )
  const [oldestMessageCursor, setOldestMessageCursor] = useState<MessageHistoryCursor | undefined>(
    () => initialCacheRef.current?.oldestMessageCursor
  )
  const [initialPositionReady, setInitialPositionReady] = useState(hasInitialViewCache)
  const [activity, setActivity] = useState('Online')
  const [loadingHistory, setLoadingHistory] = useState(!initialCacheRef.current)
  const [sending, setSending] = useState(false)
  const [voiceMetadata, setVoiceMetadata] = useState<VoiceTranscriptMetadata | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [showScrollToLatest, setShowScrollToLatest] = useState(false)
  const [unseenLatestCount, setUnseenLatestCount] = useState(0)
  const [messageActionSession, setMessageActionSession] = useState<MessageActionSession | null>(null)
  const [messageActionMenuInteractive, setMessageActionMenuInteractive] = useState(true)
  const listRef = useAnimatedRef<FlatList<ChatMessage>>()
  const composerInputRef = useRef<TextInput>(null)
  const composerRegionRef = useRef<View>(null)
  const messagesRef = useRef(messages)
  const messageActionSessionRef = useRef<MessageActionSession | null>(null)
  const historyRequestRef = useRef(0)
  const historyHydrationRequestRef = useRef(0)
  const hydratedConversationKeyRef = useRef<string | null>(null)
  const historyPageRequestRef = useRef(0)
  const messageSyncRequestRef = useRef(0)
  const localDeliveryGenerationRef = useRef(0)
  const messageActionRequestRef = useRef(0)
  const messageActionMenuOpacity = useRef(new RNAnimated.Value(1)).current
  const messageActionReappearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messageSelectionBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messageActionPressRef = useRef(false)
  const nativeSelectionGestureRef = useRef<{
    generation: number
    messageKey: string
    selection: MessageSelectionRange
  } | null>(null)
  const composerFocusedRef = useRef(false)
  const quoteDraftRevisionRef = useRef(0)
  const sendingRef = useRef(false)
  const withinImmersiveRangeRef = useRef(true)
  const followLatestRef = useRef(true)
  const unseenLatestRef = useRef(false)
  const manualScrollRef = useRef(false)
  const initialScrollRef = useRef(!hasInitialViewCache)
  const initialScrollScheduledRef = useRef(false)
  const initialScrollFrameRef = useRef<number | null>(null)
  const loadingOlderHistoryRef = useRef(false)
  const prependHistoryAnchorRef = useRef<{
    contentHeight: number
    offsetY: number
  } | null>(null)
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
  const lastVoiceErrorRef = useRef<string | null>(null)
  const voiceInput = useVoiceInput({
    language: character?.language,
    onTranscriptChange: (text, metadata) => {
      if (!character) return
      setDraft(character.id, text)
      setVoiceMetadata(metadata)
    },
  })

  useEffect(() => {
    if (!voiceInput.error) {
      lastVoiceErrorRef.current = null
      return
    }
    if (lastVoiceErrorRef.current === voiceInput.error) return
    lastVoiceErrorRef.current = voiceInput.error
    Alert.alert('Voice input unavailable', voiceInput.error)
  }, [voiceInput.error])

  const closeMessageActionMenu = useCallback(() => {
    const session = messageActionSessionRef.current
    const restoreComposerFocus = Boolean(session?.preserveComposerFocus)
    messageActionRequestRef.current += 1
    if (messageActionReappearTimerRef.current) {
      clearTimeout(messageActionReappearTimerRef.current)
      messageActionReappearTimerRef.current = null
    }
    if (messageSelectionBlurTimerRef.current) {
      clearTimeout(messageSelectionBlurTimerRef.current)
      messageSelectionBlurTimerRef.current = null
    }
    if (restoreComposerFocus) composerInputRef.current?.focus()
    messageActionPressRef.current = false
    nativeSelectionGestureRef.current = null
    messageActionSessionRef.current = null
    setMessageActionSession(null)
    setMessageActionMenuInteractive(true)
    messageActionMenuOpacity.stopAnimation()
    messageActionMenuOpacity.setValue(1)
    if (restoreComposerFocus) {
      requestAnimationFrame(() => composerInputRef.current?.focus())
    }
  }, [messageActionMenuOpacity])

  const fadeOutMessageActionMenu = useCallback((generation: number) => {
    if (messageActionSessionRef.current?.generation !== generation) return
    if (messageActionReappearTimerRef.current) {
      clearTimeout(messageActionReappearTimerRef.current)
      messageActionReappearTimerRef.current = null
    }
    setMessageActionMenuInteractive(false)
    messageActionMenuOpacity.stopAnimation()
    RNAnimated.timing(messageActionMenuOpacity, {
      toValue: 0,
      duration: MESSAGE_ACTION_FADE_OUT_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start()
  }, [messageActionMenuOpacity])

  const scheduleMessageActionMenuReturn = useCallback((generation: number, delay: number) => {
    if (messageActionReappearTimerRef.current) {
      clearTimeout(messageActionReappearTimerRef.current)
    }
    messageActionReappearTimerRef.current = setTimeout(() => {
      messageActionReappearTimerRef.current = null
      const current = messageActionSessionRef.current
      if (!current || current.generation !== generation) return
      if (current.selectionAdjusting) {
        const next = { ...current, selectionAdjusting: false }
        messageActionSessionRef.current = next
        setMessageActionSession(next)
      }
      setMessageActionMenuInteractive(true)
      messageActionMenuOpacity.stopAnimation()
      RNAnimated.timing(messageActionMenuOpacity, {
        toValue: 1,
        duration: MESSAGE_ACTION_FADE_IN_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start()
    }, delay)
  }, [messageActionMenuOpacity])

  const updateMessageSelection = useCallback((
    messageKey: string,
    generation: number,
    selection: MessageSelectionRange
  ) => {
    const current = messageActionSessionRef.current
    if (!current
      || current.messageKey !== messageKey
      || current.generation !== generation) return
    const message = messagesRef.current.find(item => (
      (item.renderKey || item.id) === messageKey
    ))
    if (!message) return
    const start = clamp(selection.start, 0, message.text.length)
    const end = clamp(selection.end, 0, message.text.length)
    const isInitialFocusCollapse = Date.now() - current.openedAt < MESSAGE_SELECTION_INITIALIZE_MS
      && current.selection.start === 0
      && current.selection.end === message.text.length
      && start === end
    if (isInitialFocusCollapse) return
    const nativeGesture = nativeSelectionGestureRef.current
    if (nativeGesture
      && nativeGesture.messageKey === messageKey
      && nativeGesture.generation === generation) {
      nativeGesture.selection = { start, end }
      return
    }
    const currentStart = Math.min(current.selection.start, current.selection.end)
    const currentEnd = Math.max(current.selection.start, current.selection.end)
    const tappedOutsideSelectedText = start === end
      && (start < currentStart || start >= currentEnd)
    if (tappedOutsideSelectedText) {
      closeMessageActionMenu()
      return
    }
    if (current.selection.start === start && current.selection.end === end) return
    const next = {
      ...current,
      selection: { start, end },
      selectionAdjusting: true,
    }
    messageActionSessionRef.current = next
    nativeSelectionGestureRef.current = {
      generation,
      messageKey,
      selection: { start, end },
    }
    fadeOutMessageActionMenu(current.generation)
  }, [closeMessageActionMenu, fadeOutMessageActionMenu])

  const handleMessageSelectionTouchEnd = useCallback((
    messageKey: string,
    generation: number
  ) => {
    const session = messageActionSessionRef.current
    if (!session
      || session.messageKey !== messageKey
      || session.generation !== generation) return
    const nativeGesture = nativeSelectionGestureRef.current
    const selection = nativeGesture
      && nativeGesture.messageKey === messageKey
      && nativeGesture.generation === generation
      ? nativeGesture.selection
      : session.selection
    nativeSelectionGestureRef.current = null
    const next = { ...session, selection, selectionAdjusting: false }
    messageActionSessionRef.current = next
    setMessageActionSession(next)
    scheduleMessageActionMenuReturn(session.generation, MESSAGE_ACTION_REAPPEAR_DELAY_MS)
  }, [scheduleMessageActionMenuReturn])

  const handleMessageSelectionBlur = useCallback((messageKey: string, generation: number) => {
    if (messageSelectionBlurTimerRef.current) {
      clearTimeout(messageSelectionBlurTimerRef.current)
    }
    const closeAfterActionSettles = () => {
      messageSelectionBlurTimerRef.current = null
      const session = messageActionSessionRef.current
      if (!session
        || session.messageKey !== messageKey
        || session.generation !== generation) return
      if (messageActionPressRef.current) {
        messageSelectionBlurTimerRef.current = setTimeout(closeAfterActionSettles, 50)
        return
      }
      closeMessageActionMenu()
    }
    messageSelectionBlurTimerRef.current = setTimeout(closeAfterActionSettles, 0)
  }, [closeMessageActionMenu])

  useEffect(() => {
    if (!messageActionSession || Platform.OS !== 'android') return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      closeMessageActionMenu()
      return true
    })
    return () => subscription.remove()
  }, [closeMessageActionMenu, messageActionSession])

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
    unseenLatestRef.current = false
    setShowScrollToLatest(false)
    setUnseenLatestCount(0)
  }, [])

  const showLatestMessageButton = useCallback((count = 1) => {
    unseenLatestRef.current = true
    setShowScrollToLatest(true)
    setUnseenLatestCount(current => current + count)
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

  const prepareForIncomingMessage = useCallback((count = 1) => {
    // The initial page load can race the workspace sync. Until the first
    // transcript is positioned, server history is not an incoming delivery.
    if (initialScrollRef.current || messagesRef.current.length === 0) return
    closeMessageActionMenu()
    if (withinImmersiveRangeRef.current || followLatestRef.current) {
      startLatestScroll(withinImmersiveRangeRef.current)
      return
    }
    showLatestMessageButton(count)
  }, [closeMessageActionMenu, showLatestMessageButton, startLatestScroll])

  const handleComposerFocus = useCallback(() => {
    if (initialScrollRef.current) return
    composerFocusedRef.current = true
    if (initialScrollFrameRef.current !== null) {
      cancelAnimationFrame(initialScrollFrameRef.current)
      initialScrollFrameRef.current = null
    }
    initialScrollRef.current = false
    initialScrollScheduledRef.current = false
    setInitialPositionReady(true)
    startLatestScroll(withinImmersiveRangeRef.current)
  }, [startLatestScroll])

  const handleComposerBlur = useCallback(() => {
    composerFocusedRef.current = false
  }, [])

  const scrollToExactLatest = useCallback(() => {
    const { contentHeight, viewportHeight } = scrollMetricsRef.current
    if (contentHeight <= 0 || viewportHeight <= 0) return false
    // VirtualizedList.scrollToEnd approximates dynamic cell frames and can overscroll on mount.
    const offset = Math.max(0, contentHeight - viewportHeight)
    listRef.current?.scrollToOffset({ offset, animated: false })
    scrollMetricsRef.current.offsetY = offset
    return true
  }, [listRef])

  const resetInitialScroll = useCallback(() => {
    if (initialScrollFrameRef.current !== null) {
      cancelAnimationFrame(initialScrollFrameRef.current)
      initialScrollFrameRef.current = null
    }
    initialContentOffsetRef.current = undefined
    initialScrollRef.current = true
    initialScrollScheduledRef.current = false
    setInitialPositionReady(false)
  }, [])

  const settleInitialScroll = useCallback(() => {
    if (!initialScrollRef.current || initialScrollScheduledRef.current) return
    if (!scrollToExactLatest()) return
    initialScrollScheduledRef.current = true
    initialScrollFrameRef.current = requestAnimationFrame(() => {
      if (!initialScrollRef.current) return
      // Variable-height rows continue to mount after the first content-size
      // callback. Align across two frames before exposing the virtualized list.
      scrollToExactLatest()
      initialScrollFrameRef.current = requestAnimationFrame(() => {
        if (!initialScrollRef.current) return
        scrollToExactLatest()
        initialScrollRef.current = false
        initialScrollScheduledRef.current = false
        initialScrollFrameRef.current = null
        setInitialPositionReady(true)
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
      message.id === loadingId
        ? [{ ...firstMessage, renderKey: loadingId }]
        : [message]
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
            message.id === typingId
              ? { ...nextMessage, renderKey: typingId }
              : message
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
    if (messageActionReappearTimerRef.current) {
      clearTimeout(messageActionReappearTimerRef.current)
    }
    if (messageSelectionBlurTimerRef.current) {
      clearTimeout(messageSelectionBlurTimerRef.current)
    }
    messageActionMenuOpacity.stopAnimation()
  }, [latestScrollActive, latestScrollProgress, messageActionMenuOpacity])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => () => {
    if (!characterId) return
    const latestMessage = messagesRef.current.at(-1)
    const { contentHeight, viewportHeight } = scrollMetricsRef.current
    if (!latestMessage || contentHeight <= 0 || viewportHeight <= 0) return
    setConversationViewCache(characterId, {
      bottomOffset: Math.max(0, contentHeight - viewportHeight),
      latestMessageKey: latestMessage.renderKey || latestMessage.id,
      messageCount: messagesRef.current.length,
    })
  }, [characterId, setConversationViewCache])

  useEffect(() => {
    const pendingDeliveryMessageId = quotedMessage?.pendingDeliveryMessageId
    if (!characterId || !pendingDeliveryMessageId) return
    const delivered = messages.some(message => (
      message.sourceMessageId === pendingDeliveryMessageId
    ))
    if (!delivered) return
    const pendingText = quotedMessage.pendingDeliveryText?.trim()
    if (pendingText) {
      setDraft(characterId, current => (
        current.trim() === pendingText ? '' : current
      ))
    }
    quoteDraftRevisionRef.current += 1
    setQuoteDraft(characterId, null)
  }, [characterId, messages, quotedMessage, setDraft, setQuoteDraft])

  useEffect(() => {
    const pendingText = quotedMessage?.pendingDeliveryText
    if (!characterId || draft || !pendingText) return
    setDraft(characterId, pendingText)
  }, [characterId, draft, quotedMessage, setDraft])

  useEffect(() => {
    if (!characterId) return
    quoteDraftRevisionRef.current += 1
    unseenLatestRef.current = false
    setShowScrollToLatest(false)
    setUnseenLatestCount(0)
    closeMessageActionMenu()
    setActiveCharacter(characterId)
    return () => setActiveCharacter(null)
  }, [characterId, closeMessageActionMenu, setActiveCharacter])

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
    const hasPendingLocalDelivery = () => (
      sendingRef.current
      || stagedDeliveryTimersRef.current.size > 0
      || messagesRef.current.some(message => message.loading)
    )
    if (quiet && hasPendingLocalDelivery()) return
    const requestId = historyRequestRef.current + 1
    historyRequestRef.current = requestId
    const deliveryGeneration = localDeliveryGenerationRef.current
    const requestIsCurrent = () => (
      requestId === historyRequestRef.current
      && deliveryGeneration === localDeliveryGenerationRef.current
    )
    if (!quiet) setLoadingHistory(true)

    try {
      const conversations = await api.listConversations(userId)
      const matching = conversations
        .filter(conversation => conversation.characterId === character.id)
        .sort((left, right) => (
          (right.lastMessageAt || right.updatedAt || right.createdAt)
            .localeCompare(left.lastMessageAt || left.updatedAt || left.createdAt)
        ))[0]

      if (!requestIsCurrent()) return
      if (quiet && hasPendingLocalDelivery()) return
      if (!quiet) {
        latestScrollActive.value = false
        cancelAnimation(latestScrollProgress)
        resetInitialScroll()
        followLatestRef.current = true
        withinImmersiveRangeRef.current = true
        hideScrollToLatest()
      }

      if (!matching) {
        setConversationId(null)
        setHasMoreHistory(false)
        setOldestMessageCursor(undefined)
        const starterMessages: ChatMessage[] = [{
          id: `starter-${character.id}`,
          sender: 'assistant',
          text: starterMessageForCharacter(character),
        }]
        setMessages(starterMessages)
        setConversationCache(character.id, {
          conversationId: null,
          messages: starterMessages,
          hasMoreHistory: false,
          cachedAt: Date.now(),
        })
      } else {
        const messagePage = await api.listMessagePage(matching.id, { limit: HISTORY_PAGE_SIZE })
        if (!requestIsCurrent()) return
        if (quiet && hasPendingLocalDelivery()) return
        const cachedHistory = getConversationCache(character.id)
        const cachedMessages = cachedHistory?.messages || []
        const mappedMessages = mergeMessagePage(
          cachedMessages,
          mapMessages(messagePage.messages),
          'append'
        )
        const nextHasMoreHistory = cachedHistory?.hasMoreHistory ?? messagePage.hasMore
        const nextOldestMessageCursor = cachedHistory?.oldestMessageCursor ?? messagePage.nextCursor
        if (quiet) {
          const existingIds = new Set(messagesRef.current.map(message => message.id))
          const newAssistantMessageCount = mappedMessages.filter(message => (
            message.sender === 'assistant' && !existingIds.has(message.id)
          )).length
          if (newAssistantMessageCount > 0
            && !initialScrollRef.current
            && messagesRef.current.length > 0) {
            prepareForIncomingMessage(newAssistantMessageCount)
          }
        }
        setConversationId(matching.id)
        setHasMoreHistory(nextHasMoreHistory)
        setOldestMessageCursor(nextOldestMessageCursor)
        setMessages(mappedMessages)
        setConversationCache(character.id, {
          conversationId: matching.id,
          messages: mappedMessages,
          hasMoreHistory: nextHasMoreHistory,
          oldestMessageCursor: nextOldestMessageCursor,
          cachedAt: Date.now(),
        })
      }
      setError(null)
    } catch (loadError) {
      if (!requestIsCurrent()) return
      setError(loadError instanceof Error ? loadError.message : 'Could not load this conversation.')
    } finally {
      if (requestIsCurrent()) setLoadingHistory(false)
    }
  }, [
    character,
    getConversationCache,
    hideScrollToLatest,
    latestScrollActive,
    latestScrollProgress,
    prepareForIncomingMessage,
    resetInitialScroll,
    setConversationCache,
    userId,
  ])

  const loadConversationRef = useRef(loadConversation)
  useEffect(() => {
    loadConversationRef.current = loadConversation
  }, [loadConversation])

  useEffect(() => {
    const hydratedCharacterId = character?.id
    if (!hydratedCharacterId || !userId) return
    const hydrationKey = `${userId}:${hydratedCharacterId}`
    if (hydratedConversationKeyRef.current === hydrationKey) return
    hydratedConversationKeyRef.current = hydrationKey
    let cancelled = false
    const requestId = historyHydrationRequestRef.current + 1
    historyHydrationRequestRef.current = requestId
    const deliveryGeneration = localDeliveryGenerationRef.current

    void (async () => {
      const inMemoryHistory = getConversationCache(hydratedCharacterId)
      const inMemoryView = getConversationViewCache(hydratedCharacterId)
      const inMemoryLatestMessage = inMemoryHistory?.messages.at(-1)
      const canRestoreView = Boolean(
        inMemoryHistory
        && inMemoryView
        && inMemoryView.messageCount === inMemoryHistory.messages.length
        && inMemoryView.latestMessageKey === (
          inMemoryLatestMessage?.renderKey || inMemoryLatestMessage?.id
        )
      )
      if (!canRestoreView) resetInitialScroll()
      const cachedHistory = inMemoryHistory
        || await hydrateConversationCache(hydratedCharacterId)
      if (
        cancelled
        || requestId !== historyHydrationRequestRef.current
        || deliveryGeneration !== localDeliveryGenerationRef.current
      ) return

      if (!cachedHistory) {
        void loadConversationRef.current(false)
      } else {
        if (canRestoreView && inMemoryView) {
          initialContentOffsetRef.current = { x: 0, y: inMemoryView.bottomOffset }
          initialScrollRef.current = false
          initialScrollScheduledRef.current = false
          setInitialPositionReady(true)
        } else {
          resetInitialScroll()
        }
        messagesRef.current = cachedHistory.messages
        setMessages(cachedHistory.messages)
        setConversationId(cachedHistory.conversationId)
        setHasMoreHistory(Boolean(cachedHistory.hasMoreHistory))
        setOldestMessageCursor(cachedHistory.oldestMessageCursor)
        setLoadingHistory(false)
        if (Date.now() - cachedHistory.cachedAt > LOCAL_HISTORY_REFRESH_MS) {
          void loadConversationRef.current(true)
        }
      }
      void refreshState()
    })()

    return () => {
      cancelled = true
    }
  }, [
    character?.id,
    getConversationCache,
    getConversationViewCache,
    hydrateConversationCache,
    refreshState,
    resetInitialScroll,
    userId,
  ])

  useEffect(() => {
    if (!characterId || loadingHistory || messages.some(message => message.loading)) return
    setConversationCache(characterId, {
      conversationId,
      messages,
      hasMoreHistory,
      oldestMessageCursor,
      cachedAt: Date.now(),
    })
  }, [
    characterId,
    conversationId,
    hasMoreHistory,
    loadingHistory,
    messages,
    oldestMessageCursor,
    setConversationCache,
  ])

  useEffect(() => {
    if (!loadingHistory && messages.length > 0) settleInitialScroll()
  }, [loadingHistory, messages.length, settleInitialScroll])

  const syncMessages = useCallback(async () => {
    if (!conversationId || sendingRef.current) return
    const syncRequestId = messageSyncRequestRef.current + 1
    messageSyncRequestRef.current = syncRequestId
    const requestVersion = historyRequestRef.current
    const deliveryGeneration = localDeliveryGenerationRef.current
    try {
      const messagePage = await api.listMessagePage(conversationId, { limit: HISTORY_PAGE_SIZE })
      if (syncRequestId !== messageSyncRequestRef.current
        || requestVersion !== historyRequestRef.current
        || deliveryGeneration !== localDeliveryGenerationRef.current
        || sendingRef.current) return
      const mapped = mapMessages(messagePage.messages)
      const currentMessages = messagesRef.current
      if (currentMessages.some(message => message.loading)
        || stagedDeliveryTimersRef.current.size > 0) {
        return
      }
      const knownIds = new Set(currentMessages.map(message => message.id))
      const newAssistantMessageCount = mapped.filter(message => (
        message.sender === 'assistant' && !knownIds.has(message.id)
      )).length
      if (newAssistantMessageCount > 0
        && !initialScrollRef.current
        && currentMessages.length > 0) {
        prepareForIncomingMessage(newAssistantMessageCount)
      }
      setMessages(current => {
        if (syncRequestId !== messageSyncRequestRef.current
          || requestVersion !== historyRequestRef.current
          || deliveryGeneration !== localDeliveryGenerationRef.current
          || sendingRef.current
          || current.some(message => message.loading)
          || stagedDeliveryTimersRef.current.size > 0) {
          return current
        }
        const existingIds = new Set(current.map(message => message.id))
        let animationIndex = 0
        const next = mergeMessagePage(current, mapped, 'append').map(message => {
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
    const hasPendingVoice = messages.some(message => message.voice?.status === 'pending')
    const interval = setInterval(() => void syncMessages(), hasPendingVoice ? 3_000 : 15_000)
    return () => clearInterval(interval)
  }, [conversationId, messages, syncMessages])

  const loadOlderHistory = useCallback(async () => {
    if (!conversationId
      || !hasMoreHistory
      || !oldestMessageCursor
      || loadingOlderHistoryRef.current) return

    loadingOlderHistoryRef.current = true
    const pageRequestId = historyPageRequestRef.current + 1
    historyPageRequestRef.current = pageRequestId
    const historyRequestId = historyRequestRef.current
    const deliveryGeneration = localDeliveryGenerationRef.current
    const anchor = { ...scrollMetricsRef.current }

    try {
      const messagePage = await api.listMessagePage(conversationId, {
        limit: HISTORY_PAGE_SIZE,
        before: oldestMessageCursor,
      })
      if (pageRequestId !== historyPageRequestRef.current
        || historyRequestId !== historyRequestRef.current
        || deliveryGeneration !== localDeliveryGenerationRef.current) return

      const olderMessages = mapMessages(messagePage.messages)
      if (olderMessages.length > 0) {
        prependHistoryAnchorRef.current = {
          contentHeight: anchor.contentHeight,
          offsetY: anchor.offsetY,
        }
        setMessages(current => mergeMessagePage(current, olderMessages, 'prepend'))
      }
      setHasMoreHistory(messagePage.hasMore)
      setOldestMessageCursor(messagePage.nextCursor)
    } catch {
      // Keep the current page and let the next top-edge gesture retry the request.
    } finally {
      if (pageRequestId === historyPageRequestRef.current) {
        loadingOlderHistoryRef.current = false
      }
    }
  }, [conversationId, hasMoreHistory, oldestMessageCursor])

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
      historyRequestRef.current += 1
      historyPageRequestRef.current += 1
      messageSyncRequestRef.current += 1
      loadingOlderHistoryRef.current = false
      prependHistoryAnchorRef.current = null
      clearConversationCache(character.id)
      setConversationId(null)
      setHasMoreHistory(false)
      setOldestMessageCursor(undefined)
      setInitialPositionReady(false)
      setMessages([{
        id: `starter-${character.id}-${Date.now()}`,
        sender: 'assistant',
        text: starterMessageForCharacter(character),
      }])
      resetInitialScroll()
      latestScrollActive.value = false
      cancelAnimation(latestScrollProgress)
      hideScrollToLatest()
      quoteDraftRevisionRef.current += 1
      setQuoteDraft(character.id, null)
      closeMessageActionMenu()
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
    closeMessageActionMenu()
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

  const toggleVoiceTranscript = (message: ChatMessage) => {
    closeMessageActionMenu()
    if (message.voice?.status !== 'ready') return
    setMessages(current => current.map(item => (
      item.id === message.id
        ? { ...item, voiceTranscriptVisible: !item.voiceTranscriptVisible }
        : item
    )))
  }

  const copyMessage = async (message: ChatMessage) => {
    const session = messageActionSessionRef.current
    const selection = session?.messageKey === (message.renderKey || message.id)
      ? session.selection
      : { start: 0, end: message.text.length }
    const start = clamp(Math.min(selection.start, selection.end), 0, message.text.length)
    const end = clamp(Math.max(selection.start, selection.end), 0, message.text.length)
    const selectedText = message.text.slice(start, end)
    closeMessageActionMenu()
    if (selectedText) await Clipboard.setStringAsync(selectedText)
  }

  const openMessageActionMenu = (message: ChatMessage, anchor: MessageAnchor) => {
    const requestId = messageActionRequestRef.current + 1
    messageActionRequestRef.current = requestId
    const messageKey = message.renderKey || message.id
    const preserveComposerFocus = composerFocusedRef.current
    const fallbackBottom = window.height - insets.bottom
    const open = (usableBottom: number) => {
      if (requestId !== messageActionRequestRef.current) return
      const messageStillExists = messagesRef.current.some(item => (
        (item.renderKey || item.id) === messageKey
      ))
      if (!messageStillExists) return
      if (messageActionReappearTimerRef.current) {
        clearTimeout(messageActionReappearTimerRef.current)
        messageActionReappearTimerRef.current = null
      }
      if (messageSelectionBlurTimerRef.current) {
        clearTimeout(messageSelectionBlurTimerRef.current)
        messageSelectionBlurTimerRef.current = null
      }
      messageActionMenuOpacity.stopAnimation()
      messageActionMenuOpacity.setValue(1)
      setMessageActionMenuInteractive(true)
      const session: MessageActionSession = {
        anchor,
        generation: requestId,
        messageKey,
        openedAt: Date.now(),
        preserveComposerFocus,
        selection: { start: 0, end: message.text.length },
        selectionAdjusting: false,
        selectionControlled: true,
        usableBottom,
      }
      messageActionSessionRef.current = session
      setMessageActionSession(session)
      if (Platform.OS === 'ios') {
        requestAnimationFrame(() => {
          const current = messageActionSessionRef.current
          if (!current || current.generation !== requestId) return
          const next = { ...current, selectionControlled: false }
          messageActionSessionRef.current = next
          setMessageActionSession(next)
        })
      }
    }

    if (!composerRegionRef.current) {
      open(fallbackBottom)
      return
    }
    composerRegionRef.current.measureInWindow((_x, y) => {
      open(y > insets.top ? Math.min(fallbackBottom, y) : fallbackBottom)
    })
  }

  const quoteMessage = (message: ChatMessage) => {
    if (!character) return
    closeMessageActionMenu()
    quoteDraftRevisionRef.current += 1
    setQuoteDraft(character.id, {
      sourceMessageId: message.sourceMessageId,
      sourceRenderKey: message.renderKey || message.id,
      segmentIndex: message.segmentIndex || 0,
      senderRole: message.sender,
      senderName: message.sender === 'assistant' ? character.name : 'You',
      text: message.text,
    })
    requestAnimationFrame(() => {
      composerInputRef.current?.focus()
      startLatestScroll(withinImmersiveRangeRef.current)
    })
  }

  const clearQuotedMessage = () => {
    if (!character) return
    quoteDraftRevisionRef.current += 1
    setQuoteDraft(character.id, null)
    requestAnimationFrame(() => startLatestScroll(withinImmersiveRangeRef.current))
  }

  const sendMessage = async (messageToRetry?: ChatMessage) => {
    const composerText = messageToRetry ? messageToRetry.text.trim() : draft.trim()
    if (!composerText || !character || !userId || sendingRef.current) return

    localDeliveryGenerationRef.current += 1
    const deliveryGeneration = localDeliveryGenerationRef.current
    const isCurrentDelivery = () => (
      deliveryGeneration === localDeliveryGenerationRef.current
    )
    sendingRef.current = true
    setSending(true)
    setError(null)
    let quoteDraftForSend = messageToRetry ? null : quotedMessage
    let textForSend = composerText
    const voice = !messageToRetry && voiceMetadata?.originalText
      ? {
          ...voiceMetadata,
          correctedText: voiceMetadata.correctedText
            || (composerText !== voiceMetadata.originalText ? composerText : undefined),
        }
      : undefined
    let userMessageId = messageToRetry?.sourceMessageId || messageToRetry?.id || createLocalId()
    let conversationIdForSend = conversationId || undefined
    let retryingPendingDelivery = false
    const pendingDeliveryMessageId = quoteDraftForSend?.pendingDeliveryMessageId
    if (!messageToRetry && pendingDeliveryMessageId && quoteDraftForSend) {
      const pendingQuoteDraft = quoteDraftForSend
      try {
        const status = await api.getMessageDeliveryStatus(userId, pendingDeliveryMessageId)
        if (status.persisted) {
          const pendingText = pendingQuoteDraft.pendingDeliveryText?.trim()
          quoteDraftRevisionRef.current += 1
          setQuoteDraft(character.id, null)
          quoteDraftForSend = null
          if (status.conversationId) setConversationId(status.conversationId)
          setMessages(current => {
            const confirmedMessage = current.find(message => (
              message.id === pendingDeliveryMessageId
            ))
            if (confirmedMessage) {
              return current.map(message => (
                message.id === pendingDeliveryMessageId
                  ? { ...message, sourceMessageId: pendingDeliveryMessageId, segmentIndex: 0 }
                  : message
              ))
            }
            return [...current, {
              id: pendingDeliveryMessageId,
              renderKey: pendingDeliveryMessageId,
              sourceMessageId: pendingDeliveryMessageId,
              segmentIndex: 0,
              sender: 'user',
              text: pendingQuoteDraft.pendingDeliveryText || composerText,
              quote: {
                sourceMessageId: pendingQuoteDraft.sourceMessageId,
                segmentIndex: pendingQuoteDraft.segmentIndex,
                senderRole: pendingQuoteDraft.senderRole,
                senderName: pendingQuoteDraft.senderName,
                text: pendingQuoteDraft.text,
              },
            }]
          })
          if (pendingText && pendingText === composerText) {
            setDraft(character.id, current => (
              current.trim() === pendingText ? '' : current
            ))
            sendingRef.current = false
            setSending(false)
            return
          }
        } else {
          retryingPendingDelivery = true
          userMessageId = pendingDeliveryMessageId
          textForSend = pendingQuoteDraft.pendingDeliveryText || composerText
          conversationIdForSend = pendingQuoteDraft.pendingDeliveryConversationId
            || conversationIdForSend
          quoteDraftForSend = {
            ...pendingQuoteDraft,
            pendingDeliveryMessageId: undefined,
            pendingDeliveryText: undefined,
            pendingDeliveryConversationId: undefined,
          }
        }
      } catch {
        setError('Could not confirm whether the previous quoted message was sent. Try again when connected.')
        sendingRef.current = false
        setSending(false)
        return
      }
    }

    historyRequestRef.current += 1
    const text = textForSend
    const quote: MessageQuote | undefined = messageToRetry?.quote || (quoteDraftForSend
      ? {
          sourceMessageId: quoteDraftForSend.sourceMessageId,
          segmentIndex: quoteDraftForSend.segmentIndex,
          senderRole: quoteDraftForSend.senderRole,
          senderName: quoteDraftForSend.senderName,
          text: quoteDraftForSend.text,
        }
      : undefined)
    const userMessage: ChatMessage = messageToRetry
      ? {
          ...messageToRetry,
          id: userMessageId,
          renderKey: messageToRetry.renderKey || userMessageId,
          deliveryState: 'sending',
          quote,
        }
      : {
          id: userMessageId,
          renderKey: userMessageId,
          sender: 'user',
          text,
          quote,
          deliveryState: 'sending',
        }
    const loadingId = createLocalId()
    const loadingMessage: ChatMessage = {
      id: loadingId,
      sender: 'assistant',
      text: '',
      loading: true,
    }

    startLatestScroll(withinImmersiveRangeRef.current)
    const quoteClearRevision = !messageToRetry && quoteDraftForSend
      ? quoteDraftRevisionRef.current + 1
      : undefined
    if (!messageToRetry) {
      setDraft(character.id, current => (
        !retryingPendingDelivery || current.trim() === text ? '' : current
      ))
      if (quoteClearRevision !== undefined) {
        quoteDraftRevisionRef.current = quoteClearRevision
      }
      setQuoteDraft(character.id, null)
      setVoiceMetadata(undefined)
      voiceInput.reset()
    }
    closeMessageActionMenu()
    markConversationActive(character.id)
    setMessages(current => {
      const hasExistingUserMessage = current.some(message => message.id === userMessage.id)
      return [
        ...current.map(message => (
          message.id === userMessage.id
            ? { ...message, ...userMessage, deliveryState: 'sending' as const }
            : message
        )),
        ...(hasExistingUserMessage ? [] : [userMessage]),
        loadingMessage,
      ]
    })
    let userMessageConfirmed = false
    let deliveryTimeout: ReturnType<typeof setTimeout> | undefined

    const confirmUserMessage = (sourceMessageId: string) => {
      userMessageConfirmed = true
      setQuoteDraft(character.id, current => (
        current && current.sourceRenderKey === userMessage.renderKey
          ? { ...current, sourceMessageId }
          : current
      ))
      setMessages(current => current.map(message => (
        message.id === userMessage.id
          ? {
              ...message,
              id: sourceMessageId,
              sourceMessageId,
              segmentIndex: 0,
              deliveryState: undefined,
            }
          : message
      )))
    }

    deliveryTimeout = setTimeout(() => {
      if (!isCurrentDelivery() || userMessageConfirmed) return
      setMessages(current => current.map(message => (
        message.id === userMessage.id && message.deliveryState === 'sending'
          ? { ...message, deliveryState: 'failed' }
          : message
      )))
      // The network request may still be resolving its final status check. Release the
      // composer now so the retry affordance behaves as soon as it becomes visible.
      sendingRef.current = false
      setSending(false)
    }, OUTGOING_DELIVERY_TIMEOUT_MS)

    try {
      const response = await api.sendMessage({
        message: text,
        clientMessageId: userMessageId,
        conversationId: conversationIdForSend,
        userId,
        character,
        quote,
        voice,
      })
      if (!isCurrentDelivery()) return
      if (response.userMessageId) {
        confirmUserMessage(response.userMessageId)
      }
      markConversationActive(character.id)
      setConversationId(response.conversationId)
      if (response.behavior?.activity) setActivity(formatActivity(response.behavior.activity))

      if (response.reply === null || response.behavior?.decision === 'no_reply') {
        setMessages(current => current.filter(message => message.id !== loadingId))
        if (response.behavior?.decision === 'already_persisted') {
          void syncMessages()
        }
      } else if (typeof response.reply === 'string') {
        const incomingMessages = responseMessages(response)
        if (incomingMessages.length === 0) throw new Error('The server returned no usable response.')
        stageAssistantMessages(loadingId, incomingMessages)
      } else {
        throw new Error('The server returned no usable response.')
      }
    } catch (sendError) {
      if (!isCurrentDelivery()) return
      setMessages(current => current.filter(message => message.id !== loadingId))
      const persistedUserMessageId = sendError instanceof ApiError
        && sendError.payload?.messagePersisted === true
        && typeof sendError.payload.userMessageId === 'string'
        ? sendError.payload.userMessageId
        : undefined
      const persistedConversationId = sendError instanceof ApiError
        && typeof sendError.payload?.conversationId === 'string'
        ? sendError.payload.conversationId
        : undefined
      let reconciledUserMessageId = persistedUserMessageId
      let reconciledConversationId = persistedConversationId
      if (!userMessageConfirmed && !reconciledUserMessageId) {
        try {
          const status = await api.getMessageDeliveryStatus(userId, userMessageId)
          if (status.persisted && status.userMessageId) {
            reconciledUserMessageId = status.userMessageId
            reconciledConversationId = status.conversationId
          }
        } catch {
          // The exact client message ID makes this safe to reconcile on the next sync.
        }
      }
      if (!isCurrentDelivery()) return
      if (reconciledUserMessageId) {
        confirmUserMessage(reconciledUserMessageId)
        if (reconciledConversationId) setConversationId(reconciledConversationId)
        void syncMessages()
      } else if (!userMessageConfirmed) {
        setMessages(current => current.map(message => (
          message.id === userMessage.id
            ? { ...message, deliveryState: 'failed' }
            : message
        )))
      }
    } finally {
      if (deliveryTimeout) clearTimeout(deliveryTimeout)
      if (isCurrentDelivery()) {
        sendingRef.current = false
        setSending(false)
        void refreshState()
      }
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
    if (manualScrollRef.current && contentOffset.y <= OLDER_HISTORY_TRIGGER_OFFSET) {
      void loadOlderHistory()
    }
  }

  const handleListLayout = (event: LayoutChangeEvent) => {
    closeMessageActionMenu()
    const viewportHeight = event.nativeEvent.layout.height
    scrollMetricsRef.current.viewportHeight = viewportHeight
    scrollViewportHeight.value = viewportHeight
    settleInitialScroll()
  }

  const handleContentSizeChange = (_width: number, height: number) => {
    scrollMetricsRef.current.contentHeight = height
    scrollContentHeight.value = height
    const prependAnchor = prependHistoryAnchorRef.current
    if (prependAnchor && height > prependAnchor.contentHeight) {
      const offset = Math.max(0, prependAnchor.offsetY + height - prependAnchor.contentHeight)
      listRef.current?.scrollToOffset({ offset, animated: false })
      scrollMetricsRef.current.offsetY = offset
      prependHistoryAnchorRef.current = null
      return
    }
    if (initialScrollRef.current) {
      settleInitialScroll()
      return
    }
    if (followLatestRef.current) {
      if (!latestScrollActive.value) {
        scrollToExactLatest()
      }
    }
  }

  const handleComposerTextChange = (text: string) => {
    if (!character) return
    setDraft(character.id, text)
    if (voiceMetadata && voiceInput.status !== 'recording') {
      setVoiceMetadata(previous => previous
        ? {
            ...previous,
            correctedText: text.trim() && text.trim() !== previous.originalText
              ? text.trim()
              : undefined,
          }
        : previous)
    }
  }

  const handleVoicePress = () => {
    if (voiceInput.status !== 'recording') setVoiceMetadata(undefined)
    voiceInput.toggle(draft)
  }

  const messageActionMessage = messageActionSession
    ? messages.find(message => (
        (message.renderKey || message.id) === messageActionSession.messageKey
      ))
    : undefined
  const messageActionLayout = messageActionSession && messageActionMessage
    ? getMessageActionLayout({
        anchor: messageActionSession.anchor,
        viewportWidth: window.width,
        viewportHeight: window.height,
        safeLeft: insets.left,
        safeRight: insets.right,
        safeTop: insets.top,
        safeBottom: insets.bottom,
        usableBottom: messageActionSession.usableBottom,
      })
    : null
  const messageSelectionHole = messageActionSession
    ? {
        top: clamp(
          messageActionSession.anchor.y - MESSAGE_SELECTION_HIT_PADDING,
          0,
          window.height
        ),
        right: clamp(
          messageActionSession.anchor.x
            + messageActionSession.anchor.width
            + MESSAGE_SELECTION_HIT_PADDING,
          0,
          window.width
        ),
        bottom: clamp(
          messageActionSession.anchor.y
            + messageActionSession.anchor.height
            + MESSAGE_SELECTION_HIT_PADDING,
          0,
          window.height
        ),
        left: clamp(
          messageActionSession.anchor.x - MESSAGE_SELECTION_HIT_PADDING,
          0,
          window.width
        ),
      }
    : null

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
              contentOffset={initialContentOffsetRef.current}
              disableVirtualization={!initialPositionReady}
              initialNumToRender={Math.max(1, messages.length)}
              maxToRenderPerBatch={Math.max(1, messages.length)}
              keyExtractor={item => item.renderKey || item.id}
              renderItem={({ item }) => {
                const messageKey = item.renderKey || item.id
                const selectionSession = messageActionSession?.messageKey === messageKey
                  ? messageActionSession
                  : undefined
                return (
                  <MessageRow
                    message={item}
                    characterName={character.name}
                    characterAvatar={character.avatar}
                    onEditCharacter={openEditor}
                    onLongPress={openMessageActionMenu}
                    selecting={Boolean(selectionSession)}
                    selection={selectionSession?.selection}
                    selectionAdjusting={Boolean(selectionSession?.selectionAdjusting)}
                    selectionControlled={Boolean(selectionSession?.selectionControlled)}
                    preserveKeyboard={Boolean(selectionSession?.preserveComposerFocus)}
                    onSelectionBlur={() => {
                      if (selectionSession) {
                        handleMessageSelectionBlur(messageKey, selectionSession.generation)
                      }
                    }}
                    onSelectionChange={selection => {
                      if (selectionSession) {
                        updateMessageSelection(
                          messageKey,
                          selectionSession.generation,
                          selection
                        )
                      }
                    }}
                    onSelectionOutsideTap={closeMessageActionMenu}
                    onSelectionTouchEnd={() => {
                      if (selectionSession) {
                        handleMessageSelectionTouchEnd(
                          messageKey,
                          selectionSession.generation
                        )
                      }
                    }}
                    onRetryMessage={message => void sendMessage(message)}
                  />
                )
              }}
              style={[
                styles.messageList,
                !initialPositionReady && styles.messageListPositioning,
              ]}
              contentContainerStyle={styles.messageListContent}
              removeClippedSubviews={!messageActionSession}
              scrollEnabled={!messageActionSession}
              keyboardShouldPersistTaps={messageActionSession ? 'always' : 'handled'}
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              onLayout={handleListLayout}
              onScroll={handleScroll}
              onScrollBeginDrag={() => {
                closeMessageActionMenu()
                manualScrollRef.current = true
                followLatestRef.current = false
                latestScrollActive.value = false
                cancelAnimation(latestScrollProgress)
              }}
              onScrollEndDrag={() => {
                manualScrollRef.current = false
                followLatestRef.current = withinImmersiveRangeRef.current
              }}
              onTouchEnd={() => {
                if (!messageActionSessionRef.current && composerFocusedRef.current) {
                  Keyboard.dismiss()
                }
              }}
              onMomentumScrollEnd={() => {
                manualScrollRef.current = false
                followLatestRef.current = withinImmersiveRangeRef.current
              }}
              onContentSizeChange={handleContentSizeChange}
              scrollEventThrottle={16}
            />
            {!initialPositionReady && messages.length > 0 && (
              <View pointerEvents="none" style={styles.initialHistoryPositioning}>
                <ActivityIndicator size="small" color={palette.accent} />
              </View>
            )}
          </Reanimated.View>

          <Reanimated.View style={composerKeyboardAnimatedStyle}>
            {error && (
              <Pressable onPress={() => void loadConversation(true)} style={styles.errorBanner}>
                <Ionicons name="alert-circle-outline" size={18} color={palette.danger} />
                <Text style={styles.errorBannerText} numberOfLines={2}>{error}</Text>
                <Ionicons name="refresh" size={18} color={palette.danger} />
              </Pressable>
            )}

            <View ref={composerRegionRef} collapsable={false} style={styles.composerRegion}>
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
                  <Ionicons name="arrow-down" size={18} color={palette.text} />
                  <Text style={styles.scrollToLatestLabel}>
                    {unseenLatestCount > 1 ? `${unseenLatestCount} new messages` : 'New message'}
                  </Text>
                </Pressable>
              )}

              <View style={[
                styles.composer,
                { paddingBottom: Math.max(8, insets.bottom) },
              ]}>
                <View style={styles.composerInputRow}>
                  <TextInput
                    ref={composerInputRef}
                    value={draft}
                    onChangeText={handleComposerTextChange}
                    placeholder="Type your message..."
                    placeholderTextColor="#8A94A3"
                    multiline
                    maxLength={20_000}
                    style={styles.composerInput}
                    textAlignVertical="center"
                    onFocus={handleComposerFocus}
                    onBlur={handleComposerBlur}
                  />
                  <Pressable
                    onPress={handleVoicePress}
                    disabled={voiceInput.status === 'processing'}
                    accessibilityRole="button"
                    accessibilityLabel={voiceInput.error
                      ? `Voice input unavailable: ${voiceInput.error}`
                      : voiceInput.status === 'recording' ? 'Stop voice input' : 'Start voice input'}
                    accessibilityState={{
                      busy: voiceInput.status === 'processing',
                      selected: voiceInput.status === 'recording',
                    }}
                    style={({ pressed }) => [
                      styles.voiceButton,
                      voiceInput.status === 'recording' && styles.voiceButtonRecording,
                      voiceInput.status === 'error' && styles.voiceButtonError,
                      voiceInput.status === 'processing' && styles.voiceButtonDisabled,
                      pressed && voiceInput.status !== 'processing' && styles.voiceButtonPressed,
                    ]}
                  >
                    <Ionicons
                      name={voiceInput.status === 'recording'
                        ? 'stop'
                        : voiceInput.status === 'processing'
                          ? 'ellipsis-horizontal'
                          : 'mic-outline'}
                      size={21}
                      color={voiceInput.status === 'error' ? palette.danger : palette.accent}
                    />
                  </Pressable>
                  <Pressable
                    onPress={() => void sendMessage()}
                    disabled={
                      !draft.trim()
                      || sending
                      || voiceInput.status === 'recording'
                      || voiceInput.status === 'processing'
                    }
                    accessibilityRole="button"
                    accessibilityLabel="Send message"
                    style={({ pressed }) => [
                      styles.sendButton,
                      (!draft.trim() || sending || voiceInput.status === 'recording' || voiceInput.status === 'processing')
                        && styles.sendButtonDisabled,
                      pressed && draft.trim() && !sending && voiceInput.status === 'idle' && styles.sendButtonPressed,
                    ]}
                  >
                    {sending
                      ? <ActivityIndicator size="small" color="#FFFFFF" />
                      : <Ionicons name="arrow-up" size={22} color="#FFFFFF" />}
                  </Pressable>
                </View>
                {quotedMessage && (
                  <View style={styles.composerQuote}>
                    <Text style={styles.composerQuoteText} numberOfLines={2}>
                      <Text style={styles.composerQuoteAuthor}>{quotedMessage.senderName}: </Text>
                      {quotedMessage.text}
                    </Text>
                    <Pressable
                      onPress={clearQuotedMessage}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Remove quote"
                      style={({ pressed }) => [
                        styles.composerQuoteClose,
                        pressed && styles.composerQuoteClosePressed,
                      ]}
                    >
                      <Ionicons name="close-circle" size={19} color="#98A2B3" />
                    </Pressable>
                  </View>
                )}
              </View>
            </View>
          </Reanimated.View>
        </View>
      </View>

      {messageActionSession && messageActionMessage && messageActionLayout && messageSelectionHole && (
        <View pointerEvents="box-none" style={styles.messageActionOverlay}>
          <Pressable
            accessible={false}
            onPress={closeMessageActionMenu}
            style={[
              styles.messageActionDismissRegion,
              { top: 0, left: 0, right: 0, height: messageSelectionHole.top },
            ]}
          />
          <Pressable
            accessible={false}
            onPress={closeMessageActionMenu}
            style={[
              styles.messageActionDismissRegion,
              { top: messageSelectionHole.bottom, left: 0, right: 0, bottom: 0 },
            ]}
          />
          <Pressable
            accessible={false}
            onPress={closeMessageActionMenu}
            style={[
              styles.messageActionDismissRegion,
              {
                top: messageSelectionHole.top,
                left: 0,
                width: messageSelectionHole.left,
                height: Math.max(0, messageSelectionHole.bottom - messageSelectionHole.top),
              },
            ]}
          />
          <Pressable
            accessible={false}
            onPress={closeMessageActionMenu}
            style={[
              styles.messageActionDismissRegion,
              {
                top: messageSelectionHole.top,
                left: messageSelectionHole.right,
                right: 0,
                height: Math.max(0, messageSelectionHole.bottom - messageSelectionHole.top),
              },
            ]}
          />
          <RNAnimated.View
            accessibilityViewIsModal
            pointerEvents={messageActionMenuInteractive ? 'auto' : 'none'}
            style={[
              styles.messageActionMenu,
              {
                left: messageActionLayout.left,
                opacity: messageActionMenuOpacity,
                top: messageActionLayout.top,
                width: messageActionLayout.width,
              },
            ]}
          >
            <View
              pointerEvents="none"
              style={[
                styles.messageActionArrow,
                { left: messageActionLayout.arrowLeft },
                messageActionLayout.placement === 'below'
                  ? styles.messageActionArrowTop
                  : styles.messageActionArrowBottom,
              ]}
            />
            <Pressable
              disabled={messageActionSession.selection.start === messageActionSession.selection.end}
              onPressIn={() => {
                messageActionPressRef.current = true
              }}
              onPressOut={() => {
                messageActionPressRef.current = false
              }}
              onPress={() => void copyMessage(messageActionMessage)}
              style={({ pressed }) => [
                styles.messageAction,
                messageActionSession.selection.start === messageActionSession.selection.end
                  && styles.messageActionDisabled,
                pressed && styles.messageActionPressed,
              ]}
            >
              <Ionicons name="copy-outline" size={18} color="#FFFFFF" />
              <Text style={styles.messageActionLabel}>Copy</Text>
            </Pressable>
            <View style={styles.messageActionDivider} />
            <Pressable
              onPressIn={() => {
                messageActionPressRef.current = true
              }}
              onPressOut={() => {
                messageActionPressRef.current = false
              }}
              onPress={() => quoteMessage(messageActionMessage)}
              style={({ pressed }) => [styles.messageAction, pressed && styles.messageActionPressed]}
            >
              <Ionicons name="return-up-back-outline" size={19} color="#FFFFFF" />
              <Text style={styles.messageActionLabel}>Quote</Text>
            </Pressable>
            <View style={styles.messageActionDivider} />
            <Pressable
              onPressIn={() => {
                messageActionPressRef.current = true
              }}
              onPressOut={() => {
                messageActionPressRef.current = false
              }}
              onPress={() => void translateMessage(messageActionMessage)}
              style={({ pressed }) => [
                styles.messageAction,
                pressed && styles.messageActionPressed,
              ]}
            >
              <Ionicons name="language-outline" size={18} color="#FFFFFF" />
              <Text style={styles.messageActionLabel}>
                {messageActionMessage.translationVisible ? 'Hide' : 'Translate'}
              </Text>
            </Pressable>
            {messageActionMessage.voice?.status === 'ready' && (
              <>
                <View style={styles.messageActionDivider} />
                <Pressable
                  onPressIn={() => {
                    messageActionPressRef.current = true
                  }}
                  onPressOut={() => {
                    messageActionPressRef.current = false
                  }}
                  onPress={() => toggleVoiceTranscript(messageActionMessage)}
                  style={({ pressed }) => [styles.messageAction, pressed && styles.messageActionPressed]}
                >
                  <Ionicons name="document-text-outline" size={18} color="#FFFFFF" />
                  <Text style={styles.messageActionLabel}>
                    {messageActionMessage.voiceTranscriptVisible ? 'Hide text' : 'Show text'}
                  </Text>
                </Pressable>
              </>
            )}
          </RNAnimated.View>
        </View>
      )}
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
  messageListPositioning: {
    opacity: 0,
  },
  initialHistoryPositioning: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.background,
  },
  messageListContent: {
    paddingHorizontal: 12,
    paddingTop: 18,
    paddingBottom: MESSAGE_LIST_BOTTOM_PADDING,
  },
  messageRow: {
    width: '100%',
    marginBottom: MESSAGE_ROW_GAP,
    flexDirection: 'column',
  },
  messagePrimaryRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  messageRowGrouped: {
    marginBottom: 6,
  },
  messagePrimaryRowAssistant: {
    justifyContent: 'flex-start',
  },
  messagePrimaryRowUser: {
    justifyContent: 'flex-end',
  },
  messageContent: {
    maxWidth: '76%',
    alignItems: 'flex-start',
    position: 'relative',
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
  bubbleAnchor: {
    maxWidth: '100%',
  },
  bubbleAnchorSelecting: {
    zIndex: 4,
    overflow: 'visible',
  },
  messageDeliveryIndicator: {
    position: 'absolute',
    top: '50%',
    right: '100%',
    width: 22,
    height: 22,
    marginRight: 9,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateY: -11 }],
  },
  messageDeliveryFailed: {
    borderRadius: 11,
    backgroundColor: palette.danger,
  },
  messageDeliveryFailedPressed: {
    opacity: 0.68,
    transform: [{ translateY: -11 }, { scale: 0.94 }],
  },
  bubble: {
    minHeight: 38,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 8,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  bubbleSelecting: {
    overflow: 'visible',
  },
  bubbleContent: {
    position: 'relative',
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
    includeFontPadding: false,
  },
  userMessageText: {
    color: '#FFFFFF',
  },
  messageSelectionInput: {
    ...StyleSheet.absoluteFillObject,
    margin: 0,
    padding: 0,
    backgroundColor: 'transparent',
    textAlignVertical: 'top',
    includeFontPadding: false,
    transform: [{ translateY: Platform.OS === 'ios' ? -4 * StyleSheet.hairlineWidth : 0 }],
  },
  messageSelectionMeasurement: {
    opacity: 0,
    includeFontPadding: false,
  },
  messageSupplement: {
    width: '76%',
    marginTop: 5,
    gap: 5,
  },
  messageSupplementAssistant: {
    alignSelf: 'flex-start',
    marginLeft: 42,
    alignItems: 'flex-start',
  },
  messageSupplementUser: {
    alignSelf: 'flex-end',
    marginRight: 42,
    alignItems: 'flex-end',
  },
  sentQuote: {
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
    alignSelf: 'flex-start',
    backgroundColor: '#E4E7EC',
  },
  sentQuoteUser: {
    alignSelf: 'flex-end',
  },
  sentQuoteText: {
    color: '#667085',
    fontSize: 13,
    lineHeight: 18,
  },
  sentQuoteAuthor: {
    color: '#475467',
    fontWeight: '600',
  },
  translationBox: {
    width: '100%',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#D5DAE1',
    backgroundColor: '#E9ECEF',
  },
  voiceTranscriptBox: {
    width: '100%',
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 7,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E3E8EF',
  },
  voiceTranscriptLabel: {
    marginBottom: 3,
    color: palette.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  voiceTranscriptText: {
    color: palette.text,
    fontSize: 15,
    lineHeight: 21,
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
  typingIndicatorOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
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
    top: -46,
    zIndex: 3,
    minWidth: 40,
    height: 36,
    paddingHorizontal: 10,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
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
  scrollToLatestLabel: {
    color: palette.text,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  composer: {
    minHeight: 60,
    paddingTop: 8,
    paddingHorizontal: 10,
    alignItems: 'stretch',
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
    backgroundColor: palette.surface,
  },
  composerInputRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
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
  voiceButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#C9D1DC',
    backgroundColor: '#FFFFFF',
  },
  voiceButtonRecording: {
    borderColor: '#F97066',
    backgroundColor: '#FEF3F2',
  },
  voiceButtonError: {
    borderColor: '#FDA29B',
    backgroundColor: '#FFF3F1',
  },
  voiceButtonDisabled: {
    opacity: 0.72,
  },
  voiceButtonPressed: {
    backgroundColor: '#F2F4F7',
  },
  sendButtonDisabled: {
    backgroundColor: '#9BD49D',
  },
  sendButtonPressed: {
    backgroundColor: palette.accentPressed,
  },
  composerQuote: {
    minHeight: 42,
    width: '100%',
    paddingLeft: 11,
    paddingRight: 7,
    paddingVertical: 7,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#EAECF0',
  },
  composerQuoteText: {
    flex: 1,
    color: '#667085',
    fontSize: 13,
    lineHeight: 18,
  },
  composerQuoteAuthor: {
    color: '#475467',
    fontWeight: '600',
  },
  composerQuoteClose: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerQuoteClosePressed: {
    opacity: 0.55,
  },
  messageActionOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
  },
  messageActionDismissRegion: {
    position: 'absolute',
    zIndex: 1,
    backgroundColor: 'transparent',
  },
  messageActionMenu: {
    position: 'absolute',
    zIndex: 2,
    height: MESSAGE_ACTION_MENU_HEIGHT,
    paddingHorizontal: 4,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2B2D30',
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 20,
  },
  messageActionArrow: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderLeftWidth: MESSAGE_ACTION_ARROW_SIZE,
    borderRightWidth: MESSAGE_ACTION_ARROW_SIZE,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  messageActionArrowTop: {
    top: -MESSAGE_ACTION_ARROW_SIZE,
    borderBottomWidth: MESSAGE_ACTION_ARROW_SIZE,
    borderBottomColor: '#2B2D30',
  },
  messageActionArrowBottom: {
    bottom: -MESSAGE_ACTION_ARROW_SIZE,
    borderTopWidth: MESSAGE_ACTION_ARROW_SIZE,
    borderTopColor: '#2B2D30',
  },
  messageAction: {
    flex: 1,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
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
    height: 38,
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
