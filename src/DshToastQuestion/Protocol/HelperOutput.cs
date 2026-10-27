namespace DshToastQuestion;

static partial class Program
{
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

    static string XmlEscape(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
}
