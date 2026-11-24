import { useLayoutEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, BriefcaseBusiness, MessageSquare, Plus, Send, Sparkles, User, Zap } from "lucide-react";
import VoiceInterviewInput from "./VoiceInterviewInput.jsx";
import { useSocketConnected } from "../lib/realtime.js";
import { sendAIMessage, startNewAIChat } from "../services/aiRequestHandler.js";
import { selectAILoading, selectChatMessages, selectInterviewWorkspace } from "../store/aiChatSlice.js";
import ConfirmationCard from "../workspace/ConfirmationCard.jsx";
import OpenedPanelChips from "../workspace/OpenedPanelChips.jsx";
import ToolCallList from "../workspace/ToolCallList.jsx";
import { chatPlaceholder, chatTitle } from "../workspace/chatCopy.js";
import { headerLabel } from "../workspace/headerLabels.js";

const markdownComponents = {
  a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
};
// GFM for autolinks, strikethrough and task lists; pipe tables are split out and rendered below.
const remarkPlugins = [remarkGfm];
const inlineComponents = { p: ({ children }) => <>{children}</> };

const parseTableRow = (line) => {
  const placeholder = "__ESCAPED_PIPE__";
  return line
    .trim()
    .replaceAll("\\|", placeholder)
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim().replaceAll(placeholder, "|"));
};

const isTableDivider = (line = "") => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());

function MarkdownWithTables({ text = "" }) {
  const lines = String(text).split("\n");
  const blocks = [];
  let markdownLines = [];

  const flushMarkdown = () => {
    if (!markdownLines.length) return;
    blocks.push({ type: "markdown", content: markdownLines.join("\n") });
    markdownLines = [];
  };

  for (let index = 0; index < lines.length; ) {
    if (lines[index].trim().startsWith("|") && isTableDivider(lines[index + 1])) {
      flushMarkdown();
      const headers = parseTableRow(lines[index]);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }
    markdownLines.push(lines[index]);
    index += 1;
  }
  flushMarkdown();

  return blocks.map((block, blockIndex) =>
    block.type === "markdown" ? (
      <ReactMarkdown key={`markdown-${blockIndex}`} components={markdownComponents} remarkPlugins={remarkPlugins}>
        {block.content}
      </ReactMarkdown>
    ) : (
      <div key={`table-${blockIndex}`} className="my-2 max-w-full overflow-x-auto">
        <table className="w-full border-collapse text-left text-[10px]">
          <thead className="bg-black text-white">
            <tr>
              {block.headers.map((header, index) => (
                <th key={`${header}-${index}`} className="border border-black p-1.5 font-black">
                  <ReactMarkdown components={inlineComponents}>{header}</ReactMarkdown>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`} className="bg-white even:bg-gray-50">
                {row.map((cell, cellIndex) => (
                  <td key={`cell-${cellIndex}`} className="border border-black p-1.5 align-top">
                    <ReactMarkdown components={inlineComponents}>{cell}</ReactMarkdown>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
  );
}

const lastIndexWhere = (items, predicate) => {
  for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index])) return index;
  return -1;
};

const MARKDOWN_CLASSES =
  "min-w-0 max-w-full break-words leading-relaxed [overflow-wrap:anywhere] [&_h1]:mb-2 [&_h1]:text-sm [&_h1]:font-black [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-black [&_h3]:mb-1 [&_h3]:font-black [&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:mb-1 [&_a]:font-bold [&_a]:underline [&_strong]:font-black [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-black [&_blockquote]:pl-2 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-hidden [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:font-mono [&_code]:text-[11px] [&_del]:opacity-70 [&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-[10px] [&_td]:border [&_td]:border-black [&_td]:p-1 [&_th]:border [&_th]:border-black [&_th]:bg-black [&_th]:p-1 [&_th]:text-white";

/** Left-hand copilot chat (FRONTEND.md §8.4). */
export default function Chat() {
  const dispatch = useDispatch();
  const messages = useSelector(selectChatMessages);
  const loading = useSelector(selectAILoading);
  const user = useSelector((state) => state.appContext.user);
  const role = useSelector((state) => state.appContext.userRole);
  const activeMode = useSelector((state) => state.appContext.activeMode);
  const activeFeature = useSelector((state) => state.appContext.activeFeature);
  const interviewWorkspace = useSelector(selectInterviewWorkspace);
  const connected = useSocketConnected();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef(null);

  const isVoiceTurn = activeMode === "student" && activeFeature === "mock-interview" && interviewWorkspace.status === "in-progress";
  const lastBotIndex = lastIndexWhere(messages, (message) => message.sender === "bot");
  const copy = { activeMode, activeFeature, role };

  useLayoutEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: loading ? "auto" : "smooth", block: "end" });
  }, [messages, loading]);

  const handleSend = (customPrompt, extra) => {
    const prompt = customPrompt ?? input;
    if (!String(prompt).trim() || loading) return;
    if (customPrompt === undefined) setInput("");
    dispatch(sendAIMessage({ text: prompt, ...(extra || {}) }));
  };

  const sendConfirmation = (answer) => handleSend(answer, { modeName: "copilot", source: "copilot-confirm" });

  return (
    <div className="card-stark flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
      <div className="mb-3 flex items-center justify-between gap-2 border-b-2 border-black pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare className="h-5 w-5 shrink-0" aria-hidden="true" />
          <h2 className="truncate text-sm font-black uppercase">{chatTitle(copy)}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 border border-black px-1.5 py-0.5 text-[9px] font-black uppercase ${connected ? "bg-green-100" : "bg-red-100"}`}
            title={connected ? "Connected to the assistant" : "Reconnecting to the assistant…"}
          >
            <span className={`h-1.5 w-1.5 ${connected ? "bg-green-600" : "bg-red-600"}`} aria-hidden="true" />
            {connected ? "LIVE" : "OFFLINE"}
          </span>
          <button
            type="button"
            onClick={() => dispatch(startNewAIChat(user?.name))}
            className="btn-secondary px-2 py-1 text-[10px]"
            title="Start a new chat"
            aria-label="Start a new chat"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden min-[400px]:inline">NEW CHAT</span>
          </button>
        </div>
      </div>

      <div className="mb-3 min-h-0 flex-1 space-y-3 overflow-y-auto border-2 border-black bg-gray-50 p-3" aria-live="polite">
        {messages.map((message, index) => {
          const isUser = message.sender === "user";
          const chip = isUser ? null : headerLabel(message.headerMessage);
          const showConfirm = !isUser && message.pending && index === lastBotIndex && !loading;
          const showOptions =
            !isUser && !message.pending && Array.isArray(message.options) && message.options.length > 0 && !loading && !isVoiceTurn;
          const working = !isUser && message.streaming && !message.text;
          return (
            <div key={message.id || index} className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
              <div className="mb-1 flex items-center gap-1">
                {isUser ? (
                  <>
                    <span className="text-[10px] font-extrabold uppercase">You</span>
                    <User className="h-3 w-3" aria-hidden="true" />
                  </>
                ) : (
                  <>
                    <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="text-[10px] font-extrabold uppercase">Copilot</span>
                  </>
                )}
              </div>

              <div
                className={`min-w-0 max-w-[85%] overflow-hidden border-2 border-black p-2.5 text-xs font-medium shadow-bold-sm ${isUser ? "bg-black text-white" : "bg-white text-black"} ${message.streaming && !working ? "animate-pulse" : ""}`}
              >
                {chip && (
                  <div
                    className={`mb-1.5 inline-flex items-center gap-1 border border-black px-1 py-0.5 text-[9px] font-black ${chip === "ERROR" ? "bg-red-100" : chip === "COPILOT" ? "bg-purple-100" : "bg-yellow-100"}`}
                  >
                    <Zap className="h-3 w-3 fill-black" aria-hidden="true" />
                    {chip}
                  </div>
                )}
                {isUser ? (
                  <div className="min-w-0 max-w-full whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">{message.text}</div>
                ) : working ? (
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-gray-600">
                    <Sparkles className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Working on it…
                  </div>
                ) : (
                  <div className={MARKDOWN_CLASSES}>
                    <MarkdownWithTables text={message.text} />
                    {message.headerMessage === "select:job:db" && (
                      <div className="mt-2 flex items-center gap-1.5 border border-black bg-blue-50 p-2 text-[11px] font-semibold text-blue-950">
                        <BriefcaseBusiness className="h-3.5 w-3.5 shrink-0 text-blue-700" aria-hidden="true" />
                        <span>Choose from the campus drives in the workspace, or paste a custom job link.</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!isUser && <ToolCallList toolCalls={message.toolCalls} />}
              {!isUser && <OpenedPanelChips uiActions={message.uiActions} role={role} />}
              {showConfirm && (
                <ConfirmationCard
                  pending={message.pending}
                  createdAt={message.createdAt}
                  options={message.options}
                  disabled={loading}
                  onAnswer={sendConfirmation}
                />
              )}
              {showOptions && (
                <div className="mt-2 flex max-w-[85%] flex-wrap gap-1.5">
                  {message.options.map((option, optionIndex) => (
                    <button
                      key={`${option}-${optionIndex}`}
                      type="button"
                      onClick={() => handleSend(String(option))}
                      className="inline-flex min-h-9 cursor-pointer items-center gap-1 border-2 border-black bg-white px-2.5 py-1.5 text-[11px] font-bold text-black shadow-bold-sm transition-colors duration-150 hover:bg-black hover:text-white sm:min-h-0"
                    >
                      <Zap className="h-3 w-3 shrink-0" aria-hidden="true" />
                      {String(option)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {loading && (
          <div className="flex w-fit items-center gap-2 border-2 border-black bg-yellow-100 p-2 text-xs font-bold" role="status">
            <Sparkles className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>THINKING…</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {isVoiceTurn ? (
        <VoiceInterviewInput key={interviewWorkspace.questionNumber} questionNumber={interviewWorkspace.questionNumber} loading={loading} />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            handleSend();
          }}
          className="flex items-stretch gap-2"
        >
          <label htmlFor="chat-input" className="sr-only">
            Message the copilot
          </label>
          <input
            id="chat-input"
            type="text"
            autoComplete="off"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={chatPlaceholder(copy)}
            className="input-stark min-w-0 flex-1 text-base sm:text-xs"
          />
          <button type="submit" disabled={loading || !input.trim()} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">SEND</span>
          </button>
        </form>
      )}
    </div>
  );
}
