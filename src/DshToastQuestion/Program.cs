using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
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

                var q = questions[current];
                string selectedLabel = "";
                string custom = "";

                if (e.Arguments != null && e.Arguments.StartsWith("select:", StringComparison.OrdinalIgnoreCase))
                {
                    if (int.TryParse(e.Arguments.Substring("select:".Length), out int idx) &&
                        q.Options != null && idx >= 1 && idx <= q.Options.Count)
                    {
                        selectedLabel = q.Options[idx - 1].Label;
                    }
                }

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
                    if (selectedLabel.Length == 0 && string.IsNullOrWhiteSpace(custom)) return; // no answer
                    answers.Add(new AnswerItem
                    {
                        Id = q.Id ?? "",
                        Selected = selectedLabel.Length > 0 ? new List<string> { selectedLabel } : new List<string>(),
                        Custom = string.IsNullOrWhiteSpace(custom) ? null : custom.Trim()
                    });
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
        sb.Append("<toast><visual><binding template=\"ToastGeneric\"><text>")
          .Append(XmlEscape(toastTitle))
          .Append("</text><text>")
          .Append(XmlEscape(questionText));

        if (!string.IsNullOrEmpty(q.Detail))
        {
            sb.Append("\n").Append(XmlEscape(q.Detail));
        }

        if (options.Count > 0)
        {
            sb.Append("\n");
            for (int i = 0; i < options.Count; i++)
            {
                string label = options[i].Label;
                string desc = options[i].Description ?? "";
                string line = desc.Length > 0 ? $"{i + 1}. {label} - {desc}" : $"{i + 1}. {label}";
                sb.Append("\n").Append(XmlEscape(line));
            }
        }

        if (q.IsMultiSelect)
        {
            sb.Append("\n\n可多选：请在输入框输入多个序号，如 1,2");
        }

        sb.Append("</text></binding></visual><actions>");
        sb.Append("<input id=\"custom\" type=\"text\" placeHolderContent=\"")
          .Append(q.IsMultiSelect ? "输入序号，如 1,2" : "自定义答案（可选）")
          .Append("\"/>");

        if (q.IsMultiSelect)
        {
            // Multi-select: only Send; user types numbers into the input.
            sb.Append("<action content=\"Send\" arguments=\"send\" activationType=\"foreground\"/>");
        }
        else
        {
            int maxButtons = Math.Min(options.Count, 5);
            for (int i = 0; i < maxButtons; i++)
            {
                sb.Append("<action content=\"")
                  .Append(i + 1)
                  .Append("\" arguments=\"select:")
                  .Append(i + 1)
                  .Append("\" activationType=\"foreground\"/>");
            }
            // Keep one slot for Send when there is room (<=4 options).
            if (options.Count < 5)
            {
                sb.Append("<action content=\"Send\" arguments=\"send\" activationType=\"foreground\"/>");
            }
        }

        sb.Append("</actions></toast>");

        var doc = new XmlDocument();
        doc.LoadXml(sb.ToString());
        var toast = new ToastNotification(doc);
        toast.Tag = "dsh-q-" + Guid.NewGuid().ToString("N");
        toast.Activated += handler;
        ToastNotificationManager.CreateToastNotifier(Aumid).Show(toast);
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
}
