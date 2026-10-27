namespace DshToastQuestion;

static partial class Program
{
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
}
