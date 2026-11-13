namespace DshToastQuestion;

static partial class Program
{
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

        /// <summary>A fixed-choice question (approval): no free-text override.</summary>
        [JsonPropertyName("noCustom")]
        public bool NoCustom { get; set; }

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

    /// <summary>
    /// What the helper should do once an event fires or its toast expires.
    /// The host owns the policy; the helper only executes it.
    /// </summary>
    sealed class EffectPolicy
    {
        /// <summary>
        /// Whether this event's toast should be shown. Only the receipt uses it:
        /// the host already decides for done/compact/alert/notice, and the
        /// question/approval card is never suppressed.
        /// </summary>
        public bool Toast { get; set; } = true;

        /// <summary>QQ-style tray-icon blink.</summary>
        public bool Blink { get; set; }

        /// <summary>Taskbar warm pulse (FlashWindowEx).</summary>
        public bool Flash { get; set; }

        /// <summary>"after-timeout" (default) or "immediate".</summary>
        public string? Timing { get; set; }
    }

    /// <summary>One inbound command. Unknown members are ignored on purpose.</summary>
    sealed class InboundMessage
    {
        public string? Op { get; set; }
        public string? Id { get; set; }
        public string? Kind { get; set; }
        public string? SessionId { get; set; }
        public string? Title { get; set; }
        public string? Body { get; set; }
        public string? Launch { get; set; }
        public List<QuestionData>? Questions { get; set; }
        public string? Duration { get; set; }
        /// <summary>True when this question flow answers an approval request.</summary>
        public bool Approval { get; set; }
        public string? State { get; set; }
        public string? Detail { get; set; }
        public string? Reason { get; set; }
        public string? Code { get; set; }
        public int? Retry { get; set; }
        public int? RetryMax { get; set; }
        /// <summary>Effects the host attached to this event/toast.</summary>
        public EffectPolicy? Effects { get; set; }

        // `config` op: how the notification tray icon behaves.
        public string? TrayIcon { get; set; }
        public int? BlinkIntervalMs { get; set; }
        public int? BlinkMaxMinutes { get; set; }
    }

}
