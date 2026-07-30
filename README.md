# Chatterra

<p align="center">
  <img src="mobile/assets/images/chatterra-mark.png" width="88" alt="Chatterra" />
</p>

<p align="center"><strong>Language practice in the shape of a real conversation.</strong></p>

Chatterra began with a small frustration: language-learning products are very good at
giving exercises, but they rarely give you someone you would actually want to text.
I did not want another chat window that happened to translate things. I wanted an
inbox full of people with different voices, routines, opinions, languages, and reasons
to answer.

That idea slowly became a mobile app built around characters rather than lessons. The
characters correct you when correction helps, but they are still allowed to simply talk
to you.

<p align="center">
  <img src="docs/assets/conversation-list.png" width="300" alt="Chatterra conversation list" />
</p>

## The first reason it existed: learn English without leaving a conversation

The first contact was **Emma Carter**, an English teacher. Her job is deliberately
modest: have a normal conversation, notice the few mistakes worth correcting, explain
them clearly, and then keep the thread moving. A correction should feel like a good
friend saying "this is how I would put it," not a red pen taking over the chat.

<p align="center">
  <img src="docs/assets/english-teacher-corrections.png" width="300" alt="Emma Carter correcting English in a conversation" />
</p>

From there, the contact list grew in directions a generic "AI tutor" could not cover:

- **David**, the interviewer, is there for pressure, follow-up questions, and the
  particular rhythm of speaking when an answer matters.
- **Arjun Mehta**, the client, is a different kind of practice: professional context,
  requirements, trade-offs, and the need to make yourself understood.
- **Mala Lo** is my Cantonese-speaking contact. I love Cantonese and its very direct,
  funny, sometimes profane everyday texture, so I wanted a person who felt like a real
  Hong Kong speaker: Cantonese mixed with English, able to understand Mandarin-typed
  Cantonese, and never sanitized into textbook dialogue.

<p align="center">
  <img src="docs/assets/cantonese-code-switching.png" width="300" alt="A Cantonese conversation that naturally mixes English" />
</p>

## Then came the question: what makes a character feel like a person?

At first, a character was mostly a role and a prompt. That was not enough. It produced
answers, but not someone with a recognisable way of being. The final design treats a
character as a versioned document with a runtime life around it:

- a full character document describes voice, boundaries, language, background, and
  conversational priorities;
- structured front matter derives runtime policy such as mode, time zone, and initiative
  behaviour instead of scattering those attributes across UI fields;
- each user gets a private character instance with its own relationship state, memories,
  event history, and next-action time;
- the inference layer composes relevant memories, summaries, local time, and recent
  messages before it asks the model to respond;
- replies are validated and saved as delivery segments so an answer can arrive as
  believable separate bubbles instead of one assistant-shaped paragraph.

<table>
  <tr>
    <td width="43%" valign="top">
      <img src="docs/assets/character-document-editor.png" alt="The editable character document" />
    </td>
    <td width="57%" valign="top">
      <img src="docs/assets/character-architecture.svg" alt="Character document and runtime architecture" />
    </td>
  </tr>
</table>

This is why Maya is more than "a girlfriend prompt." She is a young adult pre-med
student in New York with a particular texting style, realistic boundaries, emoji use,
and her own reasons to reach out. She can proactively start a conversation from her
state and recent context, but the policy explicitly rules out pressure, guilt, demands,
or manufactured dependency. She was designed because language environments often miss
the way young people actually write: fragments, lowercase, small reactions, slang, and
emojis that carry tone rather than decorate a sentence.

<p align="center">
  <img src="docs/assets/maya-proactive-messages.png" width="300" alt="Maya sending natural multi-bubble messages" />
</p>

The same principle shaped the language friends:

- **Sofia Alvarez** is an Argentine Spanish tutor and friend for a true beginner working
  toward B2. She uses Rioplatense Spanish, teaches from zero in deliberate steps, and
  explains Spanish in English by default. That matters for a question such as "what does
  gracias mean?" when the rest of the sentence is English.
- **Minji** and **Yui** are Korean and Japanese university friends, not grammar robots.
  They understand English, answer naturally in their own language, and offer a brief,
  high-value phrasing suggestion only when it genuinely makes the learner sound more
  natural. For example, Yui can gently turn `日本語言える？` into `日本語話せる？` without
  turning every message into class.

<p align="center">
  <img src="docs/assets/japanese-translation.png" width="300" alt="Japanese chat with optional English translation" />
</p>

## Voice was not meant to be a novelty button

Text is useful, but a conversation feels fundamentally different when you can send a
voice note. Chatterra keeps two distinct flows: dictation that turns speech into an
editable draft, and hold-to-talk voice messages that remain audio in the conversation.
The latter can be played, paused, resumed, converted to text later, and replied to like
any other message.

**The point was to be able to send a voice message to a character on the subway without
anyone nearby thinking I was doing something strange.** It should look and behave like
sending a normal voice note, not like talking to an AI demo.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/korean-english-voice-input.png" alt="Cloud voice transcription for mixed Korean and English" />
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/spanish-voice-practice.png" alt="Spanish voice messages with text conversion" />
    </td>
  </tr>
</table>

When the app starts, the backend checks whether its Mihomo proxy listener is alive,
verifies a usable node, and makes an authenticated Groq connectivity probe. When that
path is healthy, short recordings go through Groq's `whisper-large-v3-turbo`, with a
character-aware prompt that helps mixed English + Spanish, Korean, Japanese, or
Cantonese speech. If that route is unavailable, the client falls back to iPhone's native
live speech recognition rather than pretending the microphone is broken. Audio-message
transcripts are stored with the existing message, so "Convert to Text" reuses the same
result instead of paying for the same transcription repeatedly.

There is also a documented route toward full realtime, call-like conversation. It is not
enabled by default: a realtime model has a recurring cost profile that this project does
not want to hide behind a shiny button.

## The parts that almost broke me

The UI looks deliberately quiet, close to the visual language of a familiar messaging
app. It took far more work than it appears to make it feel that way.

- Voice bubbles have their own playback state, duration-based width, animated reception
  mark, long-press actions, and transcript state. The tiny concentric voice mark was
  redrawn repeatedly until its three layers, spacing, and circular arcs matched the
  intended WeChat-like rhythm.
- The chat timeline uses an inverted **FlashList**, not a `FlatList` plus hopeful
  `scrollToEnd()` calls. Dynamic text, translations, voice bubbles, and segmented AI
  replies all have different heights. `maintainVisibleContentPosition`, measured item
  layout, and near-latest detection keep the latest message visible without throwing a
  reader back to the bottom when they are browsing history.
- Older history loads upward while preserving what was on screen. Cached conversations,
  contact previews, delivery state, and authentication live locally first; server sync
  adds newer messages without deleting this device's local history unless the user
  explicitly clears it here.
- AI replies are stored before the client stages their individual bubbles. The UI gives
  each segment a human-sized wait (bounded rather than arbitrary), so several messages do
  not arrive as one abrupt block.

Underneath the iOS-first interface is Expo/React Native, an Express API, PostgreSQL,
per-user session storage, and a small inference orchestration layer for character state,
memory retrieval, event history, proactive scheduling, response segmentation, and voice
metadata. The relevant design notes live in
[AI companion architecture](AI_COMPANION_ARCHITECTURE.md),
[voice input architecture](VOICE_INPUT_ARCHITECTURE.md), and
[database design](backend/DATABASE.md).

## Running it locally

The project contains a Vite web client, an Expo mobile client, and an Express/PostgreSQL
backend. The mobile app is the main experience.

```bash
docker compose up -d postgres
cd backend && npm install && npm run db:setup && npm start
```

In another terminal:

```bash
cd mobile && npm install && npx expo start
```

For an iPhone build and the available voice fallbacks, see
[mobile/README.md](mobile/README.md). Backend configuration and operational details are
in [backend/README.md](backend/README.md). Secrets belong only in local environment
files; none are part of this repository.

Anyway, I am still unusually happy with this little app. It is a language-learning
project, but more importantly it became a place where practicing can feel like keeping
in touch. 🎉
