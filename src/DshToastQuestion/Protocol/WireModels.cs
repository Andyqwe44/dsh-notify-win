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
        public string? Kind { get; set; }
        public string? SessionId { get; set; }
        public string? Title { get; set; }
        public string? Body { get; set; }
        public string? Launch { get; set; }
        public List<QuestionData>? Questions { get; set; }
        public string? Duration { get; set; }
        public string? State { get; set; }
        public string? Detail { get; set; }
        public string? Reason { get; set; }
        public string? Code { get; set; }
        public int? Retry { get; set; }
        public int? RetryMax { get; set; }
    }

}
