// Window event that opens the voice-answer window of the mock interview
// (dispatched by InterviewWorkspace when the question audio ends).
export const INTERVIEW_ANSWER_WINDOW_EVENT = "tnp:interview-answer-window";

/** Fallback when the server does not acknowledge `interview:audio:start` with `answerSeconds`. */
export const DEFAULT_ANSWER_SECONDS = 60;
