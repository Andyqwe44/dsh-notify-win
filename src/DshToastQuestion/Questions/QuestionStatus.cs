namespace DshToastQuestion;

static partial class Program
{
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
            // The question was settled outside the toast (answered in the DSH
            // card, or the tool returned an error). There is no toast answer to
            // report: retire the toast and stop the attention flash now instead
            // of waiting for the toast to expire on its own.
            case "resolved":
                // An answered approval still needs this status: the host sends
                // it once the browser half has applied the choice to DSH's own
                // approval panel, so an already-submitted flow must be retired.
                if (flow.Submitted)
                {
                    FinishFlow(flow);
                    break;
                }
                flow.Submitted = true;
                StopTaskbarFlash();
                RemoveToast(flow.QuestionTag, QuestionGroup);
                FinishFlow(flow);
                break;
            // Exactly one receipt is shown — the model's own first line, on its
            // own. There is no pending, "delivered" or invented fallback toast.
            case "spoken":
                ShowStatus(flow, new[] { detail ?? "" }, "long");
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
                // A late answer from an old toast must not revive a settled
                // flow or keep its attention flash alive.
                if (flow.Submitted) break;
                flow.Submitted = true;
                StopTaskbarFlash();
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
            // A status/receipt toast is informational, but clicking it should
            // still open DSH like any other notification toast.
            sb.Append("<toast launch=\"--focus\" duration=\"").Append(durationAttr).Append("\"><visual><binding template=\"ToastGeneric\">");
            foreach (var line in lines)
            {
                if (line.Length == 0) continue;
                // One line per text element: the receipt line is already cut to
                // the toast width, and this keeps an over-wide line from wrapping
                // into a second row instead of being clipped.
                sb.Append("<text hint-maxLines=\"1\">").Append(XmlEscape(line)).Append("</text>");
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
            toast.Activated += (sender, eventArgs) =>
            {
                StopTaskbarFlash();
                FocusDsh();
            };
            if (!ShowToast(toast)) Log("status toast failed");
        }
        catch (Exception error)
        {
            Log("status toast failed: " + error.Message);
        }
    }
}
