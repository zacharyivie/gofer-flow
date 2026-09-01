from __future__ import annotations

import base64
import io
import json
import os
import re
import shutil
import threading
import time
import uuid
import wave
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

CHAT_ATTACHMENT_MAX_COUNT = 5
CHAT_ATTACHMENT_MAX_FILE_BYTES = 20 * 1024 * 1024
CHAT_ATTACHMENT_MAX_TOTAL_BYTES = 40 * 1024 * 1024
CHAT_AUDIO_MAX_BYTES = 25 * 1024 * 1024
CHAT_AUDIO_CHUNK_MAX_BYTES = 1024 * 1024
CHAT_TRANSCRIPTION_MAX_SESSIONS = 8
CHAT_TRANSCRIPTION_SESSION_TTL_SECONDS = 15 * 60
VOSK_MODEL_NAME = "vosk-model-en-us-0.22-lgraph"
VOSK_MODEL_URL = f"https://alphacephei.com/vosk/models/{VOSK_MODEL_NAME}.zip"
VOSK_MODEL_DOWNLOAD_MAX_BYTES = 160 * 1024 * 1024
_SAFE_PART = re.compile(r"[^A-Za-z0-9_.-]+")
_vosk_model: Any | None = None
_vosk_model_path: Path | None = None
_vosk_model_lock = threading.Lock()
_transcription_sessions: dict[str, _TranscriptionSession] = {}
_transcription_sessions_lock = threading.Lock()


@dataclass
class _TranscriptionSession:
    recognizer: Any
    committed: list[str] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    updated_at: float = field(default_factory=time.monotonic)


class ChatMediaError(ValueError):
    pass


def store_chat_attachments(
    payload: dict[str, Any],
    data_dir: Path,
) -> dict[str, list[dict[str, Any]]]:
    thread_id = _safe_identifier(payload.get("threadId"), "thread")
    raw_files = payload.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise ChatMediaError("Choose at least one file to attach.")
    if len(raw_files) > CHAT_ATTACHMENT_MAX_COUNT:
        raise ChatMediaError(f"You can attach up to {CHAT_ATTACHMENT_MAX_COUNT} files.")

    decoded: list[tuple[str, str, bytes]] = []
    total = 0
    for item in raw_files:
        if not isinstance(item, dict):
            raise ChatMediaError("Each attachment must be a file object.")
        name = _safe_filename(item.get("name"))
        media_type = _safe_media_type(item.get("type"))
        try:
            content = base64.b64decode(str(item.get("data") or ""), validate=True)
        except (ValueError, TypeError) as exc:
            raise ChatMediaError(f"{name} could not be decoded.") from exc
        if len(content) > CHAT_ATTACHMENT_MAX_FILE_BYTES:
            raise ChatMediaError(f"{name} is larger than 20 MB.")
        total += len(content)
        if total > CHAT_ATTACHMENT_MAX_TOTAL_BYTES:
            raise ChatMediaError("Attachments cannot exceed 40 MB in one message.")
        decoded.append((name, media_type, content))

    target_dir = attachment_thread_dir(data_dir, thread_id)
    target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    attachments: list[dict[str, Any]] = []
    for name, media_type, content in decoded:
        attachment_id = uuid.uuid4().hex
        storage_name = f"{attachment_id}-{name}"
        path = target_dir / storage_name
        path.write_bytes(content)
        if os.name != "nt":
            path.chmod(0o600)
        attachments.append(
            {
                "id": attachment_id,
                "name": name,
                "size": len(content),
                "type": media_type,
                "storageName": storage_name,
            }
        )
    return {"attachments": attachments}


def resolve_chat_attachment(
    attachment: dict[str, Any],
    *,
    data_dir: Path,
    thread_id: str,
) -> Path:
    storage_name = str(attachment.get("storageName") or "")
    if not re.fullmatch(r"[0-9a-f]{32}-[^/\\]+", storage_name):
        raise ChatMediaError("An attached file reference is invalid.")
    root = attachment_thread_dir(data_dir, _safe_identifier(thread_id, "thread")).resolve()
    path = (root / storage_name).resolve()
    if path.parent != root or not path.is_file():
        name = attachment.get("name", "file")
        raise ChatMediaError(f"Attached file is no longer available: {name}")
    return path


def attachment_thread_dir(data_dir: Path, thread_id: str) -> Path:
    return data_dir / "chat-attachments" / _safe_identifier(thread_id, "thread")


def transcribe_chat_audio(
    payload: dict[str, Any],
    *,
    data_dir: Path,
) -> dict[str, str]:
    try:
        audio = base64.b64decode(str(payload.get("data") or ""), validate=True)
    except (ValueError, TypeError) as exc:
        raise ChatMediaError("The recording could not be decoded.") from exc
    if not audio:
        raise ChatMediaError("The recording is empty.")
    if len(audio) > CHAT_AUDIO_MAX_BYTES:
        raise ChatMediaError("The recording is larger than 25 MB.")
    try:
        text = _transcribe_wav_locally(audio, data_dir)
    except ChatMediaError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ChatMediaError(f"Local transcription failed: {exc}") from exc
    if not text:
        raise ChatMediaError(
            "No speech was detected. Test the microphone in Settings > Devices, "
            "then speak closer to the selected input."
        )
    return {"text": text}


def start_chat_transcription(*, data_dir: Path) -> dict[str, str]:
    session = _TranscriptionSession(recognizer=_new_vosk_recognizer(data_dir))
    session_id = uuid.uuid4().hex
    with _transcription_sessions_lock:
        _prune_transcription_sessions()
        if len(_transcription_sessions) >= CHAT_TRANSCRIPTION_MAX_SESSIONS:
            oldest_id = min(
                _transcription_sessions,
                key=lambda key: _transcription_sessions[key].updated_at,
            )
            _transcription_sessions.pop(oldest_id, None)
        _transcription_sessions[session_id] = session
    return {"sessionId": session_id}


def stream_chat_transcription(payload: dict[str, Any]) -> dict[str, str]:
    session = _get_transcription_session(payload)
    pcm = _decode_audio_payload(payload, maximum=CHAT_AUDIO_CHUNK_MAX_BYTES)
    if len(pcm) % 2:
        raise ChatMediaError("The transcription audio chunk is not valid 16-bit PCM.")
    with session.lock:
        if session.recognizer.AcceptWaveform(pcm):
            text = _vosk_result_text(session.recognizer.Result())
            if text:
                session.committed.append(text)
            partial = ""
        else:
            partial = _vosk_partial_text(session.recognizer.PartialResult())
        session.updated_at = time.monotonic()
        return {"text": _combined_transcription(session.committed, partial)}


def finish_chat_transcription(payload: dict[str, Any]) -> dict[str, str]:
    session_id = _transcription_session_id(payload)
    with _transcription_sessions_lock:
        session = _transcription_sessions.pop(session_id, None)
    if session is None:
        raise ChatMediaError("The transcription session expired. Start recording again.")
    with session.lock:
        final = _vosk_result_text(session.recognizer.FinalResult())
        if final:
            session.committed.append(final)
        text = _combined_transcription(session.committed)
    if not text:
        raise ChatMediaError(
            "No speech was detected. Test the microphone in Settings > Devices, "
            "then speak closer to the selected input."
        )
    return {"text": text}


def cancel_chat_transcription(payload: dict[str, Any]) -> dict[str, bool]:
    session_id = _transcription_session_id(payload)
    with _transcription_sessions_lock:
        removed = _transcription_sessions.pop(session_id, None) is not None
    return {"cancelled": removed}


def _transcribe_wav_locally(audio: bytes, data_dir: Path) -> str:
    try:
        with wave.open(io.BytesIO(audio), "rb") as source:
            if source.getnchannels() != 1 or source.getsampwidth() != 2:
                raise ChatMediaError("The recording must be mono 16-bit PCM audio.")
            if source.getframerate() != 16_000 or source.getcomptype() != "NONE":
                raise ChatMediaError("The recording must be uncompressed 16 kHz audio.")
            pcm = source.readframes(source.getnframes())
    except (EOFError, wave.Error) as exc:
        raise ChatMediaError("The recording is not a valid WAV file.") from exc

    recognizer = _new_vosk_recognizer(data_dir)
    parts: list[str] = []
    for offset in range(0, len(pcm), 8_000):
        if recognizer.AcceptWaveform(pcm[offset : offset + 8_000]):
            parts.append(_vosk_result_text(recognizer.Result()))
    parts.append(_vosk_result_text(recognizer.FinalResult()))
    return " ".join(part for part in parts if part).strip()


def _new_vosk_recognizer(data_dir: Path) -> Any:
    try:
        from vosk import KaldiRecognizer, SetLogLevel
    except ImportError as exc:
        raise ChatMediaError(
            "Local transcription support is not installed. Reinstall Taskurotta with Vosk support."
        ) from exc
    SetLogLevel(-1)
    return KaldiRecognizer(_load_vosk_model(data_dir), 16_000)


def _load_vosk_model(data_dir: Path) -> Any:
    global _vosk_model, _vosk_model_path
    model_path = data_dir / "speech-models" / VOSK_MODEL_NAME
    with _vosk_model_lock:
        if _vosk_model is not None and _vosk_model_path == model_path:
            return _vosk_model
        _ensure_vosk_model(model_path)
        try:
            from vosk import Model
        except ImportError as exc:
            raise ChatMediaError(
                "Local transcription support is not installed. "
                "Reinstall Taskurotta with Vosk support."
            ) from exc
        _vosk_model = Model(str(model_path))
        _vosk_model_path = model_path
        return _vosk_model


def _ensure_vosk_model(model_path: Path) -> None:
    if (model_path / "am" / "final.mdl").is_file():
        return
    model_root = model_path.parent
    model_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive_path = model_root / f"{VOSK_MODEL_NAME}.zip.part"
    try:
        request = Request(VOSK_MODEL_URL, headers={"User-Agent": "Taskurotta local speech/1"})
        with urlopen(request, timeout=60) as response, archive_path.open("wb") as target:
            _copy_limited(response, target, VOSK_MODEL_DOWNLOAD_MAX_BYTES)
        with zipfile.ZipFile(archive_path) as archive:
            _safe_extract_zip(archive, model_root)
    except ChatMediaError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ChatMediaError(
            "The local speech model could not be installed. Check the connection and try again."
        ) from exc
    finally:
        archive_path.unlink(missing_ok=True)
    if not (model_path / "am" / "final.mdl").is_file():
        shutil.rmtree(model_path, ignore_errors=True)
        raise ChatMediaError("The downloaded local speech model is incomplete.")


def _copy_limited(source: Any, target: Any, limit: int) -> None:
    total = 0
    while chunk := source.read(1024 * 1024):
        total += len(chunk)
        if total > limit:
            limit_mib = limit // (1024 * 1024)
            raise ChatMediaError(
                f"The local speech model download exceeded {limit_mib} MiB."
            )
        target.write(chunk)


def _safe_extract_zip(archive: zipfile.ZipFile, target: Path) -> None:
    target_root = target.resolve()
    for member in archive.infolist():
        destination = (target / member.filename).resolve()
        if destination != target_root and not destination.is_relative_to(target_root):
            raise ChatMediaError("The local speech model archive contains an unsafe path.")
    archive.extractall(target)


def _vosk_result_text(value: str) -> str:
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return ""
    return str(payload.get("text") or "").strip() if isinstance(payload, dict) else ""


def _vosk_partial_text(value: str) -> str:
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return ""
    return str(payload.get("partial") or "").strip() if isinstance(payload, dict) else ""


def _decode_audio_payload(payload: dict[str, Any], *, maximum: int) -> bytes:
    try:
        audio = base64.b64decode(str(payload.get("data") or ""), validate=True)
    except (ValueError, TypeError) as exc:
        raise ChatMediaError("The recording could not be decoded.") from exc
    if not audio:
        raise ChatMediaError("The recording is empty.")
    if len(audio) > maximum:
        raise ChatMediaError("The transcription audio chunk is too large.")
    return audio


def _transcription_session_id(payload: dict[str, Any]) -> str:
    session_id = str(payload.get("sessionId") or "")
    if not re.fullmatch(r"[0-9a-f]{32}", session_id):
        raise ChatMediaError("A valid transcription session is required.")
    return session_id


def _get_transcription_session(payload: dict[str, Any]) -> _TranscriptionSession:
    session_id = _transcription_session_id(payload)
    with _transcription_sessions_lock:
        _prune_transcription_sessions()
        session = _transcription_sessions.get(session_id)
    if session is None:
        raise ChatMediaError("The transcription session expired. Start recording again.")
    return session


def _prune_transcription_sessions() -> None:
    cutoff = time.monotonic() - CHAT_TRANSCRIPTION_SESSION_TTL_SECONDS
    expired = [
        session_id
        for session_id, session in _transcription_sessions.items()
        if session.updated_at < cutoff
    ]
    for session_id in expired:
        _transcription_sessions.pop(session_id, None)


def _combined_transcription(committed: list[str], partial: str = "") -> str:
    return " ".join(part for part in [*committed, partial] if part).strip()


def _safe_identifier(value: Any, label: str) -> str:
    result = _SAFE_PART.sub("_", str(value or "")).strip("._")[:160]
    if not result:
        raise ChatMediaError(f"A {label} id is required.")
    return result


def _safe_filename(value: Any) -> str:
    name = Path(str(value or "attachment").replace("\\", "/")).name
    name = _SAFE_PART.sub("_", name).strip(".")[:200]
    return name or "attachment"


def _safe_media_type(value: Any) -> str:
    media_type = str(value or "application/octet-stream").lower()
    if not re.fullmatch(r"[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+", media_type):
        return "application/octet-stream"
    return media_type[:255]
