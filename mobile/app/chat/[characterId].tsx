import Ionicons from '@expo/vector-icons/Ionicons'
import { Image } from 'expo-image'
import { FlashList, FlashListRef } from '@shopify/flash-list'
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
  Keyboard,
  LayoutChangeEvent,
  Modal,
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
  useAnimatedKeyboard,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from 'react-native-reanimated'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'

import { Avatar } from '@/components/avatar'
import { VoiceMessageBubble } from '@/components/voice-message-bubble'
import { WeChatVoiceWave } from '@/components/wechat-voice-wave'
import { api, ApiError } from '@/src/api'
import { useChat } from '@/src/chat-context'
import {
  ChatTimelineItem,
  chatTimeline,
  chatTimelineItemType,
  messageRenderKey,
} from '@/src/chat-timeline'
import { contactPreviewForMessage } from '@/src/contact-preview'
import { mergeMessagePage } from '@/src/message-page-merge'
import { starterMessageForCharacter } from '@/src/starter-message'
import { palette } from '@/src/theme'
import { useVoiceInput } from '@/src/voice-input'
import { useVoiceMessageRecorder } from '@/src/voice-message-recorder'
import {
  Character,
  ChatMessage,
  ChatResponse,
  AssistantVoiceMessage,
  MessageVoice,
  UserVoiceMessage,
  MessageHistoryCursor,
  MessageQuote,
  ServerMessage,
  VoiceTranscriptMetadata,
} from '@/src/types'

const createLocalId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

const MESSAGE_REVEAL_DURATION_MS = 220
const OUTGOING_DELIVERY_INDICATOR_DELAY_MS = 3_000
const OUTGOING_DELIVERY_TIMEOUT_MS = 60_000
const OUTGOING_DELIVERY_STATUS_POLL_INITIAL_DELAY_MS = 250
const OUTGOING_DELIVERY_STATUS_POLL_INTERVAL_MS = 500
const MESSAGE_ROW_GAP = 10
const MESSAGE_LIST_EDGE_GAP = 8
const MESSAGE_ACTION_MENU_COMPACT_HEIGHT = 72
const MESSAGE_ACTION_MENU_EXPANDED_HEIGHT = 86
const MESSAGE_ACTION_ARROW_SIZE = 6.44
const MESSAGE_ACTION_GAP = 4
const MESSAGE_ACTION_EDGE_GAP = 8
const MESSAGE_ACTION_ITEM_WIDTH = 72
const MESSAGE_ACTION_MENU_HORIZONTAL_PADDING = 4
const MESSAGE_SELECTION_HIT_PADDING = 28
const MESSAGE_SELECTION_HANDLE_HIT_PADDING = 22
const MESSAGE_ACTION_FADE_OUT_MS = 65
const MESSAGE_ACTION_FADE_IN_MS = 90
const MESSAGE_ACTION_REAPPEAR_DELAY_MS = 120
const MESSAGE_SELECTION_INITIALIZE_MS = 180
const HISTORY_PAGE_SIZE = 20
const NEAR_LATEST_THRESHOLD = 96
const CLOUD_WAVEFORM_SAMPLE_COUNT = 30
const CHAT_MAINTAIN_VISIBLE_CONTENT_POSITION = Object.freeze({ disabled: false })

const cloudWaveformHeight = (metering?: number) => {
  const decibels = Number.isFinite(metering) ? Number(metering) : -58
  const normalized = Math.max(0, Math.min(1, (decibels + 54) / 42))
  return Math.round(4 + 25 * Math.pow(normalized, 0.62))
}

const visibleHistoryWindow = (messages: ChatMessage[], messageCount = HISTORY_PAGE_SIZE) => (
  messages.slice(-Math.max(1, messageCount))
)

const stampLegacyStarterMessages = (messages: ChatMessage[]) => {
  const createdAt = new Date().toISOString()
  return messages.map(message => (
    message.id.startsWith('starter-') && !message.createdAt
      ? { ...message, createdAt }
      : message
  ))
}

const localStarterMessage = (character: Character, id: string): ChatMessage => ({
  id,
  sender: 'assistant',
  text: starterMessageForCharacter(character),
  createdAt: new Date().toISOString(),
})

const cursorForMessage = (message?: ChatMessage): MessageHistoryCursor | undefined => (
  message?.createdAt
    ? { createdAt: message.createdAt, id: message.sourceMessageId || message.id }
    : undefined
)

type MessageAnchor = {
  x: number
  y: number
  width: number
  height: number
}

type AvatarPreview = {
  avatar?: string
  muted?: boolean
  name: string
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
  itemCount,
  menuHeight,
  usableBottom,
}: {
  anchor: MessageAnchor
  viewportWidth: number
  viewportHeight: number
  safeLeft: number
  safeRight: number
  safeTop: number
  safeBottom: number
  itemCount: number
  menuHeight: number
  usableBottom?: number
}) => {
  const availableWidth = Math.max(
    1,
    viewportWidth - safeLeft - safeRight - MESSAGE_ACTION_EDGE_GAP * 2
  )
  const contentWidth = (
    MESSAGE_ACTION_ITEM_WIDTH * itemCount
    + StyleSheet.hairlineWidth * Math.max(0, itemCount - 1)
    + MESSAGE_ACTION_MENU_HORIZONTAL_PADDING * 2
  )
  const width = Math.min(availableWidth, contentWidth)
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
    - menuHeight
  const belowTop = anchor.y + anchor.height + MESSAGE_ACTION_GAP + MESSAGE_ACTION_ARROW_SIZE
  const aboveTop = anchor.y
    - MESSAGE_ACTION_GAP
    - MESSAGE_ACTION_ARROW_SIZE
    - menuHeight
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

const parseUserVoiceMessage = (value: unknown): Extract<MessageVoice, { provider: 'user-recording' }> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const voice = value as Record<string, unknown>
  if (voice.provider !== 'user-recording' || voice.status !== 'ready') return undefined
  if (typeof voice.audioUrl !== 'string' || !voice.audioUrl) return undefined
  if (typeof voice.durationSeconds !== 'number' || !Number.isFinite(voice.durationSeconds)) return undefined
  if (
    voice.mimeType !== 'audio/mp4'
    && voice.mimeType !== 'audio/m4a'
    && voice.mimeType !== 'audio/x-m4a'
    && voice.mimeType !== 'audio/3gpp'
    && voice.mimeType !== 'audio/webm'
  ) return undefined
  if (voice.transcriptStatus !== 'none' && voice.transcriptStatus !== 'ready') return undefined
  return {
    provider: 'user-recording',
    status: 'ready',
    audioUrl: voice.audioUrl,
    durationSeconds: voice.durationSeconds,
    mimeType: voice.mimeType,
    transcriptStatus: voice.transcriptStatus,
  }
}

const parseMessageVoice = (value: unknown) => (
  parseAssistantVoiceMessage(value) || parseUserVoiceMessage(value)
)

const mapMessages = (messages: ServerMessage[]): ChatMessage[] => messages
  .filter(message => message.senderRole !== 'system')
  .flatMap(message => {
    const segments = deliverySegments(message)
    const quote = parseMessageQuote(message.contentJson?.quote)
    const translations = message.contentJson?.translations
    const englishTranslations = translations && typeof translations === 'object'
      ? (translations as Record<string, unknown>).en
      : undefined
    const voice = parseMessageVoice(message.contentJson?.voice)
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
      // Translation text may be cached by the server, but revealing it is a
      // session-only choice and must start hidden after an app restart.
      translationVisible: false,
      voice: voice && (
        voice.provider === 'user-recording' || voice.segmentIndex === index
      ) ? voice : undefined,
      // A transcript can be ready on the server without being expanded in the UI.
      // Expanding it is an explicit, current-session action from the voice message menu.
      voiceTranscriptVisible: false,
      groupIndex: index,
      groupSize: segments.length,
      createdAt: message.createdAt,
    }))
  })

const responseMessages = (
  response: ChatResponse,
  createdAt = new Date().toISOString()
): ChatMessage[] => {
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
    createdAt,
  }))
}

const isUserVoiceMessage = (message: ChatMessage): message is ChatMessage & { voice: UserVoiceMessage } => (
  message.sender === 'user' && message.voice?.provider === 'user-recording'
)

const simulatedTypingDuration = (text: string) => {
  const characters = Array.from(text.trim()).length
  const words = text.trim().split(/\s+/u).filter(Boolean).length
  return Math.round(Math.min(20_000, Math.max(2_000, 620 + words * 70 + characters * 12)))
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
      useNativeDriver: false,
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

function CloudDictationWaveform({
  metering,
  recording,
  tick,
}: {
  metering?: number
  recording: boolean
  tick: number
}) {
  const [samples, setSamples] = useState<number[]>(() => (
    Array.from({ length: CLOUD_WAVEFORM_SAMPLE_COUNT }, () => 4)
  ))

  useEffect(() => {
    if (!recording) {
      setSamples(Array.from({ length: CLOUD_WAVEFORM_SAMPLE_COUNT }, () => 4))
      return
    }
    const next = cloudWaveformHeight(metering)
    setSamples(current => [...current.slice(1), next])
  }, [metering, recording, tick])

  return (
    <View pointerEvents="none" style={styles.cloudDictationWave}>
      {samples.map((height, index) => (
        <View
          key={index}
          style={[
            styles.cloudDictationWaveBar,
            { height, opacity: height <= 4 ? 0.32 : 1 },
          ]}
        />
      ))}
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
  const messageKey = message.renderKey || message.id
  const isLoading = Boolean(message.loading)
  const readyVoice = message.voice?.status === 'ready'
    && Boolean(message.voice.audioUrl)
  const revealProgress = useRef(new RNAnimated.Value(isLoading ? 0 : 1)).current
  const renderedMessageKeyRef = useRef(messageKey)
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
    if (renderedMessageKeyRef.current !== messageKey) {
      renderedMessageKeyRef.current = messageKey
      revealProgress.stopAnimation()
      revealProgress.setValue(isLoading ? 0 : 1)
      wasLoadingRef.current = isLoading
      setShowTypingIndicator(isLoading)
      setSelectionLines([])
      return
    }

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
      useNativeDriver: false,
    })
    animation.start(({ finished }) => {
      if (finished) setShowTypingIndicator(false)
    })
    return () => animation.stop()
  }, [isLoading, messageKey, revealProgress])

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
      {readyVoice && message.voice && (
        <VoiceMessageBubble voice={message.voice} isUser={isUser} onLongPress={onVoiceLongPress} />
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

function DateDivider({ label }: { label: string }) {
  return (
    <View pointerEvents="none" style={styles.dateDivider}>
      <Text style={styles.dateDividerLabel}>{label}</Text>
    </View>
  )
}

const isImageAvatar = (avatar?: string) => Boolean(
  avatar && /^(data:image\/|https?:\/\/|file:|content:)/i.test(avatar)
)

function AvatarPreviewModal({
  preview,
  onClose,
}: {
  preview: AvatarPreview | null
  onClose: () => void
}) {
  const { width } = useWindowDimensions()
  if (!preview) return null
  const showImage = isImageAvatar(preview.avatar)
  const previewSize = Math.min(320, width * 0.78)

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.avatarPreviewOverlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close avatar preview"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.avatarPreviewContent}>
          <View style={styles.avatarPreviewFrame}>
            {showImage ? (
              <Image
                source={{ uri: preview.avatar }}
                contentFit="contain"
                cachePolicy="memory-disk"
                style={styles.avatarPreviewImage}
              />
            ) : (
              <Avatar avatar={preview.avatar} name={preview.name} size={previewSize} muted={preview.muted} />
            )}
          </View>
        </View>
      </View>
    </Modal>
  )
}

function MessageRow({
  message,
  characterName,
  characterAvatar,
  userAvatar,
  onPreviewAvatar,
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
  continuation,
  atLatestEdge,
}: {
  message: ChatMessage
  characterName: string
  characterAvatar?: string
  userAvatar?: string
  onPreviewAvatar: (preview: AvatarPreview) => void
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
  continuation: boolean
  atLatestEdge: boolean
}) {
  const messageKey = message.renderKey || message.id
  const isUser = message.sender === 'user'
  const isContinuation = continuation
  const readyVoice = message.voice?.status === 'ready' && Boolean(message.voice.audioUrl)
  const entryProgress = useRef(new RNAnimated.Value(message.animateEntry ? 0 : 1)).current
  const bubbleRef = useRef<View>(null)

  const handleLongPress = () => {
    bubbleRef.current?.measureInWindow((x, y, width, height) => {
      if (width <= 0 || height <= 0) return
      onLongPress(message, { x, y, width, height })
    })
  }

  useEffect(() => {
    entryProgress.stopAnimation()
    entryProgress.setValue(message.animateEntry ? 0 : 1)
    if (!message.animateEntry) return
    const animation = RNAnimated.timing(entryProgress, {
      toValue: 1,
      duration: 230,
      delay: message.animationDelayMs || 0,
      useNativeDriver: false,
    })
    animation.start()
    return () => animation.stop()
  }, [entryProgress, message.animateEntry, message.animationDelayMs, messageKey])

  return (
    <RNAnimated.View
      style={[
        styles.messageRow,
        atLatestEdge && styles.messageRowLatest,
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
          <Pressable
            onPress={() => onPreviewAvatar({ avatar: characterAvatar, name: characterName })}
            accessibilityLabel={`Preview ${characterName}'s avatar`}
            style={styles.assistantAvatar}
          >
            <Avatar avatar={characterAvatar} name={characterName} size={40} />
          </Pressable>
        )}
        {!isUser && isContinuation && <View style={styles.avatarSpacer} />}
        <View style={[styles.messageContent, isUser && styles.messageContentUser]}>
          {isUser && (
            <MessageDeliveryIndicator
              state={message.deliveryState}
              onRetry={() => onRetryMessage(message)}
            />
          )}
          {readyVoice ? (
            <View
              ref={bubbleRef}
              collapsable={false}
              style={[
                styles.bubble,
                styles.voiceBubble,
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
            </View>
          ) : (
            <View
            ref={bubbleRef}
            collapsable={false}
            style={[styles.bubbleAnchor, selecting && styles.bubbleAnchorSelecting]}
          >
            <Pressable
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
            </Pressable>
            </View>
          )}
        </View>
        {isUser && (
          isContinuation
            ? <View style={styles.avatarSpacer} />
            : (
                <Pressable
                  onPress={() => onPreviewAvatar({ avatar: userAvatar, muted: true, name: 'Me' })}
                  accessibilityLabel="Preview your avatar"
                  style={styles.userAvatar}
                >
                  <Avatar name="Me" avatar={userAvatar || 'Me'} size={40} muted />
                </Pressable>
              )
        )}
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
    userAvatar,
    voiceInputMode,
    markCloudVoiceUnavailable,
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
    getConversationListViewState,
    hydrateConversationCache,
    setConversationCache,
    setConversationListViewState,
    clearConversationCache,
  } = useChat()
  const character = useMemo(
    () => characters.find(item => item.id === characterId),
    [characterId, characters]
  )
  const draft = characterId ? getDraft(characterId) : ''
  const quotedMessage = characterId ? getQuoteDraft(characterId) : null
  const initialCacheRef = useRef(characterId ? getConversationCache(characterId) : undefined)
  const initialListViewStateRef = useRef(
    characterId ? getConversationListViewState(characterId) : undefined
  )
  const initialCachedMessages = stampLegacyStarterMessages(initialCacheRef.current?.messages || [])
  const initialCachedLatestMessage = initialCachedMessages.at(-1)
  const initialListViewState = initialListViewStateRef.current
  const hasInitialListViewState = Boolean(
    initialListViewState
    && initialListViewState.messageCount > 0
    && initialListViewState.messageCount <= initialCachedMessages.length
    && initialListViewState.latestMessageKey === (
      initialCachedLatestMessage?.renderKey || initialCachedLatestMessage?.id
    )
  )
  const initialContentOffsetRef = useRef<{ x: number; y: number } | undefined>(
    hasInitialListViewState
      && initialListViewStateRef.current
      && !initialListViewStateRef.current.followLatest
      ? { x: 0, y: initialListViewStateRef.current.offsetY }
      : undefined
  )
  const initialDisplayMessageCount = hasInitialListViewState && initialListViewState
    ? initialListViewState.messageCount
    : HISTORY_PAGE_SIZE
  const initialDisplayMessages = visibleHistoryWindow(
    initialCachedMessages,
    initialDisplayMessageCount
  )
  const initialDisplayCursor = cursorForMessage(initialDisplayMessages[0])
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialDisplayMessages)
  const timelineItems = useMemo(() => chatTimeline(messages), [messages])
  const [conversationId, setConversationId] = useState<string | null>(
    initialCacheRef.current?.conversationId || null
  )
  const [hasMoreHistory, setHasMoreHistory] = useState(
    () => Boolean(
      initialCacheRef.current?.hasMoreHistory
      || initialDisplayMessages.length < (initialCacheRef.current?.messages.length || 0)
    )
  )
  const [oldestMessageCursor, setOldestMessageCursor] = useState<MessageHistoryCursor | undefined>(
    () => initialDisplayCursor || initialCacheRef.current?.oldestMessageCursor
  )
  const [activity, setActivity] = useState('Online')
  const [loadingHistory, setLoadingHistory] = useState(!initialCacheRef.current)
  // AsyncStorage is checked after the route mounts. Do not present that short
  // local read as a remote-history load.
  const [historyCacheResolved, setHistoryCacheResolved] = useState(Boolean(initialCacheRef.current))
  const [sending, setSending] = useState(false)
  const [voiceMetadata, setVoiceMetadata] = useState<VoiceTranscriptMetadata | undefined>()
  const [composerMode, setComposerMode] = useState<'text' | 'voice'>('text')
  const [error, setError] = useState<string | null>(null)
  const [showScrollToLatest, setShowScrollToLatest] = useState(false)
  const [unseenLatestCount, setUnseenLatestCount] = useState(0)
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false)
  const [messageActionSession, setMessageActionSession] = useState<MessageActionSession | null>(null)
  const [messageActionMenuInteractive, setMessageActionMenuInteractive] = useState(true)
  const [avatarPreview, setAvatarPreview] = useState<AvatarPreview | null>(null)
  const [conversationActionsVisible, setConversationActionsVisible] = useState(false)
  const [forwardingMessage, setForwardingMessage] = useState<ChatMessage | null>(null)
  const [forwardPickerVisible, setForwardPickerVisible] = useState(false)
  const [forwardTarget, setForwardTarget] = useState<Character | null>(null)
  const [forwardSearch, setForwardSearch] = useState('')
  const [forwardNote, setForwardNote] = useState('')
  const [forwardSubmitting, setForwardSubmitting] = useState(false)
  const listRef = useRef<FlashListRef<ChatTimelineItem>>(null)
  const timelineItemHeightsRef = useRef(new Map<string, number>())
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
  const forwardPickerTranslateY = useRef(new RNAnimated.Value(window.height)).current
  const forwardConfirmationTranslateY = useRef(new RNAnimated.Value(window.height)).current
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
  const withinImmersiveRangeRef = useRef(
    initialListViewStateRef.current?.withinImmersiveRange ?? true
  )
  const followLatestRef = useRef(initialListViewStateRef.current?.followLatest ?? true)
  const unseenLatestRef = useRef(false)
  const manualScrollRef = useRef(false)
  const initialScrollRef = useRef(!hasInitialListViewState)
  const loadingOlderHistoryRef = useRef(false)
  const scrollMetricsRef = useRef({
    contentHeight: 0,
    offsetY: 0,
    viewportHeight: 0,
  })
  const keyboard = useAnimatedKeyboard()
  const scrollContentHeight = useSharedValue(0)
  const scrollViewportHeight = useSharedValue(0)
  const timelineIntrinsicHeight = useSharedValue(0)
  const syncTimelineIntrinsicHeight = useCallback(() => {
    let height = MESSAGE_LIST_EDGE_GAP * 2
    timelineItemHeightsRef.current.forEach(itemHeight => {
      height += itemHeight
    })
    timelineIntrinsicHeight.value = height
  }, [timelineIntrinsicHeight])
  const handleTimelineItemLayout = useCallback((key: string, event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height
    const previous = timelineItemHeightsRef.current.get(key)
    if (previous != null && Math.abs(previous - height) < 0.5) return
    timelineItemHeightsRef.current.set(key, height)
    syncTimelineIntrinsicHeight()
  }, [syncTimelineIntrinsicHeight])
  useEffect(() => {
    const itemKeys = new Set(timelineItems.map(item => item.key))
    let removed = false
    timelineItemHeightsRef.current.forEach((_height, key) => {
      if (itemKeys.has(key)) return
      timelineItemHeightsRef.current.delete(key)
      removed = true
    })
    if (removed) syncTimelineIntrinsicHeight()
  }, [syncTimelineIntrinsicHeight, timelineItems])
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
    const contentHeight = scrollContentHeight.value > scrollViewportHeight.value + 0.5
      ? scrollContentHeight.value
      : timelineIntrinsicHeight.value
    const unusedListSpace = Math.max(0, scrollViewportHeight.value - contentHeight)
    return {
      transform: [{
        translateY: -Math.max(0, keyboardLift.value - unusedListSpace),
      }],
    }
  })
  const stagedDeliveryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const deliveryStatusPollCancelsRef = useRef<Set<() => void>>(new Set())
  const voiceTranscriptionRequestsRef = useRef<Set<string>>(new Set())
  const lastVoiceErrorRef = useRef<string | null>(null)
  const voiceInput = useVoiceInput({
    mode: voiceInputMode,
    userId: userId || undefined,
    characterId: character?.id,
    language: character?.language,
    onCloudUnavailable: markCloudVoiceUnavailable,
    onTranscriptChange: (text, metadata) => {
      if (!character) return
      setDraft(character.id, text)
      setVoiceMetadata(metadata)
    },
  })
  const voiceMessageRecorder = useVoiceMessageRecorder({
    userId: userId || undefined,
    characterId: character?.id,
    conversationId,
    onConvertedToText: (text, metadata) => {
      if (!character) return
      setDraft(character.id, text)
      setVoiceMetadata(metadata)
      setComposerMode('text')
      requestAnimationFrame(() => composerInputRef.current?.focus())
    },
    onSent: result => {
      setConversationId(result.conversationId)
      const incoming = mapMessages([
        ...(result.starterMessage ? [result.starterMessage] : []),
        result.message,
      ])
      const latestIncoming = incoming.at(-1)
      markConversationActive(
        characterId,
        latestIncoming?.createdAt || new Date().toISOString(),
        contactPreviewForMessage(latestIncoming)
      )
      const assistant = result.response
        ? responseMessages({ ...result.response, conversationId: result.conversationId })
        : []
      const loadingId = assistant.length > 0 ? createLocalId() : undefined
      setMessages(current => mergeMessagePage(current, [
        ...incoming,
        ...(loadingId ? [{
          id: loadingId,
          sender: 'assistant' as const,
          text: '',
          loading: true,
        }] : []),
      ], 'append'))
      requestAnimationFrame(() => {
        if (loadingId) stageAssistantMessages(loadingId, assistant, 0)
        startLatestScroll(true)
      })
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

  useEffect(() => {
    if (!voiceMessageRecorder.error) return
    Alert.alert('Voice message unavailable', voiceMessageRecorder.error)
  }, [voiceMessageRecorder.error])

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
      useNativeDriver: false,
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
        useNativeDriver: false,
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
    withinImmersiveRangeRef.current = true
    scrollMetricsRef.current.offsetY = 0
    hideScrollToLatest()
    const scroll = () => listRef.current?.scrollToOffset({
      offset: 0,
      animated: !pinToLatest,
    })
    scroll()
    if (pinToLatest) requestAnimationFrame(scroll)
  }, [hideScrollToLatest])

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
    composerFocusedRef.current = true
    initialScrollRef.current = false
    startLatestScroll(withinImmersiveRangeRef.current)
  }, [startLatestScroll])

  const handleComposerBlur = useCallback(() => {
    composerFocusedRef.current = false
  }, [])

  const resetInitialScroll = useCallback(() => {
    initialScrollRef.current = true
    initialContentOffsetRef.current = undefined
    followLatestRef.current = true
    withinImmersiveRangeRef.current = true
    scrollMetricsRef.current.offsetY = 0
    hideScrollToLatest()
  }, [hideScrollToLatest])

  const settleInitialScroll = useCallback(() => {
    if (!initialScrollRef.current) return
    initialScrollRef.current = false
    if (followLatestRef.current) startLatestScroll(true)
  }, [startLatestScroll])

  const scheduleDeliveryTask = useCallback((task: () => void, delay: number) => {
    const timer = setTimeout(() => {
      stagedDeliveryTimersRef.current.delete(timer)
      task()
    }, delay)
    stagedDeliveryTimersRef.current.add(timer)
  }, [])

  const stageAssistantMessages = useCallback((
    loadingId: string,
    incomingMessages: ChatMessage[],
    initialTypingElapsedMs: number
  ) => {
    const firstMessage = incomingMessages[0]
    if (!firstMessage) return

    const followIncoming = () => prepareForIncomingMessage()
    const updateContactPreview = (message: ChatMessage) => {
      if (!characterId) return
      markConversationActive(
        characterId,
        message.createdAt || new Date().toISOString(),
        contactPreviewForMessage(message)
      )
    }

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
          createdAt: nextMessage.createdAt,
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
          updateContactPreview(nextMessage)
          queueMessage(index + 1)
        }, simulatedTypingDuration(nextMessage.text))
      }, 220)
    }

    const revealFirstMessage = () => {
      followIncoming()
      setMessages(current => current.flatMap(message => (
        message.id === loadingId
          ? [{ ...firstMessage, renderKey: loadingId }]
          : [message]
      )))
      updateContactPreview(firstMessage)
      queueMessage(1)
    }

    const initialDelay = Math.max(0, simulatedTypingDuration(firstMessage.text) - initialTypingElapsedMs)
    if (initialDelay > 0) {
      scheduleDeliveryTask(revealFirstMessage, initialDelay)
    } else {
      revealFirstMessage()
    }
  }, [characterId, markConversationActive, prepareForIncomingMessage, scheduleDeliveryTask])

  useEffect(() => () => {
    stagedDeliveryTimersRef.current.forEach(timer => clearTimeout(timer))
    stagedDeliveryTimersRef.current.clear()
    Array.from(deliveryStatusPollCancelsRef.current).forEach(cancel => cancel())
    deliveryStatusPollCancelsRef.current.clear()
    if (messageActionReappearTimerRef.current) {
      clearTimeout(messageActionReappearTimerRef.current)
    }
    if (messageSelectionBlurTimerRef.current) {
      clearTimeout(messageSelectionBlurTimerRef.current)
    }
    messageActionMenuOpacity.stopAnimation()
  }, [messageActionMenuOpacity])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => () => {
    if (!characterId) return
    const latestMessage = messagesRef.current.at(-1)
    const { contentHeight, offsetY, viewportHeight } = scrollMetricsRef.current
    const latestMessageKey = latestMessage?.renderKey || latestMessage?.id
    if (!latestMessageKey || contentHeight <= 0 || viewportHeight <= 0) return
    setConversationListViewState(characterId, {
      offsetY: followLatestRef.current && withinImmersiveRangeRef.current
        ? 0
        : Math.max(0, offsetY),
      messageCount: messagesRef.current.length,
      latestMessageKey,
      followLatest: followLatestRef.current,
      withinImmersiveRange: withinImmersiveRangeRef.current,
    })
  }, [characterId, setConversationListViewState])

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
        resetInitialScroll()
      }

      if (!matching) {
        const cachedHistory = getConversationCache(character.id)
        if (cachedHistory?.messages.length) {
          const cachedMessages = visibleHistoryWindow(stampLegacyStarterMessages(cachedHistory.messages))
          setConversationId(cachedHistory.conversationId)
          setHasMoreHistory(Boolean(
            cachedHistory.hasMoreHistory || cachedMessages.length < cachedHistory.messages.length
          ))
          setOldestMessageCursor(cursorForMessage(cachedMessages[0]) || cachedHistory.oldestMessageCursor)
          setMessages(cachedMessages)
          setError(null)
          return
        }
        setConversationId(null)
        setHasMoreHistory(false)
        setOldestMessageCursor(undefined)
        const starterMessages = [localStarterMessage(character, `starter-${character.id}`)]
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
        const serverMessages = mapMessages(messagePage.messages)
        const mappedMessages = quiet
          ? mergeMessagePage(messagesRef.current, serverMessages, 'append')
          : serverMessages
        const nextHasMoreHistory = Boolean(cachedHistory?.hasMoreHistory || messagePage.hasMore)
        const nextOldestMessageCursor = cursorForMessage(mappedMessages[0])
          || cachedHistory?.oldestMessageCursor
          || messagePage.nextCursor
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
      setHistoryCacheResolved(Boolean(inMemoryHistory))
      if (!inMemoryHistory) resetInitialScroll()
      const cachedHistory = inMemoryHistory
        || await hydrateConversationCache(hydratedCharacterId)
      if (
        cancelled
        || requestId !== historyHydrationRequestRef.current
        || deliveryGeneration !== localDeliveryGenerationRef.current
      ) return

      if (!cachedHistory) {
        setHistoryCacheResolved(true)
        void loadConversationRef.current(false)
      } else {
        // Cached history can be painted immediately. The inverted list starts
        // at its latest edge without waiting for dynamic row measurement.
        const cachedMessages = visibleHistoryWindow(
          stampLegacyStarterMessages(cachedHistory.messages),
          hasInitialListViewState ? initialDisplayMessageCount : HISTORY_PAGE_SIZE
        )
        messagesRef.current = cachedMessages
        setMessages(cachedMessages)
        setConversationId(cachedHistory.conversationId)
        setHasMoreHistory(Boolean(
          cachedHistory.hasMoreHistory || cachedMessages.length < cachedHistory.messages.length
        ))
        setOldestMessageCursor(cursorForMessage(cachedMessages[0]) || cachedHistory.oldestMessageCursor)
        setLoadingHistory(false)
        void loadConversationRef.current(true)
      }
      void refreshState()
    })()

    return () => {
      cancelled = true
    }
  }, [
    character?.id,
    getConversationCache,
    initialDisplayMessageCount,
    hasInitialListViewState,
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
    setLoadingOlderHistory(true)
    const pageRequestId = historyPageRequestRef.current + 1
    historyPageRequestRef.current = pageRequestId
    const historyRequestId = historyRequestRef.current
    const deliveryGeneration = localDeliveryGenerationRef.current

    try {
      const cachedHistory = characterId ? getConversationCache(characterId) : undefined
      const visibleOldestMessage = messagesRef.current[0]
      const visibleOldestMessageId = visibleOldestMessage?.sourceMessageId || visibleOldestMessage?.id
      const cachedOldestIndex = cachedHistory?.messages.findIndex(message => (
        (message.sourceMessageId || message.id) === visibleOldestMessageId
      )) ?? -1
      if (cachedHistory && cachedOldestIndex > 0) {
        const localOlderMessages = cachedHistory.messages.slice(
          Math.max(0, cachedOldestIndex - HISTORY_PAGE_SIZE),
          cachedOldestIndex
        )
        setMessages(current => mergeMessagePage(current, localOlderMessages, 'prepend'))
        const nextOldestIndex = cachedOldestIndex - localOlderMessages.length
        const nextOldest = cachedHistory.messages[nextOldestIndex]
        setHasMoreHistory(Boolean(nextOldestIndex > 0 || cachedHistory.hasMoreHistory))
        setOldestMessageCursor(cursorForMessage(nextOldest) || cachedHistory.oldestMessageCursor)
        return
      }
      const messagePage = await api.listMessagePage(conversationId, {
        limit: HISTORY_PAGE_SIZE,
        before: oldestMessageCursor,
      })
      if (pageRequestId !== historyPageRequestRef.current
        || historyRequestId !== historyRequestRef.current
        || deliveryGeneration !== localDeliveryGenerationRef.current) return

      const olderMessages = mapMessages(messagePage.messages)
      if (olderMessages.length > 0) {
        setMessages(current => mergeMessagePage(current, olderMessages, 'prepend'))
      }
      setHasMoreHistory(messagePage.hasMore)
      setOldestMessageCursor(messagePage.nextCursor)
    } catch {
      // Keep the current page and let the next top-edge gesture retry the request.
    } finally {
      if (pageRequestId === historyPageRequestRef.current) {
        loadingOlderHistoryRef.current = false
        setLoadingOlderHistory(false)
      }
    }
  }, [characterId, conversationId, getConversationCache, hasMoreHistory, oldestMessageCursor])

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
      clearConversationCache(character.id)
      setConversationId(null)
      setHasMoreHistory(false)
      setOldestMessageCursor(undefined)
      setMessages([localStarterMessage(character, `starter-${character.id}-${Date.now()}`)])
      resetInitialScroll()
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
    setConversationActionsVisible(true)
  }

  const toggleConversationPin = () => {
    if (!character) return
    const pinned = pinnedCharacterIds.has(character.id)
    setConversationActionsVisible(false)
    void setCharacterPinned(character.id, !pinned).catch(pinError => {
      Alert.alert('Could not update pin', pinError instanceof Error ? pinError.message : undefined)
    })
  }

  const editConversationCharacter = () => {
    setConversationActionsVisible(false)
    openEditor()
  }

  const confirmClearConversation = () => {
    setConversationActionsVisible(false)
    Alert.alert(
      'Clear conversation?',
      'This removes the message history for this character.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => void clearHistory() },
      ]
    )
  }

  const translateMessage = async (message: ChatMessage) => {
    if (isUserVoiceMessage(message)) return
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

  const convertVoiceMessageToText = async (message: ChatMessage) => {
    if (!userId || !message.sourceMessageId || !isUserVoiceMessage(message)) return
    closeMessageActionMenu()
    if (
      message.voiceTranscriptionLoading
      || voiceTranscriptionRequestsRef.current.has(message.sourceMessageId)
    ) return
    // A message-list request can have captured this message before transcription.
    // Reject that stale snapshot so it cannot reset the local ready state afterward.
    messageSyncRequestRef.current += 1
    const conversionStartedAt = Date.now()
    if (message.text.trim()) {
      console.info('[voice] voice_transcript_revealed_from_message', {
        messageId: message.sourceMessageId,
        transcriptStatus: message.voice.transcriptStatus,
      })
      setMessages(current => current.map(item => {
        if (item.id !== message.id || item.voice?.provider !== 'user-recording') return item
        return {
          ...item,
          voice: { ...item.voice, transcriptStatus: 'ready' },
          voiceTranscriptVisible: true,
          voiceTranscriptionLoading: false,
        }
      }))
      if (message.voice.transcriptStatus === 'ready') return
      void api.convertVoiceMessageToText(userId, message.sourceMessageId)
        .then(result => {
          const mapped = mapMessages([result.message])[0]
          if (!mapped) return
          setMessages(current => current.map(item => (
            item.id === message.id
              ? {
                  ...item,
                  ...mapped,
                  renderKey: item.renderKey || mapped.renderKey,
                  voiceTranscriptVisible: true,
                  voiceTranscriptionLoading: false,
                }
              : item
          )))
        })
        .catch(error => {
          console.warn('[voice] voice_transcript_status_persist_failed', {
            error: error instanceof Error ? error.message : 'unknown_error',
            messageId: message.sourceMessageId,
          })
        })
      return
    }
    console.info('[voice] voice_transcript_cloud_conversion_started', {
      messageId: message.sourceMessageId,
      transcriptStatus: message.voice.transcriptStatus,
    })
    voiceTranscriptionRequestsRef.current.add(message.sourceMessageId)
    setMessages(current => current.map(item => (
      item.id === message.id
        ? { ...item, voiceTranscriptionLoading: true }
        : item
    )))
    try {
      const result = await api.convertVoiceMessageToText(userId, message.sourceMessageId)
      const mapped = mapMessages([result.message])[0]
      if (!mapped) throw new Error('The converted voice message could not be displayed.')
      console.info('[voice] voice_transcript_cloud_conversion_completed', {
        elapsedMs: Date.now() - conversionStartedAt,
        messageId: message.sourceMessageId,
      })
      setMessages(current => current.map(item => (
        item.id === message.id
          ? {
              ...item,
              ...mapped,
              renderKey: item.renderKey || mapped.renderKey,
              voiceTranscriptVisible: true,
              voiceTranscriptionLoading: false,
            }
          : item
      )))
    } catch (conversionError) {
      setMessages(current => current.map(item => (
        item.id === message.id
          ? { ...item, voiceTranscriptionLoading: false }
          : item
      )))
      setError(conversionError instanceof Error
        ? conversionError.message
        : 'Could not convert this voice message to text.')
    } finally {
      voiceTranscriptionRequestsRef.current.delete(message.sourceMessageId)
    }
  }

  const discardVoiceMessageText = (message: ChatMessage) => {
    if (!userId || !message.sourceMessageId || !isUserVoiceMessage(message)) return
    closeMessageActionMenu()
    console.info('[voice] voice_transcript_hidden', {
      messageId: message.sourceMessageId,
    })
    setMessages(current => current.map(item => (
      item.id === message.id
        ? { ...item, voiceTranscriptVisible: false, voiceTranscriptionLoading: false }
        : item
    )))
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

  const dismissForwardPicker = () => {
    if (forwardSubmitting) return
    RNAnimated.parallel([
      RNAnimated.timing(forwardPickerTranslateY, {
        toValue: window.height,
        duration: 230,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      RNAnimated.timing(forwardConfirmationTranslateY, {
        toValue: window.height,
        duration: 180,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (!finished) return
      setForwardPickerVisible(false)
      setForwardingMessage(null)
      setForwardTarget(null)
      setForwardSearch('')
      setForwardNote('')
    })
  }

  const dismissForwardConfirmation = () => {
    if (forwardSubmitting) return
    RNAnimated.timing(forwardConfirmationTranslateY, {
      toValue: window.height,
      duration: 210,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return
      setForwardTarget(null)
      setForwardNote('')
    })
  }

  const openForwardPicker = (message: ChatMessage) => {
    const text = message.text.trim()
    closeMessageActionMenu()
    if (!text) {
      Alert.alert('Nothing to forward', 'Convert this voice message to text before forwarding it.')
      return
    }
    // The long press preserves the composer. Only entering the full-screen
    // forwarding flow should release its keyboard focus.
    requestAnimationFrame(() => Keyboard.dismiss())
    setForwardingMessage(message)
    setForwardTarget(null)
    setForwardSearch('')
    setForwardNote('')
    setForwardPickerVisible(true)
    forwardPickerTranslateY.setValue(window.height)
    forwardConfirmationTranslateY.setValue(window.height)
    requestAnimationFrame(() => {
      RNAnimated.timing(forwardPickerTranslateY, {
        toValue: 0,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start()
    })
  }

  const selectForwardTarget = (target: Character) => {
    if (target.id === characterId || forwardSubmitting) return
    setForwardTarget(target)
    setForwardNote('')
    forwardConfirmationTranslateY.setValue(window.height)
    requestAnimationFrame(() => {
      RNAnimated.timing(forwardConfirmationTranslateY, {
        toValue: 0,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start()
    })
  }

  const sendForwardMessage = async () => {
    const text = forwardingMessage?.text.trim()
    if (!userId || !forwardTarget || !text || forwardSubmitting) return
    setForwardSubmitting(true)
    try {
      const result = await api.forwardMessage({
        targetCharacterId: forwardTarget.id,
        message: text,
        note: forwardNote.trim() || undefined,
      })
      const latest = result.messages.at(-1)
      markConversationActive(
        forwardTarget.id,
        latest?.createdAt || new Date().toISOString(),
        latest?.content.trim() || text,
        result.conversationId
      )
      setError(null)
      RNAnimated.parallel([
        RNAnimated.timing(forwardConfirmationTranslateY, {
          toValue: window.height,
          duration: 190,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        RNAnimated.timing(forwardPickerTranslateY, {
          toValue: window.height,
          duration: 260,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (!finished) {
          setForwardSubmitting(false)
          return
        }
        setForwardPickerVisible(false)
        setForwardingMessage(null)
        setForwardTarget(null)
        setForwardSearch('')
        setForwardNote('')
        setForwardSubmitting(false)
      })
    } catch (forwardError) {
      Alert.alert(
        'Could not forward message',
        forwardError instanceof Error ? forwardError.message : 'Please try again when connected.'
      )
      setForwardSubmitting(false)
    }
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
              createdAt: new Date().toISOString(),
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
    const messageCreatedAt = messageToRetry?.createdAt || new Date().toISOString()
    const userMessage: ChatMessage = messageToRetry
      ? {
          ...messageToRetry,
          id: userMessageId,
          renderKey: messageToRetry.renderKey || userMessageId,
          deliveryState: 'sending',
          quote,
          createdAt: messageCreatedAt,
        }
      : {
          id: userMessageId,
          renderKey: userMessageId,
          sender: 'user',
          text,
          quote,
          deliveryState: 'sending',
          createdAt: messageCreatedAt,
        }
    const loadingId = createLocalId()
    const loadingMessage: ChatMessage = {
      id: loadingId,
      sender: 'assistant',
      text: '',
      loading: true,
      createdAt: messageCreatedAt,
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
    markConversationActive(character.id, messageCreatedAt, text)
    const assistantTypingStartedAt = Date.now()
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
    let deliveryStatusPollTimer: ReturnType<typeof setTimeout> | undefined
    let deliveryStatusPollingCancelled = false

    const cancelDeliveryStatusPolling = () => {
      deliveryStatusPollingCancelled = true
      if (deliveryStatusPollTimer) clearTimeout(deliveryStatusPollTimer)
      deliveryStatusPollCancelsRef.current.delete(cancelDeliveryStatusPolling)
    }
    deliveryStatusPollCancelsRef.current.add(cancelDeliveryStatusPolling)

    const confirmUserMessage = (sourceMessageId: string) => {
      userMessageConfirmed = true
      cancelDeliveryStatusPolling()
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

    const scheduleDeliveryStatusPoll = (delay: number) => {
      if (deliveryStatusPollingCancelled || userMessageConfirmed || !isCurrentDelivery()) return
      deliveryStatusPollTimer = setTimeout(() => {
        deliveryStatusPollTimer = undefined
        void checkDeliveryStatus()
      }, delay)
    }

    const checkDeliveryStatus = async () => {
      if (deliveryStatusPollingCancelled || userMessageConfirmed || !isCurrentDelivery()) {
        cancelDeliveryStatusPolling()
        return
      }
      try {
        const status = await api.getMessageDeliveryStatus(userId, userMessageId)
        if (deliveryStatusPollingCancelled || userMessageConfirmed || !isCurrentDelivery()) {
          cancelDeliveryStatusPolling()
          return
        }
        if (status.persisted) {
          confirmUserMessage(status.userMessageId || userMessageId)
          if (status.conversationId) setConversationId(status.conversationId)
          return
        }
      } catch {
        // The chat request remains authoritative; transient status failures are retried.
      }
      scheduleDeliveryStatusPoll(OUTGOING_DELIVERY_STATUS_POLL_INTERVAL_MS)
    }

    deliveryTimeout = setTimeout(() => {
      if (!isCurrentDelivery() || userMessageConfirmed) return
      cancelDeliveryStatusPolling()
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
      const sendRequest = api.sendMessage({
        message: text,
        clientMessageId: userMessageId,
        conversationId: conversationIdForSend,
        userId,
        character,
        quote,
        voice,
      })
      scheduleDeliveryStatusPoll(OUTGOING_DELIVERY_STATUS_POLL_INITIAL_DELAY_MS)
      const response = await sendRequest
      if (!isCurrentDelivery()) return
      if (response.userMessageId) {
        confirmUserMessage(response.userMessageId)
      }
      markConversationActive(character.id, messageCreatedAt, text)
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
        stageAssistantMessages(
          loadingId,
          incomingMessages,
          Date.now() - assistantTypingStartedAt
        )
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
      cancelDeliveryStatusPolling()
      if (isCurrentDelivery()) {
        sendingRef.current = false
        setSending(false)
        void refreshState()
      }
    }
  }

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const offsetFromLatest = Math.max(0, contentOffset.y)
    scrollMetricsRef.current = {
      contentHeight: contentSize.height,
      offsetY: offsetFromLatest,
      viewportHeight: layoutMeasurement.height,
    }
    const withinImmersiveRange = offsetFromLatest <= NEAR_LATEST_THRESHOLD
    withinImmersiveRangeRef.current = withinImmersiveRange
    if (manualScrollRef.current) followLatestRef.current = withinImmersiveRange
    if (withinImmersiveRange) hideScrollToLatest()
  }

  const handleListLayout = (event: LayoutChangeEvent) => {
    closeMessageActionMenu()
    const viewportHeight = event.nativeEvent.layout.height
    scrollMetricsRef.current.viewportHeight = viewportHeight
    scrollViewportHeight.value = viewportHeight
  }

  const handleContentSizeChange = (_width: number, height: number) => {
    scrollMetricsRef.current.contentHeight = height
    scrollContentHeight.value = height
    if (initialScrollRef.current) {
      settleInitialScroll()
      return
    }
    if (followLatestRef.current) {
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }))
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
    Keyboard.dismiss()
    voiceInput.toggle(draft)
  }

  const switchToVoiceComposer = () => {
    if (voiceInput.status === 'recording' || voiceInput.status === 'processing') return
    Keyboard.dismiss()
    voiceInput.reset()
    setComposerMode('voice')
  }

  const switchToTextComposer = () => {
    voiceMessageRecorder.reset()
    setComposerMode('text')
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  const messageActionMessage = messageActionSession
    ? messages.find(message => (
        (message.renderKey || message.id) === messageActionSession.messageKey
      ))
    : undefined
  const messageActionIsVoice = Boolean(messageActionMessage?.voice)
  const messageActionCanDiscardVoiceTranscript = Boolean(
    messageActionMessage
    && isUserVoiceMessage(messageActionMessage)
    && messageActionMessage.voice.transcriptStatus === 'ready'
    && messageActionMessage.voiceTranscriptVisible
  )
  const messageActionItemCount = messageActionMessage
    ? (messageActionIsVoice
        ? (isUserVoiceMessage(messageActionMessage) ? 2 : 3)
        : 4)
    : 0
  const messageActionMenuHeight = messageActionMessage && isUserVoiceMessage(messageActionMessage)
    ? MESSAGE_ACTION_MENU_EXPANDED_HEIGHT
    : MESSAGE_ACTION_MENU_COMPACT_HEIGHT
  const messageActionLayout = messageActionSession && messageActionMessage
    ? getMessageActionLayout({
        anchor: messageActionSession.anchor,
        viewportWidth: window.width,
        viewportHeight: window.height,
        safeLeft: insets.left,
        safeRight: insets.right,
        safeTop: insets.top,
        safeBottom: insets.bottom,
        itemCount: messageActionItemCount,
        menuHeight: messageActionMenuHeight,
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
  const forwardableCharacters = useMemo(() => {
    const query = forwardSearch.trim().toLocaleLowerCase()
    if (!query) return characters
    return characters.filter(item => (
      [item.name, item.role, item.company, item.personality]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(query)
    ))
  }, [characters, forwardSearch])

  if (!ready) {
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
            <FlashList
              ref={listRef}
              data={timelineItems}
              inverted
              contentOffset={initialContentOffsetRef.current}
              maintainVisibleContentPosition={CHAT_MAINTAIN_VISIBLE_CONTENT_POSITION}
              keyExtractor={item => item.key}
              getItemType={chatTimelineItemType}
              drawDistance={window.height}
              extraData={messageActionSession}
              renderItem={({ item, index }) => {
                if (item.kind === 'date') {
                  return (
                    <View onLayout={event => handleTimelineItemLayout(item.key, event)}>
                      <DateDivider label={item.label} />
                    </View>
                  )
                }
                const message = item.message
                const messageKey = messageRenderKey(message)
                const selectionSession = messageActionSession?.messageKey === messageKey
                  ? messageActionSession
                  : undefined
                return (
                  <View onLayout={event => handleTimelineItemLayout(item.key, event)}>
                    <MessageRow
                    message={message}
                    characterName={character.name}
                    characterAvatar={character.avatar}
                    userAvatar={userAvatar}
                    onPreviewAvatar={setAvatarPreview}
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
                    continuation={item.continuation}
                    atLatestEdge={index === 0}
                    />
                  </View>
                )
              }}
              style={styles.messageList}
              contentContainerStyle={styles.messageListContent}
              scrollEnabled={!messageActionSession}
              automaticallyAdjustContentInsets={false}
              contentInsetAdjustmentBehavior="never"
              keyboardShouldPersistTaps={messageActionSession ? 'always' : 'handled'}
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              onLayout={handleListLayout}
              onLoad={settleInitialScroll}
              onScroll={handleScroll}
              onScrollBeginDrag={() => {
                closeMessageActionMenu()
                manualScrollRef.current = true
                followLatestRef.current = false
              }}
              onScrollEndDrag={() => {
                manualScrollRef.current = false
                followLatestRef.current = withinImmersiveRangeRef.current
              }}
              onMomentumScrollEnd={() => {
                manualScrollRef.current = false
                followLatestRef.current = withinImmersiveRangeRef.current
              }}
              onEndReached={() => void loadOlderHistory()}
              onEndReachedThreshold={0.15}
              onContentSizeChange={handleContentSizeChange}
              scrollEventThrottle={16}
            />
            {loadingOlderHistory && (
              <View pointerEvents="none" style={styles.olderHistoryLoading}>
                <ActivityIndicator size="small" color={palette.textMuted} />
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
                    {unseenLatestCount > 1 ? `${unseenLatestCount} new messages` : 'New messages'}
                  </Text>
                </Pressable>
              )}

              <View style={[
                styles.composer,
                { paddingBottom: Math.max(8, insets.bottom) },
              ]}>
                {composerMode === 'text' && voiceInputMode === 'cloud' && (
                  voiceInput.status === 'recording' || voiceInput.status === 'processing'
                ) ? (
                  <View style={styles.composerInputRow}>
                    <Pressable
                      disabled
                      accessibilityRole="button"
                      accessibilityLabel="Voice message mode is unavailable while transcribing"
                      style={[styles.composerModeButton, styles.voiceButtonDisabled]}
                    >
                      <WeChatVoiceWave color={palette.text} centered height={22} />
                    </Pressable>
                    <View
                      accessibilityRole="progressbar"
                      accessibilityLabel={voiceInput.status === 'processing'
                        ? 'Preparing cloud transcription'
                        : 'Recording for cloud transcription'}
                      style={styles.cloudDictationBar}
                    >
                      {voiceInput.status === 'processing' ? (
                        <ActivityIndicator size="small" color="#C9D1DC" />
                      ) : <CloudDictationWaveform
                        metering={voiceInput.metering}
                        recording={voiceInput.status === 'recording'}
                        tick={voiceInput.recordingDurationMilliseconds}
                      />}
                    </View>
                    <Pressable
                      onPress={voiceInput.reset}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel cloud transcription"
                      style={({ pressed }) => [
                        styles.cloudDictationAction,
                        pressed && styles.cloudDictationActionPressed,
                      ]}
                    >
                      <Ionicons name="close" size={25} color="#667085" />
                    </Pressable>
                    <Pressable
                      onPress={voiceInput.stop}
                      disabled={voiceInput.status !== 'recording'}
                      accessibilityRole="button"
                      accessibilityLabel="Convert recording to text"
                      style={({ pressed }) => [
                        styles.cloudDictationAction,
                        styles.cloudDictationConfirmAction,
                        voiceInput.status !== 'recording' && styles.voiceButtonDisabled,
                        pressed && voiceInput.status === 'recording' && styles.cloudDictationActionPressed,
                      ]}
                    >
                      <Ionicons name="checkmark" size={25} color="#FFFFFF" />
                    </Pressable>
                  </View>
                ) : composerMode === 'text' ? (
                  <View style={styles.composerInputRow}>
                    <Pressable
                      onPress={switchToVoiceComposer}
                      accessibilityRole="button"
                      accessibilityLabel="Switch to voice message"
                      style={({ pressed }) => [styles.composerModeButton, pressed && styles.voiceButtonPressed]}
                    >
                      <WeChatVoiceWave color={palette.text} centered height={22} />
                    </Pressable>
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
                        : voiceInput.status === 'recording'
                          ? `Stop ${voiceInputMode === 'local' ? 'local speech recognition' : 'cloud transcription'}`
                          : `Start ${voiceInputMode === 'local' ? 'local speech recognition' : 'cloud transcription'}`}
                      accessibilityState={{
                        busy: voiceInput.status === 'processing',
                        selected: voiceInput.status === 'recording',
                      }}
                      style={({ pressed }) => [
                        styles.voiceButton,
                        voiceInput.status === 'recording' && voiceInputMode === 'local' && styles.voiceButtonLocalRecording,
                        voiceInput.status === 'error' && styles.voiceButtonError,
                        voiceInput.status === 'processing' && styles.voiceButtonDisabled,
                        pressed && voiceInput.status !== 'processing' && styles.voiceButtonPressed,
                      ]}
                    >
                      <Ionicons
                        name={voiceInput.status === 'recording'
                          ? 'mic'
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
                ) : (
                  <View style={styles.composerInputRow}>
                    <Pressable
                      onPress={switchToTextComposer}
                      disabled={voiceMessageRecorder.status === 'recording' || voiceMessageRecorder.status === 'processing'}
                      accessibilityRole="button"
                      accessibilityLabel="Switch to text input"
                      style={({ pressed }) => [
                        styles.composerModeButton,
                        (voiceMessageRecorder.status === 'recording' || voiceMessageRecorder.status === 'processing')
                          && styles.voiceButtonDisabled,
                        pressed && styles.voiceButtonPressed,
                      ]}
                    >
                      <Ionicons name="keypad-outline" size={22} color={palette.text} />
                    </Pressable>
                    <Pressable
                      delayLongPress={0}
                      disabled={voiceMessageRecorder.status === 'processing'}
                      onPressIn={event => void voiceMessageRecorder.start(event.nativeEvent.pageX)}
                      onTouchMove={event => voiceMessageRecorder.updateActionForPosition(event.nativeEvent.pageX)}
                      onPressOut={event => {
                        voiceMessageRecorder.updateActionForPosition(event.nativeEvent.pageX)
                        void voiceMessageRecorder.finish()
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Hold to record and send a voice message"
                      style={({ pressed }) => [
                        styles.holdToTalkButton,
                        voiceMessageRecorder.status === 'recording' && styles.holdToTalkButtonRecording,
                        voiceMessageRecorder.status === 'error' && styles.holdToTalkButtonError,
                        voiceMessageRecorder.status === 'processing' && styles.voiceButtonDisabled,
                        pressed && voiceMessageRecorder.status !== 'processing' && styles.holdToTalkButtonPressed,
                      ]}
                    >
                      <Text style={styles.holdToTalkText}>
                        {voiceMessageRecorder.status === 'recording'
                          ? 'Release to send'
                          : voiceMessageRecorder.status === 'processing'
                            ? 'Preparing...'
                            : 'Hold to Talk'}
                      </Text>
                    </Pressable>
                  </View>
                )}
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
          {loadingHistory && historyCacheResolved && messages.length === 0 && (
            <View style={styles.conversationLoadingOverlay}>
              <ActivityIndicator color={palette.accent} />
            </View>
          )}
        </View>
      </View>

      {voiceMessageRecorder.status === 'recording' && (
        <View pointerEvents="none" style={styles.voiceRecordingOverlay}>
          <View style={styles.voiceRecordingPreview}>
            <View style={styles.voiceRecordingWave}>
              {[8, 14, 22, 30, 18, 26, 12, 24, 16, 28, 20, 10].map((height, index) => (
                <View key={index} style={[styles.voiceRecordingBar, { height }]} />
              ))}
            </View>
          </View>
          <View style={styles.voiceRecordingActions}>
            <Text style={styles.voiceRecordingActionLabel}>Cancel</Text>
            <Text style={styles.voiceRecordingActionLabel}>Convert to Text</Text>
          </View>
          <Text style={styles.voiceRecordingInstruction}>
            {voiceMessageRecorder.action === 'cancel'
              ? 'Release to cancel'
              : voiceMessageRecorder.action === 'convert'
                ? 'Release to convert to text'
                : 'Release to send'}
          </Text>
        </View>
      )}

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
                height: messageActionMenuHeight,
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
            {!messageActionIsVoice && <>
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
              <View style={styles.messageActionIconSlot}>
                <Ionicons name="copy-outline" size={18} color="#FFFFFF" />
              </View>
              <Text style={styles.messageActionLabel}>Copy</Text>
              </Pressable>
              <View style={styles.messageActionDivider} />
            </>}
            {!messageActionIsVoice && <>
            <Pressable
              onPressIn={() => {
                messageActionPressRef.current = true
              }}
              onPressOut={() => {
                messageActionPressRef.current = false
              }}
              onPress={() => openForwardPicker(messageActionMessage)}
              style={({ pressed }) => [styles.messageAction, pressed && styles.messageActionPressed]}
            >
              <View style={styles.messageActionIconSlot}>
                <Ionicons name="arrow-redo-outline" size={19} color="#FFFFFF" />
              </View>
              <Text style={styles.messageActionLabel}>Forward</Text>
            </Pressable>
            <View style={styles.messageActionDivider} />
            </>}
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
              <View style={styles.messageActionIconSlot}>
                <Ionicons name="return-up-back-outline" size={19} color="#FFFFFF" />
              </View>
              <Text style={styles.messageActionLabel}>Quote</Text>
            </Pressable>
            <View style={styles.messageActionDivider} />
            {isUserVoiceMessage(messageActionMessage) ? (
              <Pressable
                disabled={messageActionMessage.voiceTranscriptionLoading}
                onPressIn={() => {
                  messageActionPressRef.current = true
                }}
                onPressOut={() => {
                  messageActionPressRef.current = false
                }}
                onPress={() => {
                  if (messageActionCanDiscardVoiceTranscript) {
                    discardVoiceMessageText(messageActionMessage)
                    return
                  }
                  void convertVoiceMessageToText(messageActionMessage)
                }}
                style={({ pressed }) => [
                  styles.messageAction,
                  messageActionMessage.voiceTranscriptionLoading && styles.messageActionDisabled,
                  pressed && styles.messageActionPressed,
              ]}
            >
                <View style={styles.messageActionIconSlot}>
                  {messageActionCanDiscardVoiceTranscript ? (
                    <View style={styles.messageActionDocumentDiscardIcon}>
                      <Ionicons name="document-text-outline" size={18} color="#FFFFFF" />
                      <View style={styles.messageActionDocumentDiscardMark}>
                        <Ionicons name="close" size={7} color="#FFFFFF" />
                      </View>
                    </View>
                  ) : <Ionicons name="document-text-outline" size={18} color="#FFFFFF" />}
                </View>
                <Text style={styles.messageActionLabel}>
                  {messageActionMessage.voiceTranscriptionLoading
                    ? 'Converting'
                    : messageActionCanDiscardVoiceTranscript
                      ? 'Discard converted'
                      : <>Convert{'\n'}to Text</>}
                </Text>
              </Pressable>
            ) : (
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
                <View style={styles.messageActionIconSlot}>
                  <Ionicons name="language-outline" size={18} color="#FFFFFF" />
                </View>
                <Text style={styles.messageActionLabel}>
                  {messageActionMessage.translationVisible ? 'Hide' : 'Translate'}
                </Text>
              </Pressable>
            )}
            {messageActionMessage.voice?.provider === 'qwen3-tts' && messageActionMessage.voice.status === 'ready' && (
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
                  <View style={styles.messageActionIconSlot}>
                    <Ionicons name="document-text-outline" size={18} color="#FFFFFF" />
                  </View>
                  <Text style={styles.messageActionLabel}>
                    {messageActionMessage.voiceTranscriptVisible ? 'Hide text' : 'Show text'}
                  </Text>
                </Pressable>
              </>
            )}
          </RNAnimated.View>
        </View>
      )}
      <Modal
        transparent
        animationType="none"
        visible={forwardPickerVisible}
        statusBarTranslucent
        onRequestClose={() => {
          if (forwardTarget) dismissForwardConfirmation()
          else dismissForwardPicker()
        }}
      >
        <RNAnimated.View
          style={[
            styles.forwardPickerScreen,
            { transform: [{ translateY: forwardPickerTranslateY }] },
          ]}
        >
          <SafeAreaView style={styles.forwardPickerSafeArea} edges={['top', 'bottom', 'left', 'right']}>
            <View style={styles.forwardPickerHeader}>
              <Pressable
                onPress={dismissForwardPicker}
                disabled={forwardSubmitting}
                accessibilityRole="button"
                accessibilityLabel="Close forwarding"
                style={({ pressed }) => [styles.forwardPickerHeaderButton, pressed && styles.forwardPickerHeaderButtonPressed]}
              >
                <Text style={styles.forwardPickerHeaderCommand}>Close</Text>
              </Pressable>
              <Text style={styles.forwardPickerTitle}>Forward to</Text>
              <View style={styles.forwardPickerHeaderButton} />
            </View>
            <View style={styles.forwardSearchBox}>
              <Ionicons name="search" size={20} color="#98A2B3" />
              <TextInput
                value={forwardSearch}
                onChangeText={setForwardSearch}
                placeholder="Search"
                placeholderTextColor="#98A2B3"
                clearButtonMode="while-editing"
                returnKeyType="search"
                style={styles.forwardSearchInput}
              />
            </View>
            <FlashList
              data={forwardableCharacters}
              keyExtractor={item => item.id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.forwardContactList}
              ListHeaderComponent={<Text style={styles.forwardContactHeading}>Recent chats</Text>}
              ListEmptyComponent={<Text style={styles.forwardEmptyText}>No matching conversations.</Text>}
              renderItem={({ item }) => {
                const isCurrentChat = item.id === characterId
                return (
                  <Pressable
                    disabled={isCurrentChat || forwardSubmitting}
                    onPress={() => selectForwardTarget(item)}
                    accessibilityRole="button"
                    accessibilityLabel={isCurrentChat ? `${item.name}, current chat` : `Forward to ${item.name}`}
                    style={({ pressed }) => [
                      styles.forwardContactRow,
                      isCurrentChat && styles.forwardContactRowDisabled,
                      pressed && !isCurrentChat && styles.forwardContactRowPressed,
                    ]}
                  >
                    <Avatar avatar={item.avatar} name={item.name} size={46} />
                    <Text style={[styles.forwardContactName, isCurrentChat && styles.forwardContactNameDisabled]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {isCurrentChat && <Text style={styles.forwardCurrentChat}>Current chat</Text>}
                    {!isCurrentChat && <Ionicons name="chevron-forward" size={20} color="#98A2B3" />}
                  </Pressable>
                )
              }}
            />
          </SafeAreaView>

          {forwardTarget && forwardingMessage && (
            <View style={styles.forwardConfirmationOverlay}>
              <Pressable
                disabled={forwardSubmitting}
                onPress={dismissForwardConfirmation}
                accessibilityRole="button"
                accessibilityLabel="Cancel forwarding"
                style={StyleSheet.absoluteFill}
              />
              <RNAnimated.View
                style={[
                  styles.forwardConfirmationSheet,
                  {
                    paddingBottom: Math.max(18, insets.bottom),
                    transform: [{ translateY: forwardConfirmationTranslateY }],
                  },
                ]}
              >
                <Text style={styles.forwardConfirmationTitle}>Send to</Text>
                <View style={styles.forwardRecipientRow}>
                  <Avatar avatar={forwardTarget.avatar} name={forwardTarget.name} size={50} />
                  <Text style={styles.forwardRecipientName} numberOfLines={1}>{forwardTarget.name}</Text>
                </View>
                <View style={styles.forwardMessagePreview}>
                  <Text style={styles.forwardMessagePreviewText} numberOfLines={4}>{forwardingMessage.text}</Text>
                </View>
                <TextInput
                  value={forwardNote}
                  onChangeText={setForwardNote}
                  placeholder="Add a message"
                  placeholderTextColor="#98A2B3"
                  multiline
                  maxLength={20_000}
                  style={styles.forwardNoteInput}
                />
                <View style={styles.forwardConfirmationActions}>
                  <Pressable
                    disabled={forwardSubmitting}
                    onPress={dismissForwardConfirmation}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel forwarding"
                    style={({ pressed }) => [styles.forwardCancelButton, pressed && styles.forwardCancelButtonPressed]}
                  >
                    <Text style={styles.forwardCancelButtonText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    disabled={forwardSubmitting}
                    onPress={() => void sendForwardMessage()}
                    accessibilityRole="button"
                    accessibilityLabel="Send forwarded message"
                    style={({ pressed }) => [
                      styles.forwardSendButton,
                      forwardSubmitting && styles.forwardSendButtonDisabled,
                      pressed && !forwardSubmitting && styles.forwardSendButtonPressed,
                    ]}
                  >
                    {forwardSubmitting
                      ? <ActivityIndicator size="small" color="#FFFFFF" />
                      : <Text style={styles.forwardSendButtonText}>Send</Text>}
                  </Pressable>
                </View>
              </RNAnimated.View>
            </View>
          )}
        </RNAnimated.View>
      </Modal>
      <Modal
        transparent
        animationType="fade"
        visible={conversationActionsVisible}
        onRequestClose={() => setConversationActionsVisible(false)}
      >
        <View style={styles.conversationActionsOverlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close conversation options"
            onPress={() => setConversationActionsVisible(false)}
            style={StyleSheet.absoluteFill}
          />
          <View style={[styles.conversationActionsSheet, { paddingBottom: Math.max(12, insets.bottom) }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={pinnedCharacterIds.has(character.id) ? 'Unpin conversation' : 'Pin conversation'}
              onPress={toggleConversationPin}
              style={({ pressed }) => [styles.conversationAction, pressed && styles.conversationActionPressed]}
            >
              <Ionicons
                name={pinnedCharacterIds.has(character.id) ? 'pin-outline' : 'pin'}
                size={20}
                color={palette.text}
              />
              <Text style={styles.conversationActionLabel}>
                {pinnedCharacterIds.has(character.id) ? 'Unpin' : 'Pin to top'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit character"
              onPress={editConversationCharacter}
              style={({ pressed }) => [styles.conversationAction, pressed && styles.conversationActionPressed]}
            >
              <Ionicons name="create-outline" size={21} color={palette.text} />
              <Text style={styles.conversationActionLabel}>Edit character</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear conversation"
              onPress={confirmClearConversation}
              style={({ pressed }) => [styles.conversationAction, pressed && styles.conversationActionPressed]}
            >
              <Ionicons name="trash-outline" size={20} color={palette.danger} />
              <Text style={[styles.conversationActionLabel, styles.conversationActionDestructive]}>Clear history</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <AvatarPreviewModal preview={avatarPreview} onClose={() => setAvatarPreview(null)} />
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
    position: 'relative',
  },
  conversationLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.background,
  },
  messageListArea: {
    flex: 1,
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    flexGrow: 1,
    // Native layout is flipped by `inverted`; placing a short transcript at its
    // native end makes it begin at the visual top of the chat area.
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    // Inversion swaps the physical content edges: top is the visual composer edge.
    paddingTop: MESSAGE_LIST_EDGE_GAP,
    paddingBottom: MESSAGE_LIST_EDGE_GAP,
  },
  olderHistoryLoading: {
    position: 'absolute',
    top: 8,
    alignSelf: 'center',
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: 'rgba(255, 255, 255, 0.88)',
  },
  messageRow: {
    width: '100%',
    marginBottom: MESSAGE_ROW_GAP,
    flexDirection: 'column',
  },
  messageRowLatest: {
    marginBottom: 0,
  },
  dateDivider: {
    alignItems: 'center',
    paddingTop: 3,
    paddingBottom: 11,
  },
  dateDividerLabel: {
    color: palette.textMuted,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  messagePrimaryRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  messagePrimaryRowAssistant: {
    justifyContent: 'flex-start',
  },
  messagePrimaryRowUser: {
    justifyContent: 'flex-end',
  },
  assistantAvatar: {
    alignSelf: 'flex-start',
  },
  userAvatar: {
    alignSelf: 'flex-start',
  },
  avatarPreviewOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
  },
  avatarPreviewContent: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPreviewFrame: {
    width: '78%',
    maxWidth: 320,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: 8,
  },
  avatarPreviewImage: {
    width: '100%',
    height: '100%',
  },
  conversationActionsOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(17, 24, 39, 0.32)',
  },
  conversationActionsSheet: {
    paddingTop: 8,
    paddingHorizontal: 12,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    backgroundColor: palette.surface,
  },
  conversationAction: {
    height: 48,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 6,
  },
  conversationActionPressed: {
    backgroundColor: palette.surfaceMuted,
  },
  conversationActionLabel: {
    color: palette.text,
    fontSize: 16,
    lineHeight: 21,
  },
  conversationActionDestructive: {
    color: palette.danger,
  },
  forwardPickerScreen: {
    flex: 1,
    backgroundColor: palette.surface,
  },
  forwardPickerSafeArea: {
    flex: 1,
    backgroundColor: palette.surface,
  },
  forwardPickerHeader: {
    height: 54,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  forwardPickerHeaderButton: {
    width: 72,
    height: 40,
    justifyContent: 'center',
  },
  forwardPickerHeaderButtonPressed: {
    opacity: 0.55,
  },
  forwardPickerHeaderCommand: {
    color: palette.text,
    fontSize: 16,
    lineHeight: 21,
  },
  forwardPickerTitle: {
    color: palette.text,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '700',
  },
  forwardSearchBox: {
    height: 48,
    marginHorizontal: 16,
    marginTop: 14,
    marginBottom: 10,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: 8,
    backgroundColor: palette.background,
  },
  forwardSearchInput: {
    flex: 1,
    minWidth: 0,
    color: palette.text,
    fontSize: 17,
    lineHeight: 22,
  },
  forwardContactList: {
    paddingBottom: 12,
  },
  forwardContactHeading: {
    paddingHorizontal: 18,
    paddingTop: 9,
    paddingBottom: 7,
    color: palette.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  forwardContactRow: {
    minHeight: 68,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  forwardContactRowPressed: {
    backgroundColor: palette.background,
  },
  forwardContactRowDisabled: {
    opacity: 0.5,
  },
  forwardContactName: {
    flex: 1,
    minWidth: 0,
    color: palette.text,
    fontSize: 17,
    lineHeight: 22,
  },
  forwardContactNameDisabled: {
    color: palette.textMuted,
  },
  forwardCurrentChat: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  forwardEmptyText: {
    paddingTop: 30,
    color: palette.textMuted,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  forwardConfirmationOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(17, 24, 39, 0.46)',
  },
  forwardConfirmationSheet: {
    paddingTop: 20,
    paddingHorizontal: 18,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    backgroundColor: palette.background,
  },
  forwardConfirmationTitle: {
    color: palette.text,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '700',
    marginBottom: 15,
  },
  forwardRecipientRow: {
    minHeight: 58,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  forwardRecipientName: {
    flex: 1,
    minWidth: 0,
    color: palette.text,
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '600',
  },
  forwardMessagePreview: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: palette.surface,
  },
  forwardMessagePreviewText: {
    color: palette.text,
    fontSize: 16,
    lineHeight: 22,
  },
  forwardNoteInput: {
    minHeight: 48,
    maxHeight: 110,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: palette.text,
    fontSize: 16,
    lineHeight: 22,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 8,
    backgroundColor: palette.surface,
    textAlignVertical: 'top',
  },
  forwardConfirmationActions: {
    marginTop: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 14,
  },
  forwardCancelButton: {
    width: 128,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#DDE2E8',
  },
  forwardCancelButtonPressed: {
    opacity: 0.68,
  },
  forwardCancelButtonText: {
    color: palette.text,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '600',
  },
  forwardSendButton: {
    width: 128,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: palette.accent,
  },
  forwardSendButtonDisabled: {
    opacity: 0.62,
  },
  forwardSendButtonPressed: {
    backgroundColor: palette.accentPressed,
  },
  forwardSendButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '700',
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
    width: 40,
    height: 1,
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
  voiceBubble: {
    minHeight: 40,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  bubbleSelecting: {
    overflow: 'visible',
  },
  bubbleContent: {
    position: 'relative',
  },
  assistantBubble: {
    backgroundColor: palette.assistantBubble,
    // The hairline border reduces the visible white fill slightly; compensate against the 40px avatar.
    minHeight: 41,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E3E8EF',
    paddingVertical: 9 - StyleSheet.hairlineWidth,
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
    marginLeft: 48,
    alignItems: 'flex-start',
  },
  messageSupplementUser: {
    alignSelf: 'flex-end',
    marginRight: 48,
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
    maxWidth: '100%',
    minHeight: 38,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 8,
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E3E8EF',
  },
  voiceTranscriptText: {
    color: palette.text,
    fontSize: 16,
    lineHeight: 22,
    includeFontPadding: false,
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
  composerModeButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#C9D1DC',
    backgroundColor: '#FFFFFF',
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
  voiceButtonLocalRecording: {
    borderColor: palette.accentBorder,
    backgroundColor: palette.accentSoft,
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
  cloudDictationBar: {
    flex: 1,
    height: 44,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C9D1DC',
    backgroundColor: '#FFFFFF',
  },
  cloudDictationWave: {
    width: '100%',
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  cloudDictationWaveBar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: '#667085',
  },
  cloudDictationAction: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C9D1DC',
    backgroundColor: '#FFFFFF',
  },
  cloudDictationConfirmAction: {
    borderColor: palette.accent,
    backgroundColor: palette.accent,
  },
  cloudDictationActionPressed: {
    opacity: 0.68,
  },
  holdToTalkButton: {
    flex: 1,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#C9D1DC',
  },
  holdToTalkButtonPressed: {
    backgroundColor: '#EDF9EF',
    borderColor: palette.accentBorder,
  },
  holdToTalkButtonRecording: {
    backgroundColor: palette.accentSoft,
    borderColor: palette.accentBorder,
  },
  holdToTalkButtonError: {
    borderColor: '#FDA29B',
    backgroundColor: '#FFF3F1',
  },
  holdToTalkText: {
    color: palette.text,
    fontSize: 17,
    fontWeight: '600',
  },
  sendButtonDisabled: {
    backgroundColor: palette.accentMuted,
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
    paddingHorizontal: MESSAGE_ACTION_MENU_HORIZONTAL_PADDING,
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
    borderBottomWidth: MESSAGE_ACTION_ARROW_SIZE + 1,
    borderBottomColor: '#2B2D30',
  },
  messageActionArrowBottom: {
    bottom: -MESSAGE_ACTION_ARROW_SIZE,
    borderTopWidth: MESSAGE_ACTION_ARROW_SIZE + 1,
    borderTopColor: '#2B2D30',
  },
  messageAction: {
    width: MESSAGE_ACTION_ITEM_WIDTH,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 15,
    paddingBottom: 10,
    gap: 3,
  },
  messageActionPressed: {
    opacity: 0.65,
  },
  messageActionDisabled: {
    opacity: 0.35,
  },
  messageActionLabel: {
    width: '100%',
    color: '#FFFFFF',
    fontSize: 11,
    lineHeight: 14,
    textAlign: 'center',
  },
  messageActionIconSlot: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageActionDocumentDiscardIcon: {
    width: 18,
    height: 18,
  },
  messageActionDocumentDiscardMark: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2B2D30',
  },
  messageActionDivider: {
    width: StyleSheet.hairlineWidth,
    height: 38,
    backgroundColor: '#5A5D62',
  },
  voiceRecordingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 80,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 46,
    backgroundColor: 'rgba(16, 24, 40, 0.66)',
  },
  voiceRecordingPreview: {
    width: 230,
    height: 124,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.accent,
    marginBottom: 46,
  },
  voiceRecordingWave: {
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  voiceRecordingBar: {
    width: 4,
    borderRadius: 2,
    backgroundColor: palette.accentDeep,
  },
  voiceRecordingActions: {
    width: '100%',
    paddingHorizontal: 42,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  voiceRecordingActionLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  voiceRecordingInstruction: {
    marginTop: 26,
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
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
