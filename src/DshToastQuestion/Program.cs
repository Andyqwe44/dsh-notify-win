using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace DshToastQuestion;

/// <summary>
/// Resident toast helper for dsh-notify-win.
///
/// The host plugin starts ONE of these when the plugin is applied and keeps it
/// alive for the whole plugin lifetime. They speak newline-delimited JSON over
/// the child's stdin/stdout:
///
///   host -> helper  { "op": "question" | "status" | "shutdown" | "ping", ... }
///   helper -> host  { "ev": "ready" | "answer" | "cancel" | "pong", ... }
///
/// Lifecycle follows the host by construction: when DSH exits (the service
/// terminates managed children, and the stdio pipes close) stdin reaches EOF
/// and this process exits. The plugin also sends an explicit "shutdown" when it
/// is disabled, so the helper disappears without leaving a stray process.
/// </summary>
static class Program
{
    // ---------------------------------------------------------------------
    // Wire models (compatible with ask_user_question arguments)
    // ---------------------------------------------------------------------
    sealed class OptionData
    {
        public string Label { get; set; } = "";
        public string? Description { get; set; }
    }

    sealed class QuestionData
    {
        public string? Id { get; set; }
        public string? Header { get; set; }
        public string? Question { get; set; }
        public string? Detail { get; set; }
        public List<OptionData>? Options { get; set; }

        [JsonPropertyName("multiSelect")]
        public bool MultiSelectCamel { get; set; }

        [JsonExtensionData]
        public Dictionary<string, JsonElement>? ExtensionData { get; set; }

        [JsonIgnore]
        public bool IsMultiSelect
        {
            get
            {
                if (MultiSelectCamel) return true;
                if (ExtensionData != null)
                {
                    if (ExtensionData.TryGetValue("multi_select", out var snake) &&
                        snake.ValueKind == JsonValueKind.True) return true;
                    if (ExtensionData.TryGetValue("multiSelect", out var camel) &&
                        camel.ValueKind == JsonValueKind.True) return true;
                }
                return false;
            }
        }
    }

    sealed class AnswerItem
    {
        public string Id { get; set; } = "";
        public List<string> Selected { get; set; } = new();
        public string? Custom { get; set; }
    }

    /// <summary>One inbound command. Unknown members are ignored on purpose.</summary>
    sealed class InboundMessage
    {
        public string? Op { get; set; }
        public string? Id { get; set; }
        public string? SessionId { get; set; }
        public string? Title { get; set; }
        public string? Body { get; set; }
        public List<QuestionData>? Questions { get; set; }
        public string? Duration { get; set; }
        public string? State { get; set; }
        public string? Detail { get; set; }
    }

    /// <summary>Draft of one page: the dropdown choice and/or the typed answer.</summary>
    sealed class PageDraft
    {
        /// <summary>1-based selection id; 0 means nothing picked.</summary>
        public int Selected;
        /// <summary>Custom text for single-select, or the numbers for multi-select.</summary>
        public string Custom = "";
    }

    /// <summary>One interactive question batch owned by the host.</summary>
    sealed class QuestionFlow
    {
        public string Id = "";
        public string Session = "";
        public string Title = "";
        public string Body = "";
        public string Duration = "short";
        public List<QuestionData> Questions = new();
        public PageDraft[] Drafts = Array.Empty<PageDraft>();
        public int Current;
        public int TagSeq;
        public int ShowSeq;
        public bool Submitted;
        /// <summary>One-shot message rendered on the next page (for example a validation hint).</summary>
        public string Hint = "";
        /// <summary>Tag of the toast currently on screen; a fresh tag per page gets a real show animation.</summary>
        public string QuestionTag = "";

        public bool MultiPage => Questions.Count > 1;
        public string StatusTag => "dsh-ans-" + TagSeq.ToString();
    }

    const string Aumid = "DeepSeekHarness";
    const string QuestionGroup = "dsh-notify-q";
    const string AnswerGroup = "dsh-notify-a";

    static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    static readonly object WriteLock = new();
    static readonly object FlowsLock = new();
    static readonly Dictionary<string, QuestionFlow> Flows = new();
    static readonly HashSet<string> LiveToasts = new();
    static readonly Queue<string> TrackOrder = new();

    static StreamWriter? _out;
    static string? _logPath;
    static volatile bool _stopping;
    static int _tagSeq;

    // Taskbar flash control. When a question toast times out we start a slow
    // re-pulse (every ~3 s) so the DSH taskbar button stays gently highlighted
    // without the rapid continuous blinking that FLASHW_TIMERNOFG would cause.
    // _flashGeneration invalidates stale timers when the user moves on to the
    // next question; _flashEnabled is set false when the user responds.
    static volatile bool _flashEnabled;
    static int _flashGeneration;

    static string GetArg(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        }
        return "";
    }

    static bool HasFlag(string[] args, string name)
    {
        foreach (var arg in args)
        {
            if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    [STAThread]
    static async Task<int> Main(string[] args)
    {
        // Quick liveness probe: exit 0 if the .NET Desktop Runtime can load
        // this assembly. The host plugin uses it to decide whether to spawn
        // the interactive helper or fall back to a plain PowerShell toast.
        if (string.Equals(GetArg(args, "--check"), "1", StringComparison.OrdinalIgnoreCase))
        {
            return 0;
        }

        if (!HasFlag(args, "--serve"))
        {
            // No supported mode: fail fast instead of waiting on a stdin that
            // nobody owns (an older host may still pass the one-shot flags).
            await Task.Delay(200);
            return 2;
        }

        _logPath = GetArg(args, "--log");

        // Tag names only need to be unique within one Windows toast source.
        // Seeding from the pid keeps two helper instances (a hot-reload overlap)
        // from replacing each other's question toast.
        _tagSeq = Environment.ProcessId % 100000 * 10;

        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))
        {
            AutoFlush = true,
        };
        _out = stdout;

        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

        Send(new Dictionary<string, object?>
        {
            ["ev"] = "ready",
            ["pid"] = Environment.ProcessId,
        });
        Log("helper ready");

        try
        {
            string? line;
            while (!_stopping && (line = await stdin.ReadLineAsync()) != null)
            {
                if (line.Length == 0) continue;
                try
                {
                    Handle(line);
                }
                catch (Exception error)
                {
                    Log("command failed: " + error.Message);
                }
            }
        }
        catch (Exception error)
        {
            Log("stdin failed: " + error.Message);
        }

        // The host is gone (EOF) or asked us to stop: clear the interactive
        // toasts so a stale question cannot be clicked after its agent died.
        CleanupToasts();
        Log("helper exit");
        return 0;
    }

    static void Handle(string line)
    {
        var message = JsonSerializer.Deserialize<InboundMessage>(line, JsonOptions);
        if (message?.Op == null) return;

        switch (message.Op)
        {
            case "question":
                StartFlow(message);
                break;
            case "status":
                ApplyStatus(message);
                break;
            case "shutdown":
                _stopping = true;
                break;
            case "ping":
                Send(new Dictionary<string, object?> { ["ev"] = "pong" });
                break;
            default:
                Log("unknown op: " + message.Op);
                break;
        }
    }

    static void StartFlow(InboundMessage message)
    {
        if (string.IsNullOrEmpty(message.Id)) return;
        var questions = message.Questions;
        if (questions == null || questions.Count == 0) return;

        var flow = new QuestionFlow
        {
            Id = message.Id!,
            Session = message.SessionId ?? "",
            Title = message.Title ?? "",
            Body = message.Body ?? "",
            Duration = message.Duration ?? "short",
            Questions = questions,
            Drafts = questions.Select(_ => new PageDraft()).ToArray(),
            TagSeq = Interlocked.Increment(ref _tagSeq),
        };

        lock (FlowsLock)
        {
            // Drop flows the host never confirmed long ago (a lost status must
            // not grow this table for the life of the process).
            foreach (var stale in Flows.Values.Where(item => item.TagSeq < flow.TagSeq - 64).ToArray())
            {
                Flows.Remove(stale.Id);
            }
            Flows[flow.Id] = flow;
        }

        ShowQuestion(flow);
        Log("question shown: " + flow.Id);
    }

    /// <summary>Retire one flow once its outcome is known.</summary>
    static void FinishFlow(QuestionFlow flow)
    {
        lock (FlowsLock) Flows.Remove(flow.Id);
    }

    // ---------------------------------------------------------------------
    // Question rendering
    // ---------------------------------------------------------------------
    /// <summary>Render one page of the flow, preserving every page's draft.</summary>
    static void ShowQuestion(QuestionFlow flow)
    {
        if (flow.Current < 0) flow.Current = 0;
        if (flow.Current >= flow.Questions.Count) flow.Current = flow.Questions.Count - 1;
        var page = flow.Current;
        var q = flow.Questions[page];
        var draft = flow.Drafts[page];
        var options = q.Options ?? new List<OptionData>();

        // Invalidate any flash timer from a previous question and stop it.
        Interlocked.Increment(ref _flashGeneration);
        _flashEnabled = false;

        var hint = flow.Hint;
        flow.Hint = "";

        var sb = new StringBuilder();
        // A multi-page flow needs time to page through, so it always uses the
        // long toast duration; a single question keeps the configured value.
        string durationAttr = flow.MultiPage || string.Equals(flow.Duration, "long", StringComparison.OrdinalIgnoreCase)
            ? "long"
            : "short";
        sb.Append("<toast duration=\"").Append(durationAttr).Append("\"><visual><binding template=\"ToastGeneric\">");

        if (flow.MultiPage)
        {
            sb.Append("<text>问题 ").Append(page + 1).Append('/').Append(flow.Questions.Count);
            if (!string.IsNullOrEmpty(q.Header))
            {
                sb.Append(" · ").Append(XmlEscape(q.Header!));
            }
            sb.Append("</text>");
        }
        else
        {
            string toastTitle = string.IsNullOrEmpty(q.Header) ? flow.Title : q.Header!;
            sb.Append("<text>").Append(XmlEscape(toastTitle)).Append("</text>");
        }

        string questionText = string.IsNullOrEmpty(q.Question) ? flow.Body : q.Question!;
        sb.Append("<text>").Append(XmlEscape(questionText));

        if (!string.IsNullOrEmpty(q.Detail))
        {
            sb.Append("\n").Append(XmlEscape(q.Detail));
        }

        if (q.IsMultiSelect && options.Count > 0)
        {
            // Multi-select still needs a numbered list because the user types
            // numbers into the input. Single-select uses the dropdown.
            sb.Append("\n");
            for (int i = 0; i < options.Count; i++)
            {
                string label = options[i].Label;
                string desc = options[i].Description ?? "";
                if (desc.Length > 0)
                {
                    sb.Append("\n").Append(i + 1).Append(". ").Append(XmlEscape(label)).Append(" - ").Append(XmlEscape(desc));
                }
                else
                {
                    sb.Append("\n").Append(i + 1).Append(". ").Append(XmlEscape(label));
                }
            }
        }

        if (q.IsMultiSelect)
        {
            sb.Append("\n\n可多选：在输入框输入多个序号，如 1,2");
        }

        sb.Append("</text>");

        if (hint.Length > 0)
        {
            sb.Append("<text>").Append(XmlEscape(hint)).Append("</text>");
        }

        if (flow.MultiPage)
        {
            sb.Append("<text>").Append(XmlEscape(AnsweredSummary(flow))).Append("</text>");
        }

        sb.Append("</binding></visual><actions>");

        if (!q.IsMultiSelect && options.Count > 0)
        {
            // Single-select: the native dropdown plus a free-text override.
            // defaultInput restores the previous choice when the user pages
            // back, which the native control otherwise cannot do.
            int maxOptions = Math.Min(options.Count, 5);
            sb.Append("<input id=\"select\" type=\"selection\" title=\"请选择一项\"");
            if (draft.Selected > 0)
            {
                sb.Append(" defaultInput=\"").Append(draft.Selected).Append('"');
            }
            sb.Append('>');
            for (int i = 0; i < maxOptions; i++)
            {
                string desc = options[i].Description ?? "";
                string content = desc.Length > 0 ? $"{options[i].Label} - {desc}" : options[i].Label;
                sb.Append("<selection id=\"")
                  .Append(i + 1)
                  .Append("\" content=\"")
                  .Append(XmlEscape(content))
                  .Append("\"/>");
            }
            sb.Append("</input>");
            sb.Append("<input id=\"custom\" type=\"text\" placeHolderContent=\"自定义答案（可选，填了会覆盖选择）\"");
            if (draft.Custom.Length > 0)
            {
                sb.Append(" defaultInput=\"").Append(XmlEscape(draft.Custom)).Append('"');
            }
            sb.Append("/>");
        }
        else
        {
            string placeholder = q.IsMultiSelect ? "输入序号，如 1,2" : "输入你的答案";
            sb.Append("<input id=\"custom\" type=\"text\" placeHolderContent=\"").Append(placeholder).Append('"');
            if (draft.Custom.Length > 0)
            {
                sb.Append(" defaultInput=\"").Append(XmlEscape(draft.Custom)).Append('"');
            }
            sb.Append("/>");
        }

        if (flow.MultiPage && page > 0)
        {
            sb.Append("<action content=\"上一题\" arguments=\"prev\" activationType=\"foreground\"/>");
        }
        if (flow.MultiPage && page < flow.Questions.Count - 1)
        {
            sb.Append("<action content=\"下一题\" arguments=\"next\" activationType=\"foreground\"/>");
        }
        else
        {
            sb.Append("<action content=\"提交\" arguments=\"submit\" activationType=\"foreground\"/>");
        }
        sb.Append("<action content=\"取消\" arguments=\"cancel\" activationType=\"foreground\"/>");
        sb.Append("</actions></toast>");

        try
        {
            var doc = new XmlDocument();
            doc.LoadXml(sb.ToString());
            flow.ShowSeq++;
            flow.QuestionTag = "dsh-q-" + flow.TagSeq.ToString() + "-" + flow.ShowSeq.ToString();
            var toast = new ToastNotification(doc)
            {
                Tag = flow.QuestionTag,
                Group = QuestionGroup,
            };
            Track(flow.QuestionTag);
            toast.Activated += (sender, eventArgs) => OnActivated(flow, page, eventArgs);
            // If the user ignores the question toast and Windows dismisses it
            // by timeout, fall back to a taskbar flash so the pending question
            // is not missed. Manual dismissal does not flash.
            int generation = _flashGeneration;
            toast.Dismissed += (sender, eventArgs) =>
            {
                if (eventArgs.Reason == ToastDismissalReason.TimedOut && generation == _flashGeneration)
                {
                    _flashEnabled = true;
                    FlashTaskbar();
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            while (_flashEnabled)
                            {
                                await Task.Delay(3000);
                                if (_flashEnabled) FlashTaskbar();
                            }
                        }
                        catch (OperationCanceledException) { }
                    });
                }
            };
            ToastNotificationManager.CreateToastNotifier(Aumid).Show(toast);
        }
        catch (Exception error)
        {
            Log("show failed: " + error.Message);
        }
    }

    static string AnsweredSummary(QuestionFlow flow)
    {
        var parts = new List<string>();
        for (int i = 0; i < flow.Questions.Count; i++)
        {
            var text = AnswerText(flow, i);
            if (text.Length == 0) continue;
            var question = flow.Questions[i];
            var label = string.IsNullOrEmpty(question.Header) ? "第" + (i + 1) + "题" : question.Header!;
            parts.Add(label + "=" + Shorten(text, 24));
        }
        return parts.Count == 0 ? "已答：尚无" : "已答：" + string.Join("；", parts);
    }

    static string AnswerText(QuestionFlow flow, int page)
    {
        var question = flow.Questions[page];
        var draft = flow.Drafts[page];
        var custom = draft.Custom.Trim();
        if (custom.Length > 0)
        {
            if (question.IsMultiSelect)
            {
                var labels = ParseMultiSelection(question, custom);
                if (labels.Count > 0) return string.Join("、", labels);
            }
            return custom;
        }
        if (!question.IsMultiSelect && draft.Selected > 0 && question.Options != null
            && draft.Selected <= question.Options.Count)
        {
            return question.Options[draft.Selected - 1].Label;
        }
        return "";
    }

    static List<string> ParseMultiSelection(QuestionData question, string raw)
    {
        var selected = new List<string>();
        if (question.Options == null) return selected;
        foreach (var part in raw.Split(new[] { ',', '，', ' ', ';', '；' }, StringSplitOptions.RemoveEmptyEntries))
        {
            if (int.TryParse(part.Trim(), out int idx) && idx >= 1 && idx <= question.Options.Count)
            {
                var label = question.Options[idx - 1].Label;
                if (!selected.Contains(label)) selected.Add(label);
            }
        }
        return selected;
    }

    static string Shorten(string text, int max) =>
        text.Length <= max ? text : text.Substring(0, max - 1).TrimEnd() + "…";

    static async void OnActivated(QuestionFlow flow, int page, object eventArgs)
    {
        try
        {
            var activated = eventArgs as ToastActivatedEventArgs;
            if (activated == null) return;

            // A click on the toast BODY carries no action arguments. Windows
            // dismisses the toast on that click, so re-open the same page; the
            // saved draft makes the previous choice reappear in the controls.
            if (string.IsNullOrEmpty(activated.Arguments))
            {
                await Task.Delay(700);
                flow.Current = page;
                ShowQuestion(flow);
                return;
            }

            SaveDraft(flow, page, activated);
            var action = activated.Arguments.ToLowerInvariant();

            if (action == "cancel")
            {
                _flashEnabled = false;
                Send(new Dictionary<string, object?>
                {
                    ["ev"] = "cancel",
                    ["id"] = flow.Id,
                    ["sessionId"] = flow.Session,
                });
                // Cancelling is honest: nothing was sent to the agent, and the
                // confirmation says exactly that.
                ShowStatus(flow, new[]
                {
                    "已取消",
                    "没有向 DSH 提交任何答案。",
                }, "short");
                RemoveToast(flow.QuestionTag, QuestionGroup);
                FinishFlow(flow);
                Log("cancelled: " + flow.Id);
                return;
            }

            if (action == "prev")
            {
                flow.Current = Math.Max(0, page - 1);
                ShowQuestion(flow);
                return;
            }

            if (action == "next")
            {
                flow.Current = Math.Min(flow.Questions.Count - 1, page + 1);
                ShowQuestion(flow);
                return;
            }

            if (action == "submit")
            {
                var missing = FirstUnanswered(flow);
                if (missing >= 0)
                {
                    // Jump to the first unanswered page and say why; the user
                    // keeps every other draft.
                    flow.Current = missing;
                    flow.Hint = "⚠ 第 " + (missing + 1) + " 题还没有回答";
                    ShowQuestion(flow);
                    return;
                }
                Submit(flow);
            }
        }
        catch (Exception error)
        {
            _flashEnabled = false;
            Log("activation failed: " + error.Message);
            ShowStatus(flow, new[]
            {
                "✗ 处理回答失败",
                "请在 DSH 窗口中重新作答。",
            }, "short");
        }
    }

    /// <summary>Fold the action's input values into the page's draft.</summary>
    static void SaveDraft(QuestionFlow flow, int page, ToastActivatedEventArgs activated)
    {
        var question = flow.Questions[page];
        var draft = flow.Drafts[page];
        if (activated.UserInput.ContainsKey("select"))
        {
            var raw = activated.UserInput["select"]?.ToString() ?? "";
            if (int.TryParse(raw, out int idx) && idx >= 1 && idx <= (question.Options?.Count ?? 0))
            {
                draft.Selected = idx;
            }
        }
        if (activated.UserInput.ContainsKey("custom"))
        {
            draft.Custom = activated.UserInput["custom"]?.ToString() ?? "";
        }
    }

    static int FirstUnanswered(QuestionFlow flow)
    {
        for (int i = 0; i < flow.Questions.Count; i++)
        {
            var draft = flow.Drafts[i];
            if (draft.Custom.Trim().Length > 0) continue;
            if (!flow.Questions[i].IsMultiSelect && draft.Selected > 0) continue;
            return i;
        }
        return -1;
    }

    /// <summary>
    /// Hand the batch to the host. The toast only says "submitted, waiting for
    /// DSH" here — the "delivered" claim is made by the host, once it has
    /// actually seen the answer reach the agent.
    /// </summary>
    static void Submit(QuestionFlow flow)
    {
        flow.Submitted = true;
        _flashEnabled = false;

        Send(new Dictionary<string, object?>
        {
            ["ev"] = "answer",
            ["id"] = flow.Id,
            ["sessionId"] = flow.Session,
            ["answers"] = BuildAnswers(flow)
                .Select(answer => new Dictionary<string, object?>
                {
                    ["id"] = answer.Id,
                    ["selected"] = answer.Selected,
                    ["custom"] = answer.Custom,
                })
                .ToList(),
        });

        ShowStatus(flow, new[] { "⏳ 已提交，等待 DSH 确认…" }, "short");
        RemoveToast(flow.QuestionTag, QuestionGroup);
        Log("answer submitted: " + flow.Id);
    }

    static List<AnswerItem> BuildAnswers(QuestionFlow flow)
    {
        var answers = new List<AnswerItem>();
        for (int i = 0; i < flow.Questions.Count; i++)
        {
            var question = flow.Questions[i];
            var draft = flow.Drafts[i];
            var custom = draft.Custom.Trim();
            if (question.IsMultiSelect)
            {
                var selected = ParseMultiSelection(question, custom);
                answers.Add(new AnswerItem
                {
                    Id = question.Id ?? "",
                    Selected = selected,
                    Custom = selected.Count == 0 && custom.Length > 0 ? custom : null,
                });
            }
            else if (custom.Length > 0)
            {
                answers.Add(new AnswerItem
                {
                    Id = question.Id ?? "",
                    Selected = new List<string>(),
                    Custom = custom,
                });
            }
            else
            {
                string label = draft.Selected > 0 && question.Options != null
                    && draft.Selected <= question.Options.Count
                    ? question.Options[draft.Selected - 1].Label
                    : "";
                answers.Add(new AnswerItem
                {
                    Id = question.Id ?? "",
                    Selected = new List<string> { label },
                    Custom = null,
                });
            }
        }
        return answers;
    }

    // ---------------------------------------------------------------------
    // Host status -> confirmation toast. Every state here is a fact the host
    // established; nothing is guessed by this process.
    // ---------------------------------------------------------------------
    static void ApplyStatus(InboundMessage message)
    {
        if (string.IsNullOrEmpty(message.Id)) return;
        QuestionFlow? flow;
        lock (FlowsLock) Flows.TryGetValue(message.Id!, out flow);
        if (flow == null) return;

        string? detail = message.Detail;
        switch (message.State)
        {
            case "pending":
                ShowStatus(flow, new[] { "⏳ 已提交，等待 DSH 确认…" }, "short");
                break;
            case "delivered":
                ShowStatus(flow, new[]
                {
                    "✓ 回答已送达 agent",
                    string.IsNullOrEmpty(detail) ? "agent 已收到你的选择。" : "你选择了：" + detail,
                }, "short");
                break;
            case "spoken":
                ShowStatus(flow, new[]
                {
                    "✓ agent 已收到并回应",
                    "“" + (detail ?? "") + "”",
                }, "long");
                FinishFlow(flow);
                break;
            case "nospeech":
                ShowStatus(flow, new[]
                {
                    "✓ 回答已送达 agent",
                    "本轮没有文本回复，可继续在 DSH 中查看。",
                }, "short");
                FinishFlow(flow);
                break;
            case "timeout":
                ShowStatus(flow, new[]
                {
                    "⚠ 未收到 DSH 确认",
                    "请打开 DSH 查看这个问题的状态。",
                }, "long");
                FinishFlow(flow);
                break;
            case "manual":
                // Not terminal: the card may still be answered by hand, and the
                // host's real delivery confirmation can replace this hint.
                ShowStatus(flow, new[]
                {
                    "⚠ 无法自动填入答案",
                    "请在 DSH 窗口中手动回答。",
                }, "long");
                break;
            case "stale":
                ShowStatus(flow, new[]
                {
                    "该问题已在 DSH 中处理",
                    "无需再回答。",
                }, "short");
                FinishFlow(flow);
                break;
            case "mismatch":
                ShowStatus(flow, new[]
                {
                    "⚠ agent 收到的是其它答案",
                    detail ?? "",
                }, "long");
                FinishFlow(flow);
                break;
            case "failed":
                ShowStatus(flow, new[]
                {
                    "✗ 未能送达 agent",
                    detail ?? "请回到 DSH 窗口处理。",
                }, "long");
                FinishFlow(flow);
                break;
            default:
                Log("unknown state: " + message.State);
                break;
        }
    }

    /// <summary>Show (or replace) the answer-receipt toast for one flow.</summary>
    static void ShowStatus(QuestionFlow flow, string[] lines, string duration)
    {
        try
        {
            string durationAttr = string.Equals(duration, "long", StringComparison.OrdinalIgnoreCase) ? "long" : "short";
            var sb = new StringBuilder();
            sb.Append("<toast duration=\"").Append(durationAttr).Append("\"><visual><binding template=\"ToastGeneric\">");
            foreach (var line in lines)
            {
                if (line.Length == 0) continue;
                sb.Append("<text>").Append(XmlEscape(line)).Append("</text>");
            }
            sb.Append("</binding></visual></toast>");

            var doc = new XmlDocument();
            doc.LoadXml(sb.ToString());
            var toast = new ToastNotification(doc)
            {
                Tag = flow.StatusTag,
                Group = AnswerGroup,
            };
            Track(flow.StatusTag);
            ToastNotificationManager.CreateToastNotifier(Aumid).Show(toast);
        }
        catch (Exception error)
        {
            Log("status toast failed: " + error.Message);
        }
    }

    static void RemoveToast(string tag, string group)
    {
        try
        {
            ToastNotificationManager.History.Remove(tag, group, Aumid);
        }
        catch { }
        lock (LiveToasts) LiveToasts.Remove(tag);
    }

    static void Track(string tag)
    {
        lock (LiveToasts)
        {
            if (!LiveToasts.Add(tag)) return;
            TrackOrder.Enqueue(tag);
            // Only the newest toasts need shutdown cleanup; older ones have
            // already expired. This keeps both structures bounded.
            while (TrackOrder.Count > 32)
            {
                LiveToasts.Remove(TrackOrder.Dequeue());
            }
        }
    }

    static void CleanupToasts()
    {
        string[] tags;
        lock (LiveToasts) tags = LiveToasts.ToArray();
        foreach (var tag in tags)
        {
            RemoveToast(tag, tag.StartsWith("dsh-q-", StringComparison.Ordinal) ? QuestionGroup : AnswerGroup);
        }
        lock (LiveToasts) LiveToasts.Clear();
    }

    static void Send(Dictionary<string, object?> payload)
    {
        try
        {
            string json = JsonSerializer.Serialize(payload, JsonOptions);
            lock (WriteLock)
            {
                if (_out == null) return;
                _out.WriteLine(json);
                _out.Flush();
            }
        }
        catch
        {
            // The host is gone: the stdin loop will observe EOF and exit.
        }
    }

    static void Log(string message)
    {
        if (string.IsNullOrEmpty(_logPath)) return;
        try
        {
            File.AppendAllText(_logPath!, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
        }
        catch { }
    }

    static string XmlEscape(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");

    // ---------------------------------------------------------------------
    // Taskbar flash fallback for ignored question toasts. Mirrors the
    // FLASHW_TRAY behaviour used by notify.ps1 (stable across virtual
    // desktops) and only flashes the DSH window.
    // ---------------------------------------------------------------------
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);

    [DllImport("user32.dll")]
    static extern bool FlashWindowEx(ref FLASHWINFO info);

    [StructLayout(LayoutKind.Sequential)]
    struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    static void FlashTaskbar()
    {
        try
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows((h, l) =>
            {
                if (!IsWindowVisible(h)) return true;
                var sb = new StringBuilder(512);
                GetWindowText(h, sb, sb.Capacity);
                string title = sb.ToString();
                if (title.Contains("— DeepSeek Harness", StringComparison.OrdinalIgnoreCase) ||
                    title.EndsWith("— DeepSeek Harness", StringComparison.OrdinalIgnoreCase))
                {
                    found = h;
                    return false;
                }
                return true;
            }, IntPtr.Zero);

            if (found == IntPtr.Zero) return;
            var info = new FLASHWINFO
            {
                cbSize = (uint)Marshal.SizeOf<FLASHWINFO>(),
                hwnd = found,
                dwFlags = 2,  // FLASHW_TRAY only — single warm pulse, not continuous blinking
                uCount = 1,
                dwTimeout = 0,
            };
            FlashWindowEx(ref info);
        }
        catch
        {
            // Best-effort: flashing must never break the toast flow.
        }
    }
}
