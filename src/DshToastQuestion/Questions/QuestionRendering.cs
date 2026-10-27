namespace DshToastQuestion;

static partial class Program
{
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

        // A new page (or a different question) replaces the toast that may have
        // armed the flash, so clear the old attention state before showing it.
        StopTaskbarFlash();

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
            // A fixed-choice question (an approval) has no free-text override.
            if (!q.NoCustom)
            {
                sb.Append("<input id=\"custom\" type=\"text\" placeHolderContent=\"自定义答案（可选，填了会覆盖选择）\"");
                if (draft.Custom.Length > 0)
                {
                    sb.Append(" defaultInput=\"").Append(XmlEscape(draft.Custom)).Append('"');
                }
                sb.Append("/>");
            }
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
            string toastTag = flow.QuestionTag;
            toast.Activated += (sender, eventArgs) => OnActivated(flow, page, eventArgs);
            // If the user ignores the question toast and Windows dismisses it
            // by timeout, ask the shell to flash the DSH taskbar button. The
            // flash uses FLASHW_TIMERNOFG, so Windows stops it when DSH comes
            // to the foreground; there is no re-pulse timer. Manual dismissal
            // does not flash, and a toast replaced by the next page (or one
            // whose question was already resolved) stays silent.
            toast.Dismissed += (sender, eventArgs) =>
            {
                if (eventArgs.Reason != ToastDismissalReason.TimedOut) return;
                bool live;
                lock (FlowsLock)
                {
                    live = Flows.ContainsKey(flow.Id) &&
                        !flow.Submitted &&
                        string.Equals(flow.QuestionTag, toastTag, StringComparison.Ordinal);
                }
                if (live) FlashTaskbar();
            };
            if (!ShowToast(toast)) Log("question toast failed");
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
}
