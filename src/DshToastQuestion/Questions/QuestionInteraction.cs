namespace DshToastQuestion;

static partial class Program
{
    static async void OnActivated(QuestionFlow flow, int page, object eventArgs)
    {
        try
        {
            // A toast that is already settled can still be clicked from Action
            // Center; it must not revive the question or restart its flash.
            if (flow.Submitted) return;
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
                flow.Submitted = true;
                StopTaskbarFlash();
                Send(new Dictionary<string, object?>
                {
                    ["ev"] = "cancel",
                    ["id"] = flow.Id,
                    ["sessionId"] = flow.Session,
                });
                // Cancelling is honest: nothing was sent to the agent, and the
                // confirmation says exactly that. For an approval request the
                // host hands the decision back to DSH's own approval panel, so
                // "已转到 DSH" is the accurate message.
                ShowStatus(flow, flow.Approval
                    ? new[] { "已转到 DSH", "请在 DSH 的审批面板中处理。" }
                    : new[] { "已取消", "没有向 DSH 提交任何答案。" }, "short");
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
            StopTaskbarFlash();
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
    /// Hand the batch to the host and take the question toast down again: the
    /// only thing shown after submitting is the model's own first line, which
    /// the host sends as the "spoken" status.
    /// </summary>
    static void Submit(QuestionFlow flow)
    {
        flow.Submitted = true;
        StopTaskbarFlash();

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

        RemoveToast(flow.QuestionTag, QuestionGroup);
        Log("answer submitted: " + flow.Id);
        // An approval flow stays registered until the host confirms that the
        // browser half applied the choice to DSH's own approval panel; a
        // `resolved` status then retires it, and a failed apply shows `manual`.
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
}
