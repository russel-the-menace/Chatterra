# Qwen3-TTS Service

This service generates Maya's short, AI-generated voice-message clips with
`Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`. It requires an NVIDIA CUDA GPU and is
intentionally separate from the Node backend so ordinary text chat never loads model
weights or blocks on speech synthesis.

Start it with Docker Compose on a CUDA host:

```bash
docker compose --profile voice up --build tts
```

Then configure the backend:

```bash
MAYA_VOICE_MESSAGES_ENABLED=true
QWEN_TTS_URL=http://localhost:8001
```

The first request downloads the Qwen model weights into the named Docker volume. The
service only accepts Maya's synthetic voice identifier and rejects requests when CUDA
is unavailable. It does not accept reference audio or clone an identifiable person.
