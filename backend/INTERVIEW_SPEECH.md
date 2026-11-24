# Local interview speech setup

The mock-interview voice path runs locally and does not use a paid speech API:

`browser PCM -> Socket.IO -> Node/sherpa-onnx STT -> Python interview agent -> Node/Kokoro TTS -> browser WAV`

Install the speech models once from the Node backend directory:

```powershell
npm install
npm run setup:interview-speech
```

The downloaded model files live under `models/` and are intentionally ignored by Git. Start Node only after the setup command completes.

Optional environment settings:

```dotenv
INTERVIEW_ASR_MODEL_DIR=models/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06
INTERVIEW_TTS_MODEL_DIR=models/kokoro-en-v0_19
INTERVIEW_TTS_SPEAKER_ID=6
INTERVIEW_SPEECH_THREADS=2
INTERVIEW_ANSWER_SECONDS=60
INTERVIEW_SILENCE_SECONDS=4
INTERVIEW_SPEECH_RMS_THRESHOLD=0.012
```

Socket events are scoped to the interview agent:

- Client sends `interview:audio:start`, binary `interview:audio:chunk`, and `interview:audio:end`.
- Node sends partial/final `interview:transcript` events.
- Node automatically ends an answer after four seconds without detected speech; 60 seconds remains the hard maximum.
- The final transcript is forwarded internally to the existing `ai-interviewer` query handler.
- Node sends `interview:audio:response` with WAV bytes after an interview-agent text response.
- Audio is processed in memory and is not persisted.
