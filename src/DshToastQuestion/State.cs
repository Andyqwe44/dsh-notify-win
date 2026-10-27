namespace DshToastQuestion;

static partial class Program
{
    const string Aumid = "DeepSeekHarness";
    const string QuestionGroup = "dsh-notify-q";
    const string AnswerGroup = "dsh-notify-a";
    const string NotifyGroup = "dsh-notify-n";
    const string BrandName = "DeepSeek Harness";
    const string ShortcutFileName = "DeepSeek Harness Notify.lnk";
    const string ProtocolName = "dsh-notify";
    const string PowerShellToastIdentity = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
    static readonly string[] ToastIdentities = { Aumid, PowerShellToastIdentity };

    static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    static readonly object WriteLock = new();
    static readonly object FlowsLock = new();
    static readonly Dictionary<string, QuestionFlow> Flows = new();
    static readonly HashSet<string> LiveToasts = new();
    static readonly Queue<string> TrackOrder = new();

    static StreamWriter? _out;
    static string? _logPath;
    static volatile bool _stopping;
    static int _tagSeq;
    static int _notifyTagSeq;
    static NotifyIcon? _balloon;

    // Taskbar flash policy (the only implementation left). FLASHW_TRAY |
    // FLASHW_TIMERNOFG arms a shell flash that ends when the DSH window comes
    // to the foreground. A small watcher also sends FLASHW_STOP as soon as DSH
    // is actually in front, because Explorer reacts on its next flash tick
    // (and can miss the target if another DSH window was activated). There is
    // deliberately no re-pulse timer; a periodic one had no stop condition of
    // its own and kept flashing after a toast was answered or after DSH was
    // already back in front.
    const uint FlashTray = 0x2;
    const uint FlashTimerNoForeground = 0xC;
    const uint FlashStop = 0x0;

    // Foreground watcher: EVENT_SYSTEM_FOREGROUND delivered out of context so
    // the helper can stop the flash as soon as a DSH window is activated.
    const uint EventSystemForeground = 0x0003;
    const uint WineventOutOfContext = 0x0000;
}
