namespace DshToastQuestion;

/// <summary>
/// Resident toast helper for dsh-notify-win. This process is the ONLY
/// notification implementation: non-interactive toasts, interactive questions,
/// toast identity registration, click-to-focus and the taskbar flash all live
/// here. The plugin requires the .NET 10 Desktop Runtime.
///
/// The host plugin starts ONE of these when the plugin is applied and keeps it
/// alive for the whole plugin lifetime. They speak newline-delimited JSON over
/// the child's stdin/stdout:
///
///   host -> helper  { "op": "notify" | "question" | "status" | "shutdown" | "ping", ... }
///   helper -> host  { "ev": "ready" | "answer" | "cancel" | "pong", ... }
///
/// Lifecycle follows the host by construction: when DSH exits (the service
/// terminates managed children, and the stdio pipes close) stdin reaches EOF
/// and this process exits. The plugin also sends an explicit "shutdown" when it
/// is disabled, so the helper disappears without leaving a stray process.
/// </summary>

static partial class Program
{
    static string GetArg(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        }
        return "";
    }

    static bool HasFlag(string[] args, string name)
    {
        foreach (var arg in args)
        {
            if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    [STAThread]
    static async Task<int> Main(string[] args)
    {
        // Quick liveness probe: exit 0 if the .NET Desktop Runtime can load
        // this assembly. The host plugin uses it before spawning --serve.
        if (string.Equals(GetArg(args, "--check"), "1", StringComparison.OrdinalIgnoreCase))
        {
            return 0;
        }

        // Toast click / dsh-notify:// activation: focus an existing DSH window,
        // or launch the installed PWA when DSH is not running. No script host.
        if (HasFlag(args, "--focus"))
        {
            FocusDsh();
            return 0;
        }

        if (!HasFlag(args, "--serve"))
        {
            // No supported mode: fail fast instead of waiting on a stdin that
            // nobody owns.
            await Task.Delay(200);
            return 2;
        }

        _logPath = GetArg(args, "--log");

        // Tag names only need to be unique within one Windows toast source.
        // Seeding from the pid keeps two helper instances (a hot-reload overlap)
        // from replacing each other's toast.
        _tagSeq = Environment.ProcessId % 100000 * 10;
        _notifyTagSeq = _tagSeq;

        // One-time (idempotent) OS setup. Both are best-effort: a locked Start
        // Menu shortcut must never stop notifications or the protocol handler.
        try { EnsureToastIdentity(); } catch (Exception error) { Log("identity registration failed: " + error.Message); }
        try { EnsureDshProtocol(); } catch (Exception error) { Log("protocol registration failed: " + error.Message); }

        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))
        {
            AutoFlush = true,
        };
        _out = stdout;

        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

        Send(new Dictionary<string, object?>
        {
            ["ev"] = "ready",
            ["pid"] = Environment.ProcessId,
        });
        Log("helper ready");

        try
        {
            string? line;
            while (!_stopping && (line = await stdin.ReadLineAsync()) != null)
            {
                if (line.Length == 0) continue;
                try
                {
                    Handle(line);
                }
                catch (Exception error)
                {
                    Log("command failed: " + error.Message);
                }
            }
        }
        catch (Exception error)
        {
            Log("stdin failed: " + error.Message);
        }

        // The host is gone (EOF) or asked us to stop: clear live toasts and
        // make sure the shell is not left flashing for a notification nobody
        // owns anymore.
        CleanupToasts();
        Log("helper exit");
        return 0;
    }

    static void Handle(string line)
    {
        var message = JsonSerializer.Deserialize<InboundMessage>(line, JsonOptions);
        if (message?.Op == null) return;

        switch (message.Op)
        {
            case "notify":
                ShowNotification(message);
                break;
            case "question":
                StartFlow(message);
                break;
            case "status":
                ApplyStatus(message);
                break;
            case "shutdown":
                _stopping = true;
                break;
            case "ping":
                Send(new Dictionary<string, object?> { ["ev"] = "pong" });
                break;
            default:
                Log("unknown op: " + message.Op);
                break;
        }
    }
}
