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

        // Set before --focus too: a cold toast click needs the same diagnostics.
        _logPath = GetArg(args, "--log");

        // Screen coordinates below are physical: the tray rect comes from the
        // shell in physical pixels, so the helper must not scale them again.
        EnablePhysicalPixels();

        // Self-test for the tray badge: paints the dot over DSH's own tray icon
        // for a few seconds regardless of focus, so the placement can be
        // eyeballed. Diagnostics only; the host never passes this flag.
        var badgeTest = GetArg(args, "--tray-badge-test");
        if (badgeTest.Length > 0)
        {
            _overlayIgnoreFocus = true;
            if (!StartTrayBadge("tray-badge-test", 600, 5))
            {
                Log("tray badge test: DSH tray icon not found");
                return 2;
            }
            var seconds = int.TryParse(badgeTest, out var parsed) ? Math.Clamp(parsed, 1, 30) : 5;
            Thread.Sleep(seconds * 1000);
            StopTrayBadge();
            Thread.Sleep(400);
            Log("tray badge test done");
            return 0;
        }

        // The DSH desktop host starts this helper from a Node-mode Electron
        // process, so ELECTRON_RUN_AS_NODE is inherited. Shell-launching
        // "DeepSeek Harness.exe" with that variable still set starts it as plain
        // Node instead of the desktop app: it dies with MODULE_NOT_FOUND and the
        // dsh://open activation never reaches the running window. Drop it for the
        // whole process so every child we start is a real desktop launch.
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null);

        // Toast click / dsh-notify:// activation: focus an existing DSH window,
        // or launch the installed PWA when DSH is not running. No script host.
        if (HasFlag(args, "--focus"))
        {
            FocusDsh();
            return 0;
        }

        if (!HasFlag(args, "--serve"))
        {
            // A toast body click (or the Start Menu shortcut) can start this exe
            // without arguments. That is the focus request; there is no other
            // supported argument-less mode.
            FocusDsh();
            return 0;
        }

        // Tag names only need to be unique within one Windows toast source.
        // Seeding from the pid keeps two helper instances (a hot-reload overlap)
        // from replacing each other's toast.
        _tagSeq = Environment.ProcessId % 100000 * 10;
        _notifyTagSeq = _tagSeq;

        // One-time (idempotent) OS setup. Both are best-effort: a locked Start
        // Menu shortcut must never stop notifications or the protocol handler.
        try { EnsureToastIdentity(); } catch (Exception error) { Log("identity registration failed: " + error.Message); }
        try { EnsureDshProtocol(); } catch (Exception error) { Log("protocol registration failed: " + error.Message); }
        // A helper killed mid-blink would leave its red dot on DSH's taskbar
        // button; clear it once, best-effort, before anything new is armed.
        try { ClearStaleTaskbarBadge(); } catch (Exception error) { Log("badge reset failed: " + error.Message); }

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
            // Per-event attention: no toast, only the configured effects.
            case "attention":
                StartAttention(message.Effects, message.Kind ?? "");
                break;
            // Badge blink timing from the plugin settings.
            case "config":
                ApplyAttentionConfig(message);
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
