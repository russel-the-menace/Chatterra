import asyncio
import io
import os
import threading
from typing import Literal

import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from qwen_tts import Qwen3TTSModel

app = FastAPI(title="Chatterra Qwen3-TTS", version="1.0.0")

MAYA_VOICE_DESCRIPTION = (
    "An original adult American woman in her early twenties with a warm, intimate, "
    "clear voice. She sounds thoughtful, playful when appropriate, and emotionally "
    "present without sounding theatrical. This is an AI character voice and must not "
    "imitate any real person."
)
MAX_TEXT_LENGTH = 360
_model: Qwen3TTSModel | None = None
_model_lock = threading.Lock()
_generation_lock = threading.Lock()


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_LENGTH)
    language: Literal["English"] = "English"
    style: str = Field(min_length=1, max_length=320)
    voiceId: Literal["maya"]


def model() -> Qwen3TTSModel:
    global _model
    with _model_lock:
        if _model is not None:
            return _model
        if not torch.cuda.is_available():
            raise RuntimeError("Qwen3-TTS requires a CUDA GPU; no CUDA device is available")
        model_id = os.getenv("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
        _model = Qwen3TTSModel.from_pretrained(
            model_id,
            device_map=os.getenv("QWEN_TTS_DEVICE", "cuda:0"),
            dtype=torch.bfloat16,
            attn_implementation=os.getenv("QWEN_TTS_ATTENTION", "sdpa"),
        )
        return _model


def synthesize(request: SpeechRequest) -> tuple[bytes, float]:
    with _generation_lock:
        wavs, sample_rate = model().generate_voice_design(
            text=request.text.strip(),
            language=request.language,
            instruct=(
                f"{MAYA_VOICE_DESCRIPTION} Delivery for this specific short voice note: "
                f"{request.style.strip()}. Keep the same core voice identity."
            ),
        )
    if not wavs:
        raise RuntimeError("Qwen3-TTS returned no audio")
    output = io.BytesIO()
    sf.write(output, wavs[0], sample_rate, format="WAV", subtype="PCM_16")
    duration = len(wavs[0]) / sample_rate
    return output.getvalue(), duration


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": os.getenv("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"),
        "loaded": _model is not None,
        "cuda": torch.cuda.is_available(),
    }


@app.post("/v1/speech")
async def speech(request: SpeechRequest):
    try:
        audio, duration = await asyncio.to_thread(synthesize, request)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"X-Audio-Duration-Seconds": f"{duration:.1f}"},
    )
