using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Windows.Data.Xml.Dom;
using Windows.Foundation;
using Windows.UI.Notifications;

namespace DshToastQuestion;

static class Program
{
    // ---------------------------------------------------------------------
    // Data models (wire-compatible with ask_user_question arguments)
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

    sealed class AnswerPayload
    {
        public string SessionId { get; set; } = "";
        public List<AnswerItem> Answers { get; set; } = new();
    }

    const string Aumid = "DeepSeekHarness";

    static string GetArg(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        }
        return "";
    }

    static List<QuestionData>? ParseQuestions(string base64)
    {
        if (string.IsNullOrEmpty(base64)) return null;
        try
        {
            string json = Encoding.UTF8.GetString(Convert.FromBase64String(base64));
            return JsonSerializer.Deserialize<List<QuestionData>>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });
        }
        catch
        {
            return null;
        }
    }

    static string XmlEscape(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");

    [STAThread]
    static async Task<int> Main(string[] args)
    {
        string session = GetArg(args, "--session");
        string title = GetArg(args, "--title");
        string body = GetArg(args, "--body");
        string questionsB64 = GetArg(args, "--questions");

        var questions = ParseQuestions(questionsB64);
        if (questions == null || questions.Count == 0)
        {
            await Task.Delay(300);
            return 2;
        }

        var answers = new List<AnswerItem>();
        int current = 0;
        var done = new TaskCompletionSource<bool>();

        async void Handler(ToastNotification sender, object args)
        {
            try
            {
                var e = args as ToastActivatedEventArgs;
                if (e == null) return;

                if (string.Equals(e.Arguments, "cancel", StringComparison.OrdinalIgnoreCase))
                {
                    bool ok = await SubmitCancelAsync(session);
                    done.TrySetResult(ok);
                    return;
                }

                var q = questions[current];
                string custom = "";

                if (e.UserInput.ContainsKey("custom"))
                {
                    custom = e.UserInput["custom"]?.ToString() ?? "";
                }

                if (q.IsMultiSelect)
                {
                    // Multi-select: user types numbers like "1,2" into the input.
                    var selected = new List<string>();
                    if (!string.IsNullOrWhiteSpace(custom) && q.Options != null)
                    {
                        foreach (var part in custom.Split(new[] { ',', '，', ' ', ';', '；' }, StringSplitOptions.RemoveEmptyEntries))
                        {
                            if (int.TryParse(part.Trim(), out int idx) && idx >= 1 && idx <= q.Options.Count)
                            {
                                string label = q.Options[idx - 1].Label;
                                if (!selected.Contains(label)) selected.Add(label);
                            }
                        }
                    }
                    if (selected.Count == 0 && string.IsNullOrWhiteSpace(custom)) return; // no answer
                    answers.Add(new AnswerItem
                    {
                        Id = q.Id ?? "",
                        Selected = selected,
                        Custom = selected.Count == 0 && !string.IsNullOrWhiteSpace(custom) ? custom.Trim() : null
                    });
                }
                else
                {
                    // Single-select: a numeric input selects the matching
                    // option; any other non-empty text is a custom answer.
                    string trimmed = custom.Trim();
                    if (trimmed.Length == 0) return; // no answer

                    if (int.TryParse(trimmed, out int idx) &&
                        q.Options != null && idx >= 1 && idx <= q.Options.Count)
                    {
                        answers.Add(new AnswerItem
                        {
                            Id = q.Id ?? "",
                            Selected = new List<string> { q.Options[idx - 1].Label },
                            Custom = null
                        });
                    }
                    else
                    {
                        answers.Add(new AnswerItem
                        {
                            Id = q.Id ?? "",
                            Selected = new List<string>(),
                            Custom = trimmed
                        });
                    }
                }

                current++;
                if (current < questions.Count)
                {
                    ShowQuestion(questions[current], title, body, Handler);
                }
                else
                {
                    bool ok = await SubmitAsync(session, answers);
                    done.TrySetResult(ok);
                }
            }
            catch
            {
                done.TrySetResult(false);
            }
        }

        ShowQuestion(questions[0], title, body, Handler);

        // Keep the process alive until all questions are answered or 5 minutes
        // pass (the host also enforces a 5-minute grace period).
        await Task.WhenAny(done.Task, Task.Delay(TimeSpan.FromMinutes(5)));
        return 0;
    }

    static void ShowQuestion(QuestionData q, string fallbackTitle, string fallbackBody, TypedEventHandler<ToastNotification, object> handler)
    {
        string toastTitle = string.IsNullOrEmpty(q.Header) ? fallbackTitle : q.Header!;
        string questionText = string.IsNullOrEmpty(q.Question) ? fallbackBody : q.Question!;
        var options = q.Options ?? new List<OptionData>();

        var sb = new StringBuilder();
        // Default toast scenario: it auto-closes after the normal toast
        // lifetime when the user is not interacting. We deliberately avoid a
        // selection dropdown here: its popup is a separate window and makes
        // the toast collapse while the pointer is over the dropdown list.
        // Options are shown as a numbered list and answered through the text
        // input, which stays inside the toast and does not steal focus.
        sb.Append("<toast useButtonStyle=\"true\"><visual><binding template=\"ToastGeneric\"><text>")
          .Append(XmlEscape(toastTitle))
          .Append("</text><text>")
          .Append(XmlEscape(questionText));

        if (!string.IsNullOrEmpty(q.Detail))
        {
            sb.Append("\n").Append(XmlEscape(q.Detail));
        }

        if (options.Count > 0)
        {
            // Show all options as a numbered list in the toast body. The user
            // types the number (or a custom answer) into the text input below,
            // so no dropdown popup is needed.
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
            sb.Append("\n\n可多选：请在输入框输入多个序号，如 1,2");
        }
        else
        {
            sb.Append("\n\n单选：请输入序号，或直接输入自定义答案");
        }



        // Both single-select and multi-select use a plain text input. This
        // avoids the native selection dropdown entirely, so the toast never
        // collapses while the user is reading/typing an answer.
        sb.Append("<input id=\"custom\" type=\"text\" placeHolderContent=\"");
        sb.Append(q.IsMultiSelect ? "输入序号，如 1,2" : "输入序号或自定义答案，如 1");
        sb.Append("\"/>");
        sb.Append("<action content=\"取消\" arguments=\"cancel\" activationType=\"foreground\"/>");
        sb.Append("<action content=\"Send\" arguments=\"send\" activationType=\"foreground\" hint-buttonStyle=\"Success\"/>");

        sb.Append("</actions></toast>");

        var doc = new XmlDocument();
        doc.LoadXml(sb.ToString());
        var toast = new ToastNotification(doc);
        toast.Tag = "dsh-q-" + Guid.NewGuid().ToString("N");
        toast.Activated += handler;
        // If the user ignores the question toast and Windows dismisses it by
        // timeout, fall back to a taskbar flash so the pending question is not
        // missed. Manual dismissal (user closed it) does not flash.
        toast.Dismissed += (s, e) =>
        {
            if (e.Reason == ToastDismissalReason.TimedOut)
            {
                FlashTaskbar();
            }
        };
        ToastNotificationManager.CreateToastNotifier(Aumid).Show(toast);
    }

    // ---------------------------------------------------------------------
    // Taskbar flash fallback for ignored question toasts. Mirrors the
    // FLASHW_TRAY behaviour used by notify.ps1 (stable across virtual
    // desktops) and only flashes the DSH PWA taskbar button.
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
                dwFlags = 14, // FLASHW_TRAY(2) | FLASHW_TIMERNOFG(12)
                uCount = 0,
                dwTimeout = 0
            };
            FlashWindowEx(ref info);
        }
        catch
        {
            // Best-effort: flashing must never break the toast flow.
        }
    }

    static async Task<bool> SubmitAsync(string session, List<AnswerItem> answers)
    {
        try
        {
            var payload = new AnswerPayload { SessionId = session, Answers = answers };
            string json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
            });
            using var http = new HttpClient();
            http.Timeout = TimeSpan.FromSeconds(5);
            using var content = new StringContent(json, Encoding.UTF8, "application/json");
            using var resp = await http.PostAsync("http://127.0.0.1:3080/dsh-notify/answer", content);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    static async Task<bool> SubmitCancelAsync(string session)
    {
        try
        {
            string json = JsonSerializer.Serialize(new { sessionId = session, cancel = true });
            using var http = new HttpClient();
            http.Timeout = TimeSpan.FromSeconds(5);
            using var content = new StringContent(json, Encoding.UTF8, "application/json");
            using var resp = await http.PostAsync("http://127.0.0.1:3080/dsh-notify/answer", content);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }
}
