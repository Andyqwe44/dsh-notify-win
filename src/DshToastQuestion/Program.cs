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

                if (string.Equals(e.Arguments, "cancel", StringComparison.OrdinalIgnoreCase))
                {
                    bool ok = await SubmitCancelAsync(session);
                    done.TrySetResult(ok);
                    return;
                }

                var q = questions[current];
                string selectedLabel = "";
                string custom = "";

                if (e.UserInput.ContainsKey("select"))
                {
                    string selectedId = e.UserInput["select"]?.ToString() ?? "";
                    if (int.TryParse(selectedId, out int idx) &&
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
                    // Custom text overrides the dropdown selection.
                    if (!string.IsNullOrWhiteSpace(custom))
                    {
                        answers.Add(new AnswerItem
                        {
                            Id = q.Id ?? "",
                            Selected = new List<string>(),
                            Custom = custom.Trim()
                        });
                    }
                    else
                    {
                        if (selectedLabel.Length == 0) return; // no answer
                        answers.Add(new AnswerItem
                        {
                            Id = q.Id ?? "",
                            Selected = new List<string> { selectedLabel },
                            Custom = null
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
        sb.Append("<toast useButtonStyle=\"true\"><visual><binding template=\"ToastGeneric\"><text>")
          .Append(XmlEscape(toastTitle))
          .Append("</text><text>")
          .Append(XmlEscape(questionText));

        if (!string.IsNullOrEmpty(q.Detail))
        {
            sb.Append("\n").Append(XmlEscape(q.Detail));
        }

        if (q.IsMultiSelect && options.Count > 0)
        {
            // Multi-select still needs a numbered list because the user types
            // numbers into the input. Single-select options live in the dropdown.
            sb.Append("\n");
            for (int i = 0; i < options.Count; i++)
            {
                string label = options[i].Label;
                sb.Append("\n").Append(i + 1).Append(". ").Append(XmlEscape(label));
            }
        }

        if (q.IsMultiSelect)
        {
            sb.Append("\n\n可多选：请在输入框输入多个序号，如 1,2");
        }

        sb.Append("</text></binding></visual><actions>");

        if (q.IsMultiSelect)
        {
            // Multi-select: user types numbers like "1,2" into the input.
            sb.Append("<input id=\"custom\" type=\"text\" placeHolderContent=\"输入序号，如 1,2\"/>");
            sb.Append("<action content=\"取消\" arguments=\"cancel\" activationType=\"foreground\"/>");
            sb.Append("<action content=\"Send\" arguments=\"send\" activationType=\"foreground\" hint-buttonStyle=\"Success\"/>");
        }
        else
        {
            // Single-select: use a compact dropdown so many/long option labels
            // do not crowd the button row. A text input is always available for
            // a custom answer; if it is filled, it overrides the dropdown.
            int maxOptions = Math.Min(options.Count, 5);
            sb.Append("<input id=\"select\" type=\"selection\" title=\"请选择一项\">");
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
            // Add an explicit way to switch to the custom input without
            // submitting. Only when the 5-item selection limit allows it.
            if (options.Count < 5)
            {
                sb.Append("<selection id=\"__custom__\" content=\"自定义答案\"/>");
            }
            sb.Append("</input>");
            sb.Append("<input id=\"custom\" type=\"text\" placeHolderContent=\"自定义答案（可选）\"/>");
            sb.Append("<action content=\"取消\" arguments=\"cancel\" activationType=\"foreground\"/>");
            sb.Append("<action content=\"Send\" arguments=\"send\" activationType=\"foreground\" hint-buttonStyle=\"Success\"/>");
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
